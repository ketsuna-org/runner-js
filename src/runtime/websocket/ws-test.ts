/**
 * « Tester la connexion » : ouvre une connexion jetable vers la source, joue la séquence de join, regarde
 * les premiers messages puis ferme proprement. Rien n'est conservé (ni le contenu, ni l'état), les secrets
 * sont masqués dans le journal rendu. Mêmes bornes que la route du Manager : 20 s, 20 messages.
 */
import { parseWebSocketSource, wsResolve, type WebSocketSourceConfig } from './ws-source.js';
import { WsException } from './ws-support.js';
import {
  WsAddressRefused,
  WsConnectTimeout,
  WsHandshakeException,
  connectWebSocket,
  type WsConnection,
  type WsConnector,
} from './ws-transport.js';

export const WS_TEST_MAX_MS = 20_000;
export const WS_TEST_MAX_MESSAGES = 20;
const SHOWN_CHARS = 500;
const MASK = '••••';

export interface WsTestEvent {
  /** Millisecondes depuis le début du test. */
  atMs: number;
  kind: 'info' | 'out' | 'in' | 'ok' | 'error';
  text: string;
}

export interface WsTestResult {
  ok: boolean;
  /** Code `ws_*` quand le test échoue, vide sinon. */
  error: string;
  events: WsTestEvent[];
  received: number;
}

export interface WsTestOptions {
  connector?: WsConnector;
  ssrfGuard?: boolean;
  totalMs?: number;
  maxMessages?: number;
  context?: string;
  clock?: () => number;
}

function failureCode(error: unknown): string {
  if (error instanceof WsException) return error.code;
  if (error instanceof WsHandshakeException) return error.isAuthRefusal ? 'ws_auth_refused' : 'ws_handshake_failed';
  if (error instanceof WsAddressRefused) return 'ws_address_refused';
  if (error instanceof WsConnectTimeout) return 'ws_connect_timeout';
  return 'ws_connect_failed';
}

function mask(cfg: WebSocketSourceConfig, text: string): string {
  let out = text;
  for (const value of Object.values(cfg.secrets)) {
    if (value.length >= 3) out = out.split(value).join(MASK);
  }
  return out.length > SHOWN_CHARS ? `${out.slice(0, SHOWN_CHARS)}…` : out;
}

export async function runWebSocketTest(raw: unknown, options: WsTestOptions = {}): Promise<WsTestResult> {
  const clock = options.clock ?? Date.now;
  const start = clock();
  const events: WsTestEvent[] = [];
  const add = (kind: WsTestEvent['kind'], text: string) => events.push({ atMs: clock() - start, kind, text });
  const cfg = parseWebSocketSource(raw);
  if (!cfg) {
    add('error', 'ws_unknown_source');
    return { ok: false, error: 'ws_unknown_source', events, received: 0 };
  }
  const totalMs = options.totalMs ?? WS_TEST_MAX_MS;
  const maxMessages = options.maxMessages ?? WS_TEST_MAX_MESSAGES;
  const context = options.context ?? '';
  const connector = options.connector ?? connectWebSocket;
  let conn: WsConnection | null = null;
  let received = 0;
  let waitFor = '';
  let waiter: (() => void) | null = null;
  let finish: (() => void) | null = null;
  let closedByPeer = false;
  let closing = false;
  try {
    const url = new URL(wsResolve(cfg, cfg.url));
    add('info', `${url.protocol}//${url.host}`);
    const headers: Record<string, string> = {};
    for (const h of cfg.headers) headers[h.name] = wsResolve(cfg, h.value);
    conn = await connector(url, headers, { guard: options.ssrfGuard ?? false, pingIntervalSeconds: cfg.heartbeatIntervalSeconds });
    add('ok', 'open');
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    conn.onMessage((data) => {
      if (typeof data !== 'string') {
        add('in', `[binary ${data.byteLength} bytes]`);
        return;
      }
      if (received >= maxMessages) return;
      received++;
      add('in', mask(cfg, data));
      if (waitFor && data.includes(waitFor)) waiter?.();
      if (received >= maxMessages) finish?.();
    });
    conn.onClose((info) => {
      if (closing) return;
      closedByPeer = true;
      add('info', `closed by the service (${info.code ?? 'no code'}${info.reason ? ` ${info.reason}` : ''})`);
      waiter?.();
      finish?.();
    });
    const deadline = start + totalMs;
    for (const step of cfg.joinSequence) {
      if (closedByPeer) throw new WsException('ws_join_refused');
      conn.send(wsResolve(cfg, step.send, context));
      add('out', mask(cfg, wsResolve({ ...cfg, secrets: Object.fromEntries(Object.keys(cfg.secrets).map((k) => [k, MASK])) }, step.send, context)));
      if (step.waitFor) {
        waitFor = step.waitFor;
        const left = Math.max(0, Math.min(step.timeoutMs, deadline - clock()));
        let timer: ReturnType<typeof setTimeout> | undefined;
        const arrived = await new Promise<boolean>((resolve) => {
          waiter = () => resolve(true);
          timer = setTimeout(() => resolve(false), left);
        });
        clearTimeout(timer);
        waiter = null;
        waitFor = '';
        if (!arrived) throw new WsException(closedByPeer ? 'ws_join_refused' : 'ws_join_timeout');
        add('ok', 'expected answer received');
      }
    }
    if (cfg.joinSequence.length > 0) add('ok', 'join sequence done');
    if (!closedByPeer) {
      const left = Math.max(0, deadline - clock());
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        done,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, left);
        }),
      ]);
      clearTimeout(timer);
    }
    if (!closedByPeer) {
      closing = true;
      await conn.close(1000, 'test');
      add('info', `closed cleanly (1000), ${received} message${received === 1 ? '' : 's'} seen`);
    }
    return { ok: true, error: '', events, received };
  } catch (error) {
    const code = failureCode(error);
    add('error', code);
    try {
      closing = true;
      await conn?.close(1000, 'test failed');
    } catch {
      /* déjà fermée */
    }
    return { ok: false, error: code, events, received };
  }
}
