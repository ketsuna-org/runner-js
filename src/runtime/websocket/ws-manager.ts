import {
  type WebSocketSourceConfig,
  wsFilterMatches,
  wsResolve,
  wsSameSource,
} from './ws-source.js';
import {
  type WebSocketBridge,
  WsException,
  WsTokenBucket,
  wsReconnectDelay,
} from './ws-support.js';
import {
  type WsConnection,
  type WsConnector,
  WsAddressRefused,
  WsConnectTimeout,
  WsHandshakeException,
  connectWebSocket,
} from './ws-transport.js';

/** Ce que le workflow de la source reçoit : `open`, `message`, `close` ou `error`. */
export interface WsEvent {
  source: string;
  event: 'open' | 'message' | 'close' | 'error';
  message: string;
  closeCode: number | null;
  closeReason: string;
  error: string;
  reconnected: boolean;
  gapMs: number;
  context: string;
}

export type WsEventHandler = (source: WebSocketSourceConfig, event: WsEvent) => Promise<void>;
export type WsState = 'closed' | 'connecting' | 'open' | 'error';

/** Plafonds (DESIGN-websocket.md §8), identiques côté Dart. */
export const WS_MAX_OPEN_PER_BOT = 3;
export const WS_MAX_OPEN_PER_RUNNER = 500;
export const WS_QUEUE_LIMIT = 50;
export const WS_SENDS_PER_MINUTE = 60;
export const WS_MAX_CONTEXT_CHARS = 200;
export const WS_AUTH_FAILURES_BEFORE_STOP = 3;
export const WS_TRANSIENT_FAILURES_BEFORE_STOP = 12;

function newEvent(source: string, event: WsEvent['event'], extra: Partial<WsEvent> = {}): WsEvent {
  return {
    source,
    event,
    message: '',
    closeCode: null,
    closeReason: '',
    error: '',
    reconnected: false,
    gapMs: 0,
    context: '',
    ...extra,
  };
}

interface SourceState {
  cfg: WebSocketSourceConfig;
  state: WsState;
  conn: WsConnection | null;
  opening: Promise<void> | null;
  wanted: boolean;
  reserved: boolean;
  joining: boolean;
  attempts: number;
  authFailures: number;
  everOpened: boolean;
  closedAt: number | null;
  openedAt: number | null;
  lastMessageAt: number | null;
  lastError: string;
  context: string;
  inBucket: WsTokenBucket;
  outBucket: WsTokenBucket;
  queue: WsEvent[];
  draining: boolean;
  received: number;
  processed: number;
  droppedFilter: number;
  droppedRate: number;
  droppedQueue: number;
  droppedBinary: number;
  reconnects: number;
  windowStart: number;
  windowDrops: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  appHeartbeat: ReturnType<typeof setInterval> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  lifetimeTimer: ReturnType<typeof setTimeout> | null;
  joinWaiter: { resolve: () => void; reject: (e: Error) => void; done: boolean } | null;
  joinWaitFor: string;
}

export interface WebSocketSourceManagerOptions {
  botId: string;
  onEvent: WsEventHandler;
  connector?: WsConnector;
  /** Filtre SSRF actif (nœud hébergé). */
  ssrfGuard?: boolean;
  log?: (message: string) => void;
  clock?: () => number;
  /** Durée d'« une minute » des limites (tests : quelques millisecondes). */
  minuteMs?: number;
  reconnectDelay?: (attempt: number) => number;
  maxOpen?: number;
}

/**
 * Tient les connexions WebSocket d'UN bot : ouverture, séquence de join, battement, reconnexion, limites,
 * file d'événements vers le workflow. Port de `WebSocketSourceManager` (Dart), mêmes règles.
 */
export class WebSocketSourceManager implements WebSocketBridge {
  /** Connexions comptées pour tout le processus (protège le nœud). */
  static runnerOpenCount = 0;

  readonly botId: string;
  private readonly sources = new Map<string, SourceState>();
  private readonly onEvent: WsEventHandler;
  private readonly connector: WsConnector;
  private readonly ssrfGuard: boolean;
  private readonly log?: (message: string) => void;
  private readonly clock: () => number;
  private readonly minuteMs: number;
  private readonly reconnectDelayFn?: (attempt: number) => number;
  private readonly maxOpen: number;
  private started = false;
  private stopping = false;

