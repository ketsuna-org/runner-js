import { InfrastructureError } from './infrastructure-error.js';
import { perfManagerCall } from './perf.js';
import { splitManagedContextId } from './scoped-context-parts.js';
import type {
  ScopedIndexQueryOptions,
  ScopedIndexQueryResult,
  VariableDatabase,
} from './variable-database.js';

export interface ManagedStoreResilience {
  /** Nouvelles tentatives après un échec transitoire (donc 1 + maxRetries essais). */
  maxRetries: number;
  /** Délai avant la première nouvelle tentative, doublé à chaque essai. */
  retryBaseDelayMs: number;
  requestTimeoutMs: number;
  /** Échecs consécutifs (après nouvelles tentatives) qui ouvrent le disjoncteur. */
  breakerThreshold: number;
  breakerCooldownMs: number;
  maxQueuedWrites: number;
  maxCacheEntries: number;
  drainBaseDelayMs: number;
  maxDrainDelayMs: number;
}

const DEFAULT_RESILIENCE: ManagedStoreResilience = {
  maxRetries: 2,
  retryBaseDelayMs: 250,
  requestTimeoutMs: 8000,
  breakerThreshold: 5,
  breakerCooldownMs: 15000,
  maxQueuedWrites: 1000,
  maxCacheEntries: 2000,
  drainBaseDelayMs: 2000,
  maxDrainDelayMs: 60000,
};

interface ManagedVariableStoreOptions {
  baseUrl: string;
  token: string;
  resilience?: Partial<ManagedStoreResilience>;
  log?: (message: string) => void;
}

interface QueuedWrite {
  botId: string;
  suffix: string;
  body: Record<string, unknown>;
}

class InfraFailure extends Error {
  constructor(
    readonly detail: string,
    readonly requestNotSent = false,
  ) {
    super(detail);
  }
}

/** Écritures sans danger en cas de rejeu. */
const IDEMPOTENT_WRITES = new Set([
  '/global/set',
  '/global/remove',
  '/scoped/set',
  '/scoped/remove',
  '/scoped/delete-by-key',
  '/all/delete',
]);

/** Écritures gardées en file d'attente quand le Manager est absent. */
const QUEUEABLE_WRITES = new Set(['/global/set', '/global/remove', '/scoped/set', '/scoped/remove']);

