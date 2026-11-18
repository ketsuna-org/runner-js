/**
 * Sources WebSocket d'un bot (`webSocketSources`, voir DESIGN-websocket.md). Le Manager a déjà validé la
 * forme ; le runner relit avec tolérance (valeurs bornées, entrée illisible ignorée, jamais d'exception).
 * Port fidèle de `packages/shared/lib/services/websocket/ws_source.dart` : mêmes bornes, mêmes règles.
 */

export interface WsFilter {
  kind: 'contains' | 'json';
  text: string;
  path: string;
  equals: string;
}

export interface WsJoinStep {
  send: string;
  waitFor: string;
  timeoutMs: number;
}

export interface WebSocketSourceConfig {
  id: string;
  name: string;
  url: string;
  workflowName: string;
  /** Script JavaScript du workflow, projeté par le Manager ; vide = la source n'a pas de workflow. */
  script: string;
  headers: Array<{ name: string; value: string }>;
  secrets: Record<string, string>;
  joinSequence: WsJoinStep[];
  heartbeatIntervalSeconds: number;
  heartbeatMessage: string;
  heartbeatEveryMs: number;
  onDemand: boolean;
  filter: WsFilter | null;
  maxMessagesPerMinute: number;
  maxMessageBytes: number;
  idleCloseMinutes: number;
  maxLifetimeMinutes: number;
  acceptsBinary: boolean;
  enabled: boolean;
}

const SECRET_REF = /\{\{\s*secret\.([A-Za-z][A-Za-z0-9_]{0,31})\s*\}\}/g;
const CTX_REF = /\{\{\s*ctx\s*\}\}/g;

function bounded(raw: unknown, fallback: number, min: number, max: number): number {
  const n = typeof raw === 'number' ? Math.trunc(raw) : Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return n < min ? min : n > max ? max : n;
}

function str(raw: unknown): string {
  return raw == null ? '' : String(raw);
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw);
}

function parseFilter(raw: unknown): WsFilter | null {
  if (!isRecord(raw)) return null;
  const kind = str(raw.kind).toLowerCase();
  if (kind === 'contains') {
    const text = str(raw.text);
    return text ? { kind: 'contains', text, path: '', equals: '' } : null;
  }
  if (kind === 'json') {
    const path = str(raw.path).trim();
    return path ? { kind: 'json', text: '', path, equals: str(raw.equals) } : null;
  }
  return null;
}

/** JSON du message, ou `undefined` s'il n'en est pas. */
export function wsDecodeJson(message: string): unknown {
  const trimmed = message.trimStart();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return undefined;
  try {
    return JSON.parse(message);
  } catch {
    return undefined;
  }
}

/** Chemin pointé (`data.items[0].price` ou `data.items.0.price`) ; `undefined` si absent. */
export function wsJsonPath(root: unknown, path: string): unknown {
  let current: unknown = root;
  const segments = path
    .replaceAll('[', '.')
    .replaceAll(']', '')
    .split('.')
    .filter((s) => s.length > 0);
  for (const segment of segments) {
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return undefined;
      const index = Number(segment);
      if (index >= current.length) return undefined;
      current = current[index];
    } else if (isRecord(current)) {
      if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

export function wsScalarText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

export function wsFilterMatches(filter: WsFilter, message: string): boolean {
  if (filter.kind === 'contains') return message.includes(filter.text);
  const decoded = wsDecodeJson(message);
  if (decoded === undefined) return false;
  const value = wsJsonPath(decoded, filter.path);
  if (value === undefined || value === null) return false;
  return wsScalarText(value) === filter.equals;
}

export function parseWebSocketSource(raw: unknown): WebSocketSourceConfig | null {
  if (!isRecord(raw)) return null;
  const limits = isRecord(raw.limits) ? raw.limits : {};
  const heartbeat = isRecord(raw.heartbeat) ? raw.heartbeat : {};
  const name = str(raw.name);
  const url = str(raw.url);
  if (!name || !url) return null;
  const secrets: Record<string, string> = {};
  if (isRecord(raw.secrets)) {
    for (const [key, value] of Object.entries(raw.secrets)) secrets[key] = str(value);
  }
  return {
    id: str(raw.id),
    name,
    url,
    workflowName: str(raw.workflowName),
    script: str(raw.script),
    headers: (Array.isArray(raw.headers) ? raw.headers : []).flatMap((h) =>
      isRecord(h) && str(h.name) ? [{ name: str(h.name), value: str(h.value) }] : [],
    ),
    secrets,
    joinSequence: (Array.isArray(raw.joinSequence) ? raw.joinSequence : []).flatMap((s) =>
      isRecord(s)
        ? [{ send: str(s.send), waitFor: str(s.waitFor), timeoutMs: bounded(s.timeoutMs, 5000, 500, 10000) }]
        : [],
    ),
    heartbeatIntervalSeconds: bounded(heartbeat.intervalSeconds, 30, 5, 300),
    heartbeatMessage: str(heartbeat.message),
    heartbeatEveryMs: bounded(heartbeat.everyMs, 30000, 5000, 300000),
    onDemand: str(raw.mode) === 'on_demand',
    filter: parseFilter(raw.filter),
    maxMessagesPerMinute: bounded(limits.maxMessagesPerMinute, 60, 1, 600),
    maxMessageBytes: bounded(limits.maxMessageBytes, 256 * 1024, 1024, 1 << 20),
    idleCloseMinutes: bounded(limits.idleCloseMinutes, 10, 1, 60),
    maxLifetimeMinutes: bounded(limits.maxLifetimeMinutes, 60, 1, 360),
    acceptsBinary: raw.acceptsBinary === true,
    enabled: raw.enabled !== false,
  };
}

/** Lit `webSocketSources` d'une configuration de bot (entrées illisibles ignorées). */
export function parseWebSocketSources(raw: unknown): WebSocketSourceConfig[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const parsed = parseWebSocketSource(item);
    return parsed ? [parsed] : [];
  });
}

/** Remplace `{{secret.NOM}}` (et `{{ctx}}` quand [context] est donné). Un secret inconnu reste vide. */
export function wsResolve(source: WebSocketSourceConfig, text: string, context?: string): string {
  let out = text.replace(SECRET_REF, (_m, key: string) => source.secrets[key] ?? '');
  if (context !== undefined) out = out.replace(CTX_REF, () => context);
  return out;
}

/** Même configuration (ce qui décide d'une reconnexion quand la config change). */
export function wsSameSource(a: WebSocketSourceConfig, b: WebSocketSourceConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Pour les scripts et le stockage : jamais de secret, jamais d'en-tête résolu. */
export function wsRedactSource(source: Record<string, unknown>): Record<string, unknown> {
  const { secrets: _secrets, ...rest } = source;
  return { ...rest, secrets: {} };
}