  constructor(options: WebSocketSourceManagerOptions) {
    this.botId = options.botId;
    this.onEvent = options.onEvent;
    this.connector = options.connector ?? connectWebSocket;
    this.ssrfGuard = options.ssrfGuard ?? false;
    this.log = options.log;
    this.clock = options.clock ?? Date.now;
    this.minuteMs = options.minuteMs ?? 60_000;
    this.reconnectDelayFn = options.reconnectDelay;
    this.maxOpen = options.maxOpen ?? WS_MAX_OPEN_PER_BOT;
  }

  // ---------------------------------------------------------------- configuration

  /** Réconcilie avec la liste de sources : retire ou ferme ce qui disparaît ou change, ajoute le reste. */
  updateSources(sources: WebSocketSourceConfig[]): void {
    const byName = new Map(sources.map((s) => [s.name, s]));
    for (const [name, existing] of [...this.sources]) {
      const next = byName.get(name);
      if (!next || !next.enabled || !wsSameSource(existing.cfg, next)) {
        this.dispose(existing);
        this.sources.delete(name);
      }
    }
    for (const next of sources) {
      if (!next.enabled || this.sources.has(next.name)) continue;
      const src = this.newSource(next);
      this.sources.set(next.name, src);
      if (this.started && !next.onDemand) this.wantAndOpen(src);
    }
  }

  private newSource(cfg: WebSocketSourceConfig): SourceState {
    return {
      cfg,
      state: 'closed',
      conn: null,
      opening: null,
      wanted: false,
      reserved: false,
      joining: false,
      attempts: 0,
      authFailures: 0,
      everOpened: false,
      closedAt: null,
      openedAt: null,
      lastMessageAt: null,
      lastError: '',
      context: '',
      inBucket: new WsTokenBucket(cfg.maxMessagesPerMinute, this.clock),
      outBucket: new WsTokenBucket(WS_SENDS_PER_MINUTE, this.clock),
      queue: [],
      draining: false,
      received: 0,
      processed: 0,
      droppedFilter: 0,
      droppedRate: 0,
      droppedQueue: 0,
      droppedBinary: 0,
      reconnects: 0,
      windowStart: 0,
      windowDrops: 0,
      reconnectTimer: null,
      appHeartbeat: null,
      idleTimer: null,
      lifetimeTimer: null,
      joinWaiter: null,
      joinWaitFor: '',
    };
  }

  get isStarted(): boolean {
    return this.started;
  }

