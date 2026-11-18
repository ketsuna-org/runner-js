import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** Une connexion WebSocket ouverte, isolée derrière une interface pour que le gestionnaire se teste avec un faux serveur. */
export interface WsConnection {
  /** Un seul abonné : texte (`string`) ou binaire (`Uint8Array`). */
  onMessage(handler: (data: string | Uint8Array) => void): void;
  /** Appelé une fois à la fermeture ; `error` si la connexion est tombée sans trame de fermeture. */
  onClose(handler: (info: { code: number | null; reason: string; error: boolean }) => void): void;
  send(text: string): void;
  sendBinary(bytes: Uint8Array): void;
  close(code?: number, reason?: string): Promise<void>;
}

/** L'upgrade HTTP a été refusé, ou l'adresse refusée par la protection SSRF. */
export class WsHandshakeException extends Error {
  constructor(
    readonly status: number,
    readonly detail = '',
  ) {
    super(`WsHandshakeException(${status} ${detail})`);
    this.name = 'WsHandshakeException';
  }
  get isAuthRefusal(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export class WsAddressRefused extends Error {
  constructor(detail = '') {
    super(`address refused${detail ? `: ${detail}` : ''}`);
    this.name = 'WsAddressRefused';
  }
}

export class WsConnectTimeout extends Error {
  constructor() {
    super('connect timeout');
    this.name = 'WsConnectTimeout';
  }
}

export interface WsConnectOptions {
  /** Filtre SSRF actif (hébergé) : la résolution est vérifiée avant la connexion. */
  guard: boolean;
  pingIntervalSeconds: number;
}

export type WsConnector = (
  url: URL,
  headers: Record<string, string>,
  options: WsConnectOptions,
) => Promise<WsConnection>;

/** Adresse privée, locale, de liaison ou réservée : jamais une cible légitime pour un bot hébergé. */
export function isForbiddenAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) {
    const [a, b] = address.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (kind === 6) {
    const lower = address.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isForbiddenAddress(mapped[1]);
    return /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith('ff');
  }
  return true;
}

/**
 * Vérifie que l'hôte ne résout QUE vers des adresses publiques. Bun ne permet pas d'épingler l'adresse
 * de la connexion : la résolution est refaite à chaque ouverture, la fenêtre entre la vérification et la
 * connexion reste celle d'un DNS rebinding à très court TTL (voir docs/websocket-sources.md).
 */
export async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (isForbiddenAddress(host)) throw new WsAddressRefused(host);
    return;
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new WsHandshakeException(0, 'dns');
  }
  if (addresses.length === 0 || addresses.some((a) => isForbiddenAddress(a.address))) {
    throw new WsAddressRefused(host);
  }
}

const CONNECT_TIMEOUT_MS = 15000;

/** Connecteur réel : WebSocket natif de Bun, sans redirection, avec en-têtes. */
export const connectWebSocket: WsConnector = async (url, headers, options) => {
  if (url.protocol !== 'wss:') throw new WsAddressRefused('scheme');
  if (options.guard) await assertPublicHost(url.hostname);
  return await new Promise<WsConnection>((resolve, reject) => {
    // Bun accepte `headers` en second paramètre (extension du constructeur).
    const socket = new (WebSocket as unknown as new (u: string, o: unknown) => WebSocket)(url.toString(), {
      headers,
    });
    socket.binaryType = 'arraybuffer';
    let opened = false;
    let messageHandler: ((data: string | Uint8Array) => void) | null = null;
    let closeHandler: ((info: { code: number | null; reason: string; error: boolean }) => void) | null = null;
    let sawError = false;
    let errorText = '';
    const pending: Array<string | Uint8Array> = [];
    let closedInfo: { code: number | null; reason: string; error: boolean } | null = null;
    const timer = setTimeout(() => {
      try {
        socket.close();
      } catch {
        /* déjà fermée */
      }
      reject(new WsConnectTimeout());
    }, CONNECT_TIMEOUT_MS);

    const connection: WsConnection = {
      onMessage(handler) {
        messageHandler = handler;
        for (const data of pending.splice(0)) handler(data);
      },
      onClose(handler) {
        closeHandler = handler;
        if (closedInfo) handler(closedInfo);
      },
      send: (text) => socket.send(text),
      sendBinary: (bytes) => socket.send(bytes),
      close: async (code = 1000, reason = '') => {
        try {
          socket.close(code, reason);
        } catch {
          /* déjà fermée */
        }
      },
    };

    socket.addEventListener('open', () => {
      opened = true;
      clearTimeout(timer);
      resolve(connection);
    });
    socket.addEventListener('message', (event) => {
      const raw = (event as MessageEvent).data as unknown;
      const data = typeof raw === 'string' ? raw : new Uint8Array(raw as ArrayBuffer);
      if (messageHandler) messageHandler(data);
      else pending.push(data);
    });
    socket.addEventListener('error', (event) => {
      sawError = true;
      errorText = String((event as { message?: unknown }).message ?? '');
    });
    socket.addEventListener('close', (event) => {
      const info = {
        code: typeof event.code === 'number' ? event.code : null,
        reason: event.reason ?? '',
        error: sawError && !opened,
      };
      if (!opened) {
        clearTimeout(timer);
        // Bun n'expose pas le statut HTTP : on le lit dans le message d'erreur quand il y figure.
        const match = errorText.match(/\b(\d{3})\b/);
        reject(new WsHandshakeException(match ? Number(match[1]) : 0, errorText));
        return;
      }
      closedInfo = { code: info.code, reason: info.reason, error: sawError };
      closeHandler?.(closedInfo);
    });
    void options.pingIntervalSeconds; // le ping de protocole est géré par Bun (fermeture sur silence prolongé).
  });
};