function isInfraStatus(code: number): boolean {
  return code >= 500 || code === 408 || code === 429 || code === 401 || code === 403;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Variables servies par l'API du Manager (Postgres reste la source de vérité).
 *
 * Quand le Manager ne répond pas, le magasin se dégrade au lieu de casser le bot : nouvelles tentatives
 * avec délai croissant, disjoncteur (plus d'appels pendant un moment), lectures servies depuis la
 * dernière valeur connue, écritures simples mises en file d'attente et rejouées dans l'ordre au retour.
 * Ce qui ne peut pas être servi lève une `InfrastructureError` : message montrable, détail dans les logs.
 */
export class ManagedVariableStore implements VariableDatabase {
  private readonly baseUrl: string;
  readonly #token: string;
  private readonly cfg: ManagedStoreResilience;
  private readonly log: (message: string) => void;
  private readonly cache = new Map<string, string>();
  private readonly queue: QueuedWrite[] = [];
  private consecutiveFailures = 0;
  private breakerOpenUntil = 0;
  private draining = false;
  private drainAttempts = 0;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(options: ManagedVariableStoreOptions) {
    const trimmed = options.baseUrl.trim();
    this.baseUrl = trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
    this.#token = options.token.trim();
    this.cfg = { ...DEFAULT_RESILIENCE, ...options.resilience };
    this.log = options.log ?? ((message) => console.warn(message));
  }

  dispose(): void {
    this.disposed = true;
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.drainTimer = null;
  }

  /** Écritures en attente de rejeu (tests, diagnostic). */
  get pendingWrites(): number {
    return this.queue.length;
  }

  get breakerOpen(): boolean {
    return Date.now() < this.breakerOpenUntil;
  }

  /** Libellé statique d'une route pour la mesure : `/scoped/list` devient `scoped/list`. */
  private static perfRoute(suffix: string): string {
    return suffix.startsWith('/') ? suffix.slice(1) : suffix;
  }

  private recordSuccess(): void {
    if (this.breakerOpenUntil !== 0) {
      this.log('[ManagedVariableStore] Manager reachable again, breaker closed.');
    }
    this.consecutiveFailures = 0;
    this.breakerOpenUntil = 0;
  }

  private recordFailure(detail: string): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.cfg.breakerThreshold) {
      const wasOpen = this.breakerOpen;
      this.breakerOpenUntil = Date.now() + this.cfg.breakerCooldownMs;
      if (!wasOpen) {
        this.log(
          `[ManagedVariableStore] Manager unavailable (${detail}), breaker open for ${Math.round(
            this.cfg.breakerCooldownMs / 1000,
          )}s: serving cached values, queueing writes.`,
        );
      }
    }
  }

  /** Un essai HTTP : lève InfraFailure pour une panne d'infrastructure. */
  private async attempt(suffix: string, send: (signal: AbortSignal) => Promise<Response>): Promise<Response> {
    let response: Response;
    try {
      response = await perfManagerCall(ManagedVariableStore.perfRoute(suffix), () =>
        send(AbortSignal.timeout(this.cfg.requestTimeoutMs)),
      );
    } catch (error) {
      const name = (error as { name?: string })?.name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new InfraFailure(`timeout (${suffix})`);
      }
      throw new InfraFailure(String(error instanceof Error ? error.message : error), true);
    }
    if (isInfraStatus(response.status)) {
      throw new InfraFailure(`HTTP ${response.status} (${suffix})`);
    }
    return response;
  }

  private async withRetries(
    suffix: string,
    retry: boolean,
    send: (signal: AbortSignal) => Promise<Response>,
  ): Promise<Response> {
    const retries = retry ? this.cfg.maxRetries : 0;
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await this.attempt(suffix, send);
        this.recordSuccess();
        return response;
      } catch (error) {
        if (!(error instanceof InfraFailure)) throw error;
        if (attempt >= retries || this.disposed) {
          this.recordFailure(error.detail);
          throw error;
        }
        await sleep(this.cfg.retryBaseDelayMs * 2 ** attempt);
      }
    }
  }

  private url(botId: string, suffix: string): string {
    return `${this.baseUrl}/bots/${encodeURIComponent(botId)}/variables${suffix}`;
  }

  private async post(botId: string, suffix: string, body: Record<string, unknown>): Promise<unknown> {
    const queueable = QUEUEABLE_WRITES.has(suffix);
    // Garder l'ordre des écritures : on rejoue d'abord ce qui attend.
    if (this.queue.length > 0 && !this.breakerOpen) {
      await this.drain();
    }
    if (this.queue.length > 0 || this.breakerOpen) {
      if (queueable) {
        this.enqueue(botId, suffix, body);
        return null;
      }
      throw new InfrastructureError(`Manager unavailable (breaker open, ${suffix})`);
    }

    let response: Response;
    try {
      response = await this.withRetries(suffix, IDEMPOTENT_WRITES.has(suffix), (signal) =>
        fetch(this.url(botId, suffix), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.#token}` },
          body: JSON.stringify(body),
          signal,
        }),
      );
    } catch (error) {
      if (!(error instanceof InfraFailure)) throw error;
      // Une requête a pu être traitée malgré l'échec : on ne rejoue que le sans-danger.
      if (queueable && (IDEMPOTENT_WRITES.has(suffix) || error.requestNotSent)) {
        this.enqueue(botId, suffix, body);
        return null;
      }
      throw new InfrastructureError(error.detail);
    }
    if (response.status >= 400) {
      const text = await response.text();
      throw new Error(`[ManagedVariableStore] API error (${suffix}): ${response.status} - ${text}`);
    }
    if (response.status === 204) {
      return null;
    }
    const text = await response.text();
    return text.length > 0 ? JSON.parse(text) : null;
  }

  private async get(
    botId: string,
    suffix: string,
    query: Record<string, string | undefined>,
  ): Promise<unknown> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value != null && value.length > 0) {
        params.set(key, value);
      }
    }
    const queryString = params.toString();
    const url = `${this.url(botId, suffix)}${queryString ? `?${queryString}` : ''}`;

    if (this.queue.length > 0 && !this.breakerOpen) {
      await this.drain();
    }
    if (this.breakerOpen) {
      return this.degradedGet(botId, suffix, query, url, 'breaker open');
    }

    let response: Response;
    try {
      response = await this.withRetries(suffix, true, (signal) =>
        fetch(url, {
          headers: { Authorization: `Bearer ${this.#token}`, 'Cache-Control': 'no-cache' },
          signal,
        }),
      );
    } catch (error) {
      if (!(error instanceof InfraFailure)) throw error;
      return this.degradedGet(botId, suffix, query, url, error.detail);
    }
    if (response.status === 404) {
      this.remember(url, 'null');
      return null;
    }
    if (response.status >= 400) {
      const text = await response.text();
      throw new Error(`[ManagedVariableStore] API error (${suffix}): ${response.status} - ${text}`);
    }
    const text = await response.text();
    if (text.length === 0) return null;
    this.remember(url, text);
    return JSON.parse(text);
  }

  private remember(key: string, body: string): void {
    this.cache.delete(key);
    this.cache.set(key, body);
    while (this.cache.size > this.cfg.maxCacheEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  /** Dernière valeur connue, écritures en attente par-dessus ; sinon panne d'infrastructure. */
  private degradedGet(
    botId: string,
    suffix: string,
    query: Record<string, string | undefined>,
    url: string,
    detail: string,
  ): unknown {
    const cachedBody = this.cache.get(url);
    const cached = cachedBody === undefined ? undefined : JSON.parse(cachedBody);
    const overlay = this.overlayPending(botId, suffix, query, cached, cachedBody !== undefined);
    if (overlay.found) return overlay.value;
    throw new InfrastructureError(`Manager unavailable, no cached value (${suffix}): ${detail}`);
  }

  private overlayPending(
    botId: string,
    suffix: string,
    query: Record<string, string | undefined>,
    cached: unknown,
    hasCache: boolean,
  ): { found: boolean; value: unknown } {
    const isGet = suffix === '/global/get' || suffix === '/scoped/get';
    const isList = suffix === '/global/list' || suffix === '/scoped/list';
    if (!isGet && !isList) return { found: hasCache, value: cached };
    const scoped = suffix.startsWith('/scoped');
    const setSuffix = scoped ? '/scoped/set' : '/global/set';
    const removeSuffix = scoped ? '/scoped/remove' : '/global/remove';

    const writes = this.queue.filter(
      (w) =>
        w.botId === botId &&
        (w.suffix === setSuffix || w.suffix === removeSuffix) &&
        (!scoped ||
          (w.body.scope === query.scope &&
            w.body.scope_id === query.scope_id &&
            String(w.body.scope_aux_id ?? '') === String(query.scope_aux_id ?? ''))),
    );

    if (isGet) {
      let found = hasCache;
      let value: unknown =
        cached && typeof cached === 'object' && 'value' in (cached as object)
          ? (cached as { value: unknown }).value
          : cached;
      for (const w of writes) {
        if (w.body.key !== query.key) continue;
        found = true;
        value = w.suffix === setSuffix ? w.body.value : null;
      }
      return { found, value };
    }

    if (!hasCache) return { found: false, value: undefined };
    const map: Record<string, unknown> = {};
    if (Array.isArray(cached)) {
      for (const item of cached) {
        if (item && typeof item === 'object' && 'key' in item) {
          const record = item as { key: unknown; value: unknown };
          map[String(record.key)] = record.value;
        }
      }
    } else if (cached && typeof cached === 'object') {
      Object.assign(map, cached);
    }
    for (const w of writes) {
      const key = w.body.key == null ? null : String(w.body.key);
      if (key === null) continue;
      if (w.suffix === setSuffix) map[key] = w.body.value;
      else delete map[key];
    }
    return { found: true, value: map };
  }

  private enqueue(botId: string, suffix: string, body: Record<string, unknown>): void {
    this.queue.push({ botId, suffix, body });
    if (this.queue.length > this.cfg.maxQueuedWrites) {
      this.queue.shift();
      this.log(
        `[ManagedVariableStore] Write queue full (${this.cfg.maxQueuedWrites}), dropped the oldest pending write.`,
      );
    }
    this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (this.disposed || this.queue.length === 0 || this.drainTimer) return;
    const delay = Math.min(this.cfg.drainBaseDelayMs * 2 ** Math.min(this.drainAttempts, 5), this.cfg.maxDrainDelayMs);
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      void this.drain();
    }, delay);
    // Ne retient pas le processus à l'arrêt.
    (this.drainTimer as { unref?: () => void }).unref?.();
  }

  /** Rejoue les écritures en attente, dans l'ordre, jusqu'à la première panne. */
  private async drain(): Promise<void> {
    if (this.draining || this.disposed) return;
    this.draining = true;
    try {
      while (this.queue.length > 0 && !this.disposed) {
        const write = this.queue[0]!;
        try {
          const response = await this.attempt(write.suffix, (signal) =>
            fetch(this.url(write.botId, write.suffix), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.#token}` },
              body: JSON.stringify(write.body),
              signal,
            }),
          );
          this.recordSuccess();
          this.queue.shift();
          if (response.status >= 400) {
            this.log(
              `[ManagedVariableStore] Dropped queued write ${write.suffix}: ${response.status} - ${await response.text()}`,
            );
          }
        } catch (error) {
          if (!(error instanceof InfraFailure)) throw error;
          this.recordFailure(error.detail);
          this.drainAttempts++;
          return;
        }
      }
      if (this.queue.length === 0 && this.drainAttempts > 0) {
        this.log('[ManagedVariableStore] Queued writes replayed.');
      }
      this.drainAttempts = 0;
    } finally {
      this.draining = false;
      this.scheduleDrain();
    }
  }

  async getGlobalVariables(botId: string): Promise<Record<string, unknown>> {
    const response = await this.get(botId, '/global/list', {});
    if (Array.isArray(response)) {
      const result: Record<string, unknown> = {};
      for (const item of response) {
        if (item && typeof item === 'object' && 'key' in item) {
          const record = item as { key: unknown; value: unknown };
          result[String(record.key)] = record.value;
        }
      }
      return result;
    }
    if (response && typeof response === 'object') {
      return { ...(response as Record<string, unknown>) };
    }
    return {};
  }

  async getGlobalVariable(botId: string, key: string): Promise<unknown> {
    const response = await this.get(botId, '/global/get', { key });
    if (response && typeof response === 'object' && 'value' in response) {
      return (response as { value: unknown }).value;
    }
    return response;
  }

  async setGlobalVariable(botId: string, key: string, value: unknown): Promise<void> {
    await this.post(botId, '/global/set', { key, value });
  }

  async removeGlobalVariable(botId: string, key: string): Promise<void> {
    await this.post(botId, '/global/remove', { key });
  }

  async renameGlobalVariable(botId: string, oldKey: string, newKey: string): Promise<void> {
    await this.post(botId, '/global/rename', { oldKey, newKey });
  }

  async getScopedVariables(
    botId: string,
    scope: string,
    contextId: string,
  ): Promise<Record<string, unknown>> {
    const { scopeId, scopeAuxId } = splitManagedContextId(scope, contextId);
    const response = await this.get(botId, '/scoped/list', {
      scope,
      scope_id: scopeId,
      scope_aux_id: scopeAuxId,
    });
    if (Array.isArray(response)) {
      const result: Record<string, unknown> = {};
      for (const item of response) {
        if (item && typeof item === 'object' && 'key' in item) {
          const record = item as { key: unknown; value: unknown };
          result[String(record.key)] = record.value;
        }
      }
      return result;
    }
    if (response && typeof response === 'object') {
      return { ...(response as Record<string, unknown>) };
    }
    return {};
  }

  async getScopedVariable(
    botId: string,
    scope: string,
    contextId: string,
    key: string,
  ): Promise<unknown> {
    const { scopeId, scopeAuxId } = splitManagedContextId(scope, contextId);
    const response = await this.get(botId, '/scoped/get', {
      scope,
      scope_id: scopeId,
      scope_aux_id: scopeAuxId,
      key,
    });
    if (response && typeof response === 'object' && 'value' in response) {
      return (response as { value: unknown }).value;
    }
    return response;
  }

  async setScopedVariable(
    botId: string,
    scope: string,
    contextId: string,
    key: string,
    value: unknown,
  ): Promise<void> {
    const { scopeId, scopeAuxId } = splitManagedContextId(scope, contextId);
    await this.post(botId, '/scoped/set', {
      scope,
      scope_id: scopeId,
      scope_aux_id: scopeAuxId,
      key,
      value,
    });
  }

  async removeScopedVariable(
    botId: string,
    scope: string,
    contextId: string,
    key: string,
  ): Promise<void> {
    const { scopeId, scopeAuxId } = splitManagedContextId(scope, contextId);
    await this.post(botId, '/scoped/remove', {
      scope,
      scope_id: scopeId,
      scope_aux_id: scopeAuxId,
      key,
    });
  }

  async listContextIds(
    botId: string,
    scope: string,
    searchKey: string,
  ): Promise<string[]> {
    const response = await this.get(botId, '/scoped/list-contexts', {
      scope,
      search_key: searchKey.trim() || undefined,
    });
    return Array.isArray(response) ? response.map((entry) => String(entry)) : [];
  }

  async removeAllScopedValuesForKey(botId: string, scope: string, key: string): Promise<void> {
    await this.post(botId, '/scoped/delete-by-key', { scope, key });
  }

  async deleteAllForBot(botId: string): Promise<void> {
    await this.post(botId, '/all/delete', {});
  }

  async queryScopedVariableIndex(
    botId: string,
    scope: string,
    key: string,
    options: ScopedIndexQueryOptions = {},
  ): Promise<ScopedIndexQueryResult> {
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 25;
    const descending = options.descending !== false;
    const response = await this.get(botId, '/scoped/query-index', {
      scope,
      key,
      offset: String(offset),
      limit: String(limit),
      descending: String(descending),
    });
    if (!response || typeof response !== 'object') {
      return { items: [], count: 0, total: 0 };
    }
    const record = response as {
      items?: Array<{ contextId?: string; key?: string; value?: unknown }>;
      count?: number;
      total?: number;
    };
    const items = Array.isArray(record.items)
      ? record.items.map((item) => ({
          contextId: String(item.contextId ?? ''),
          key: String(item.key ?? key),
          value: item.value,
        }))
      : [];
    return {
      items,
      count: typeof record.count === 'number' ? record.count : items.length,
      total: typeof record.total === 'number' ? record.total : items.length,
    };
  }
}