  /** Ouvre les sources permanentes actives (au démarrage du bot), réparties sur quelques secondes. */
  startPermanent(): void {
    this.started = true;
    this.stopping = false;
    let i = 0;
    for (const src of this.sources.values()) {
      if (src.cfg.onDemand) continue;
      src.wanted = true;
      const spread = i++ * 300 + Math.floor(Math.random() * 200);
      src.reconnectTimer = setTimeout(() => {
        src.reconnectTimer = null;
        void this.openSafely(src);
      }, spread);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.started = false;
    for (const src of [...this.sources.values()]) {
      await this.closeConnection(src, 1001, 'going away');
      this.cancelTimers(src);
      src.state = 'closed';
      src.wanted = false;
    }
  }

  private dispose(src: SourceState): void {
    src.wanted = false;
    this.cancelTimers(src);
    void this.closeConnection(src, 1000, 'source changed');
    this.release(src);
    src.state = 'closed';
  }

  private cancelTimers(src: SourceState): void {
    if (src.reconnectTimer) clearTimeout(src.reconnectTimer);
    if (src.appHeartbeat) clearInterval(src.appHeartbeat);
    if (src.idleTimer) clearTimeout(src.idleTimer);
    if (src.lifetimeTimer) clearTimeout(src.lifetimeTimer);
    src.reconnectTimer = src.appHeartbeat = src.idleTimer = src.lifetimeTimer = null;
  }

  // ---------------------------------------------------------------- pont (scripts)

  async join(source: string, context = ''): Promise<void> {
    const src = this.require(source);
    src.context = context.length > WS_MAX_CONTEXT_CHARS ? context.slice(0, WS_MAX_CONTEXT_CHARS) : context;
    this.touch(src);
    if (src.state === 'open') return;
    if (src.state === 'error') {
      src.attempts = 0;
      src.authFailures = 0;
    }
    src.wanted = true;
    await this.open(src);
  }

  async send(source: string, message: string): Promise<void> {
    const src = this.require(source);
    const conn = src.conn;
    if (src.state !== 'open' || !conn) throw new WsException('ws_not_open');
    if (Buffer.byteLength(message, 'utf8') > src.cfg.maxMessageBytes) throw new WsException('ws_message_too_big');
    if (!src.outBucket.take()) throw new WsException('ws_send_rate');
    this.touch(src);
    conn.send(message);
  }

  /** Envoi binaire (flux vocal). Refusé sans `acceptsBinary`. */
  async sendBinary(source: string, bytes: Uint8Array): Promise<void> {
    const src = this.require(source);
    if (!src.cfg.acceptsBinary) throw new WsException('ws_binary_refused');
    const conn = src.conn;
    if (src.state !== 'open' || !conn) throw new WsException('ws_not_open');
    if (bytes.length > src.cfg.maxMessageBytes) throw new WsException('ws_message_too_big');
    this.touch(src);
    conn.sendBinary(bytes);
  }

  async close(source: string): Promise<void> {
    const src = this.require(source);
    src.wanted = false;
    this.cancelTimers(src);
    await this.closeConnection(src, 1000, 'closed by script');
    if (src.state !== 'error') src.state = 'closed';
  }

  status(source: string): string {
    return this.sources.get(source)?.state ?? 'closed';
  }

  private require(name: string): SourceState {
    const src = this.sources.get(name);
    if (!src) throw new WsException('ws_unknown_source', name);
    return src;
  }

  // ---------------------------------------------------------------- ouverture

  private async openSafely(src: SourceState): Promise<void> {
    try {
      await this.open(src);
    } catch {
      // Déjà journalisé, rangé dans lastError, reconnexion programmée.
    }
  }

  private wantAndOpen(src: SourceState): void {
    src.wanted = true;
    void this.openSafely(src);
  }

  private open(src: SourceState): Promise<void> {
    if (src.state === 'open') return Promise.resolve();
    if (src.opening) return src.opening;
    const promise = this.openOnce(src).finally(() => {
      src.opening = null;
    });
    src.opening = promise;
    return promise;
  }

  private async openOnce(src: SourceState): Promise<void> {
    if (!src.cfg.enabled) throw new WsException('ws_source_disabled');
    const openNow = [...this.sources.values()].filter((s) => s.reserved && s !== src).length;
    if (openNow >= this.maxOpen) throw new WsException('ws_too_many_open');
    if (WebSocketSourceManager.runnerOpenCount >= WS_MAX_OPEN_PER_RUNNER) throw new WsException('ws_runner_busy');
    this.reserve(src);
    src.state = 'connecting';
    const cfg = src.cfg;
    try {
      const headers: Record<string, string> = {};
      for (const h of cfg.headers) headers[h.name] = wsResolve(cfg, h.value);
      const conn = await this.connector(new URL(wsResolve(cfg, cfg.url)), headers, {
        guard: this.ssrfGuard,
        pingIntervalSeconds: cfg.heartbeatIntervalSeconds,
      });
      src.conn = conn;
      src.joining = true;
      conn.onMessage((data) => this.onData(src, conn, data));
      conn.onClose((info) => this.onDone(src, conn, info));
      for (const step of cfg.joinSequence) {
        const text = wsResolve(cfg, step.send, src.context);
        let wait: Promise<void> | null = null;
        if (step.waitFor) {
          src.joinWaitFor = step.waitFor;
          wait = new Promise<void>((resolve, reject) => {
            const waiter = {
              done: false,
              resolve: () => {
                waiter.done = true;
                clearTimeout(timer);
                resolve();
              },
              reject: (e: Error) => {
                waiter.done = true;
                clearTimeout(timer);
                reject(e);
              },
            };
            const timer = setTimeout(() => waiter.reject(new WsException('ws_join_timeout')), step.timeoutMs);
            src.joinWaiter = waiter;
          });
        }
        conn.send(text);
        if (wait) {
          try {
            await wait;
          } finally {
            src.joinWaiter = null;
            src.joinWaitFor = '';
          }
        }
        if (src.conn !== conn) throw new WsException('ws_join_refused');
      }
      src.joining = false;
      src.state = 'open';
      const now = this.clock();
      const reconnected = src.everOpened;
      const gap = src.closedAt === null ? 0 : now - src.closedAt;
      src.everOpened = true;
      src.openedAt = now;
      src.attempts = 0;
      src.authFailures = 0;
      src.lastError = '';
      if (reconnected) src.reconnects++;
      this.armTimers(src, conn);
      this.emit(src, newEvent(cfg.name, 'open', { reconnected, gapMs: gap, context: src.context }));
    } catch (error) {
      src.joining = false;
      const code = this.failureCode(error);
      await this.closeConnection(src, 1000, 'open failed');
      this.release(src);
      src.lastError = code;
      src.closedAt = this.clock();
      const auth = error instanceof WsHandshakeException && error.isAuthRefusal;
      if (auth) src.authFailures++;
      this.log?.(`[ws:${cfg.name}] open failed: ${code}`);
      if (src.wanted && !cfg.onDemand && !this.stopping) {
        this.scheduleReconnect(src, auth);
      } else {
        src.state = 'closed';
      }
      this.emit(src, newEvent(cfg.name, 'error', { error: code }));
      throw error instanceof WsException ? error : new WsException(code);
    }
  }

  private failureCode(error: unknown): string {
    if (error instanceof WsException) return error.code;
    if (error instanceof WsHandshakeException) return error.isAuthRefusal ? 'ws_auth_refused' : 'ws_handshake_failed';
    if (error instanceof WsAddressRefused) return 'ws_address_refused';
    if (error instanceof WsConnectTimeout) return 'ws_connect_timeout';
    return 'ws_connect_failed';
  }

  private reserve(src: SourceState): void {
    if (src.reserved) return;
    src.reserved = true;
    WebSocketSourceManager.runnerOpenCount++;
  }

  private release(src: SourceState): void {
    if (!src.reserved) return;
    src.reserved = false;
    if (WebSocketSourceManager.runnerOpenCount > 0) WebSocketSourceManager.runnerOpenCount--;
  }

  // ---------------------------------------------------------------- minuteurs

  private armTimers(src: SourceState, conn: WsConnection): void {
    const cfg = src.cfg;
    if (cfg.heartbeatMessage) {
      src.appHeartbeat = setInterval(() => {
        if (src.conn === conn && src.state === 'open') {
          conn.send(wsResolve(cfg, cfg.heartbeatMessage, src.context));
        }
      }, cfg.heartbeatEveryMs);
    }
    if (cfg.onDemand) {
      this.armIdle(src);
      src.lifetimeTimer = setTimeout(() => void this.autoClose(src, 'lifetime'), this.minuteMs * cfg.maxLifetimeMinutes);
    }
  }

  private armIdle(src: SourceState): void {
    if (!src.cfg.onDemand) return;
    if (src.idleTimer) clearTimeout(src.idleTimer);
    src.idleTimer = setTimeout(() => void this.autoClose(src, 'idle'), this.minuteMs * src.cfg.idleCloseMinutes);
  }

  /** L'inactivité ne se compte que sur les actions du bot (join, send), jamais sur les messages reçus. */
  private touch(src: SourceState): void {
    this.armIdle(src);
  }

  private async autoClose(src: SourceState, reason: string): Promise<void> {
    src.wanted = false;
    this.log?.(`[ws:${src.cfg.name}] closed: ${reason}`);
    await this.closeConnection(src, 1000, reason);
    if (src.state !== 'error') src.state = 'closed';
  }

  // ---------------------------------------------------------------- réception

  private onData(src: SourceState, conn: WsConnection, data: string | Uint8Array): void {
    if (src.conn !== conn) return;
    if (typeof data !== 'string') {
      src.droppedBinary++; // v1 : texte seulement.
      return;
    }
    const cfg = src.cfg;
    if (data.length > cfg.maxMessageBytes || (data.length * 3 > cfg.maxMessageBytes && Buffer.byteLength(data, 'utf8') > cfg.maxMessageBytes)) {
      void this.fail(src, 'ws_message_too_big', 1009);
      return;
    }
    if (src.joining) {
      const waiter = src.joinWaiter;
      if (waiter && !waiter.done && data.includes(src.joinWaitFor)) waiter.resolve();
      return;
    }
    src.received++;
    src.lastMessageAt = this.clock();
    if (cfg.filter && !wsFilterMatches(cfg.filter, data)) {
      src.droppedFilter++;
      return;
    }
    if (!src.inBucket.take()) {
      src.droppedRate++;
      this.noteDrop(src);
      return;
    }
    if (src.queue.length >= WS_QUEUE_LIMIT) {
      src.queue.shift();
      src.droppedQueue++;
    }
    src.queue.push(newEvent(cfg.name, 'message', { message: data, context: src.context }));
    void this.drain(src);
  }

  /** Une source qui nous inonde plus d'une minute ne se corrige pas seule : on la coupe. */
  private noteDrop(src: SourceState): void {
    const now = this.clock();
    if (now - src.windowStart > this.minuteMs) {
      src.windowStart = now;
      src.windowDrops = 0;
    }
    src.windowDrops++;
    if (src.windowDrops > src.cfg.maxMessagesPerMinute * 5) void this.fail(src, 'ws_rate_limit', 1008);
  }

  private async fail(src: SourceState, error: string, code: number): Promise<void> {
    src.lastError = error;
    src.wanted = false;
    this.cancelTimers(src);
    this.log?.(`[ws:${src.cfg.name}] stopped: ${error}`);
    await this.closeConnection(src, code, error);
    src.state = 'error';
    this.emit(src, newEvent(src.cfg.name, 'error', { error }));
  }

  private onDone(src: SourceState, conn: WsConnection, info: { code: number | null; reason: string; error: boolean }): void {
    if (src.conn !== conn) return;
    if (src.joining) {
      // Fermée pendant la séquence de join : l'ouverture en cours gère l'échec (une seule reprise).
      src.conn = null;
      const waiter = src.joinWaiter;
      if (waiter && !waiter.done) waiter.reject(new WsException('ws_join_refused'));
      return;
    }
    src.conn = null;
    this.cancelTimers(src);
    this.release(src);
    src.closedAt = this.clock();
    if (src.state === 'error') return;
    src.state = 'closed';
    this.emit(
      src,
      newEvent(src.cfg.name, 'close', {
        closeCode: info.code,
        closeReason: info.reason,
        error: info.error ? 'ws_connection_lost' : '',
        context: src.context,
      }),
    );
    const code = info.code;
    const auth = code === 1008 || (code !== null && code >= 4001 && code <= 4003);
    if (auth) src.authFailures++;
    if (src.wanted && !src.cfg.onDemand && !this.stopping && src.cfg.enabled) this.scheduleReconnect(src, auth);
  }

  // ---------------------------------------------------------------- reconnexion

  private scheduleReconnect(src: SourceState, auth: boolean): void {
    src.attempts++;
    const stopAfter = auth
      ? src.authFailures >= WS_AUTH_FAILURES_BEFORE_STOP
      : src.attempts >= WS_TRANSIENT_FAILURES_BEFORE_STOP;
    if (stopAfter) {
      src.state = 'error';
      src.wanted = false;
      src.lastError = auth ? 'ws_auth_refused' : 'ws_unreachable';
      this.log?.(`[ws:${src.cfg.name}] stopped: ${src.lastError}`);
      return;
    }
    src.state = 'connecting';
    const delay = this.reconnectDelayFn ? this.reconnectDelayFn(src.attempts) : wsReconnectDelay(src.attempts);
    if (src.reconnectTimer) clearTimeout(src.reconnectTimer);
    src.reconnectTimer = setTimeout(() => {
      src.reconnectTimer = null;
      if (!src.wanted || this.stopping) return;
      void this.openSafely(src);
    }, delay);
  }

  // ---------------------------------------------------------------- file vers le workflow

  private emit(src: SourceState, event: WsEvent): void {
    if (event.event === 'message') return; // les messages passent par onData
    src.queue.push(event);
    void this.drain(src);
  }

  /** Un workflow à la fois par source, dans l'ordre d'arrivée. */
  private async drain(src: SourceState): Promise<void> {
    if (src.draining) return;
    src.draining = true;
    try {
      for (let event = src.queue.shift(); event; event = src.queue.shift()) {
        try {
          await this.onEvent(src.cfg, event);
          src.processed++;
        } catch (e) {
          this.log?.(`[ws:${src.cfg.name}] workflow failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } finally {
      src.draining = false;
    }
  }

  private async closeConnection(src: SourceState, code: number, reason: string): Promise<void> {
    const conn = src.conn;
    src.conn = null;
    if (!conn) return;
    try {
      await Promise.race([conn.close(code, reason), new Promise<void>((r) => setTimeout(r, 3000))]);
    } catch {
      /* déjà fermée */
    }
    this.release(src);
  }

  // ---------------------------------------------------------------- état

  /** État lisible par le Manager (`GET /bots/:id/websockets/live`) : jamais de secret ni de contenu de message. */
  snapshot(): Array<Record<string, unknown>> {
    const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());
    return [...this.sources.values()].map((src) => ({
      name: src.cfg.name,
      id: src.cfg.id,
      mode: src.cfg.onDemand ? 'on_demand' : 'permanent',
      state: this.status(src.cfg.name),
      since: iso(src.openedAt),
      attempts: src.attempts,
      last_error: src.lastError,
      last_message_at: iso(src.lastMessageAt),
      queued: src.queue.length,
      counters: {
        received: src.received,
        processed: src.processed,
        dropped_filter: src.droppedFilter,
        dropped_rate: src.droppedRate,
        dropped_queue: src.droppedQueue,
        dropped_binary: src.droppedBinary,
        reconnects: src.reconnects,
      },
    }));
  }
}
