/**
 * Statistiques de commandes vers le Manager (Dashboard des commandes).
 *
 * Contrat: POST `<managedRunnerApi>/command-stats` avec `{ records: [...] }` (même route que le runner Dart,
 * `ManagedRunnerCommandStatRecord` côté Go). Une ligne par exécution de commande (slash, préfixe, mention,
 * sans préfixe): succès, latence, langues, texte d'erreur masqué. L'envoi n'est JAMAIS bloquant:
 * `record` est synchrone et ne lève pas.
 */

export interface ShippedCommandStat {
  bot_id: string;
  command_name: string;
  guild_id?: string;
  locale?: string;
  guild_locale?: string;
  success: boolean;
  latency_ms: number;
  error?: string;
  executed_at: string;
}

export interface CommandStatsShipperOptions {
  baseUrl: string;
  token: string;
  intervalMs?: number;
  maxBatch?: number;
  maxQueue?: number;
  fetchFn?: typeof fetch;
  now?: () => number;
}

const MAX_ERROR_CHARS = 300;

/** Une ligne, sans jeton ni secret évident, bornée: le texte part chez le Manager puis dans le Dashboard. */
export function redactCommandError(raw: string | undefined): string {
  if (!raw) {
    return '';
  }
  const text = raw
    .replace(/\b[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,}\b/g, '[token]')
    .replace(/\b(Bearer|Bot)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 [token]')
    .replace(/\b(token|secret|password|api[_-]?key|authorization)(\s*[=:]\s*)\S+/gi, '$1$2[hidden]')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}…` : text;
}

export class CommandStatsShipper {
  private readonly url: string;
  readonly #token: string;
  private readonly intervalMs: number;
  private readonly maxBatch: number;
  private readonly maxQueue: number;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private queue: ShippedCommandStat[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private sending: Promise<void> | null = null;
  private failures = 0;
  private nextAttemptAt = 0;
  droppedLocally = 0;

  constructor(options: CommandStatsShipperOptions) {
    const trimmed = options.baseUrl.trim();
    this.url = `${trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed}/command-stats`;
    this.#token = options.token.trim();
    this.intervalMs = options.intervalMs ?? 5000;
    this.maxBatch = Math.min(options.maxBatch ?? 200, 500);
    this.maxQueue = options.maxQueue ?? 5000;
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => void this.flush(), this.intervalMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.nextAttemptAt = 0;
    await this.flush();
  }

  /** Ajoute une exécution; jamais bloquant, ne lève jamais. */
  record(input: {
    botId: string;
    command: string;
    guildId?: string;
    locale?: string;
    guildLocale?: string;
    ok: boolean;
    ms: number;
    error?: string;
  }): void {
    try {
      const command = input.command.trim();
      if (!input.botId || !command) {
        return;
      }
      this.queue.push({
        bot_id: input.botId,
        command_name: command.slice(0, 100),
        guild_id: input.guildId || undefined,
        locale: input.locale || undefined,
        guild_locale: input.guildLocale || undefined,
        success: input.ok,
        latency_ms: Math.max(0, Math.round(input.ms)),
        error: input.ok ? undefined : redactCommandError(input.error) || undefined,
        executed_at: new Date(this.now()).toISOString(),
      });
      if (this.queue.length > this.maxQueue) {
        const over = this.queue.length - this.maxQueue;
        this.queue.splice(0, over);
        this.droppedLocally += over;
      }
    } catch {
      // une statistique ne casse jamais l'exécution
    }
  }

  get pending(): number {
    return this.queue.length;
  }

  flush(): Promise<void> {
    if (this.sending) {
      return this.sending;
    }
    if (this.queue.length === 0 || this.now() < this.nextAttemptAt) {
      return Promise.resolve();
    }
    this.sending = this.drain().finally(() => {
      this.sending = null;
    });
    return this.sending;
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, this.maxBatch);
      try {
        const response = await this.fetchFn(this.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.#token}`,
          },
          body: JSON.stringify({ records: batch }),
        });
        if (response.status >= 500 || response.status === 408 || response.status === 429) {
          throw new Error(`status ${response.status}`);
        }
        this.failures = 0;
      } catch {
        this.failures += 1;
        this.queue.unshift(...batch);
        if (this.queue.length > this.maxQueue) {
          const over = this.queue.length - this.maxQueue;
          this.queue.splice(0, over);
          this.droppedLocally += over;
        }
        this.nextAttemptAt = this.now() + Math.min(60_000, 3000 * 2 ** Math.min(this.failures - 1, 5));
        return;
      }
    }
  }
}

let active: CommandStatsShipper | null = null;

/** Le runner partage un seul envoyeur (tous les bots du nœud); absent en local: rien n'est envoyé. */
export function setCommandStatsShipper(shipper: CommandStatsShipper | null): void {
  active = shipper;
}

export function getCommandStatsShipper(): CommandStatsShipper | null {
  return active;
}
