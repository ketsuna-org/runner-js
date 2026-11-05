/**
 * Envoi par lots des lignes de journal vers le Manager (journal durable, migration 000193).
 *
 * Contrat: POST `<managedRunnerApi>/bot-logs` avec `{ records: [...] }` (500 lignes au plus).
 * Le Manager masque les jetons et borne le volume par bot et par jour; ici on borne la file et
 * le débit par bot pour qu'un script bavard ne ralentisse jamais le runner. L'envoi n'est
 * JAMAIS bloquant pour l'exécution d'une commande: `enqueue` est synchrone et ne lève pas.
 */

export type LogAudience = 'user' | 'support' | 'internal';

/** Une ligne telle que le Manager l'attend (voir `RunnerBotLogRecord` côté Go). */
export interface ShippedLogRecord {
  bot_id: string;
  at: string;
  level: 'debug' | 'info' | 'warning' | 'error';
  audience: LogAudience;
  category: string;
  source: string;
  message: string;
  command?: string;
  guild_id?: string;
  channel_id?: string;
  user_id?: string;
  duration_ms?: number;
  error_code?: string;
  fields?: Record<string, unknown>;
}

export interface LogShipperOptions {
  baseUrl: string;
  token: string;
  /** Intervalle d'envoi (ms). */
  intervalMs?: number;
  /** Lignes par requête (le Manager en accepte 500). */
  maxBatch?: number;
  /** Plafond de la file en mémoire; au-delà, les plus anciennes sont abandonnées. */
  maxQueue?: number;
  /** Lignes acceptées par bot et par minute avant coupure (une ligne signale la coupure). */
  perBotPerMinute?: number;
  fetchFn?: typeof fetch;
  now?: () => number;
}

export class LogShipper {
  private readonly url: string;
  readonly #token: string;
  private readonly intervalMs: number;
  private readonly maxBatch: number;
  private readonly maxQueue: number;
  private readonly perBotPerMinute: number;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private queue: ShippedLogRecord[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private sending: Promise<void> | null = null;
  private failures = 0;
  private nextAttemptAt = 0;
  private readonly windows = new Map<string, { start: number; count: number }>();
  /** Lignes abandonnées (file pleine ou débit): visible pour les tests et le diagnostic. */
  droppedLocally = 0;

  constructor(options: LogShipperOptions) {
    const trimmed = options.baseUrl.trim();
    this.url = `${trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed}/bot-logs`;
    this.#token = options.token.trim();
    this.intervalMs = options.intervalMs ?? 3000;
    this.maxBatch = Math.min(options.maxBatch ?? 200, 500);
    this.maxQueue = options.maxQueue ?? 5000;
    this.perBotPerMinute = options.perBotPerMinute ?? 600;
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => void this.flush(), this.intervalMs);
    // Ne retient pas le processus à l'arrêt.
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Arrête le minuteur et tente un dernier envoi. */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.nextAttemptAt = 0;
    await this.flush();
  }

  /** Ajoute une ligne; jamais bloquant, ne lève jamais. */
  enqueue(record: ShippedLogRecord): void {
    if (!record.bot_id) {
      return;
    }
    // Les lignes d'erreur et de mesure ne sont pas comptées dans le débit d'un script bavard.
    if (record.level !== 'error' && record.audience !== 'internal' && !this.admit(record.bot_id)) {
      this.droppedLocally += 1;
      return;
    }
    this.queue.push(record);
    if (this.queue.length > this.maxQueue) {
      const over = this.queue.length - this.maxQueue;
      this.queue.splice(0, over);
      this.droppedLocally += over;
    }
  }

  private admit(botId: string): boolean {
    const now = this.now();
    let w = this.windows.get(botId);
    if (!w || now - w.start >= 60_000) {
      w = { start: now, count: 0 };
      this.windows.set(botId, w);
    }
    w.count += 1;
    if (w.count === this.perBotPerMinute + 1) {
      // Une seule ligne dit qu'on a coupé; le reste de la minute est ignoré.
      this.queue.push({
        bot_id: botId,
        at: new Date(now).toISOString(),
        level: 'warning',
        audience: 'user',
        category: 'log',
        source: 'runner-js',
        message: `Log throttled: more than ${this.perBotPerMinute} lines per minute, the rest of this minute is not stored`,
      });
    }
    return w.count <= this.perBotPerMinute;
  }

  get pending(): number {
    return this.queue.length;
  }

  /** Envoie la file par lots; en cas d'échec, la remet en tête (bornée) et attend (backoff). */
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
        // 4xx (hors 408/429): le lot est refusé pour de bon, on ne le rejoue pas.
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
        // 3 s, 6 s, 12 s ... jusqu'à 60 s.
        this.nextAttemptAt = this.now() + Math.min(60_000, 3000 * 2 ** Math.min(this.failures - 1, 5));
        return;
      }
    }
  }
}
