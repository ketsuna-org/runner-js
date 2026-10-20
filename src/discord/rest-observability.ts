import type { LogOrigin } from '../runtime/log-store.js';

/**
 * Observabilité des réponses REST de Discord, bot par bot.
 *
 * Contexte (incident du 2026-10-19) : Discord bloque l'IP de sortie au-delà de 10 000 réponses
 * invalides (401, 403, 429 hors scope « shared ») par fenêtre de 10 minutes, et rien ne disait
 * quel composant ni quel bot les avait consommées. Ce module compte ces réponses par bot et par
 * route, et journalise les deux événements REST de discord.js, sans rien changer au trafic.
 */

/**
 * Valeur de `rest.invalidRequestWarningInterval` : discord.js émet `invalidRequestWarning` toutes
 * les 250 réponses invalides (250, 500, 750...), donc bien avant les 10 000 de Discord.
 * Le compteur de discord.js est global au PROCESSUS (variable de module de @discordjs/rest, partagée
 * par tous les clients REST, y compris ceux qui n'ont pas l'option) : c'est une alarme grossière, le
 * compte par bot vient de DiscordRestStats.
 */
export const DISCORD_INVALID_REQUEST_WARNING_INTERVAL = 250;

/** Fenêtre de Discord pour sa limite de réponses invalides. */
export const DISCORD_INVALID_WINDOW_MS = 10 * 60_000;

/** Plafond de lignes de journal par bot, par type d'événement et par minute. */
export const REST_LOG_MAX_LINES_PER_MINUTE = 6;

const BUCKET_MS = 60_000;
const LINE_WINDOW_MS = 60_000;
// Clés (route, statut) distinctes retenues par bot : les routes viennent de scripts utilisateur.
const MAX_ROUTE_KEYS = 50;
const SNAPSHOT_TOP_ROUTES = 8;
const LINE_TOP_ROUTES = 3;

const INVALID_STATUSES = [401, 403, 429] as const;
type InvalidStatus = (typeof INVALID_STATUSES)[number];
type StatusKey = '401' | '403' | '429';

function isInvalidStatus(status: number): status is InvalidStatus {
  return status === 401 || status === 403 || status === 429;
}

/** Une réponse invalide vue par le transport REST (jamais le jeton, jamais le corps). */
export type DiscordResponseInfo = {
  status: number;
  method: string;
  url: string;
  /** En-tête X-RateLimit-Scope : « shared » exclut un 429 du budget de Discord. */
  scope?: string | null;
};

export interface DiscordRestSnapshot {
  /** Événements `invalidRequestWarning` reçus (seuils de 250 du compteur global du processus). */
  invalidRequestWarnings: number;
  lastInvalidRequestWarningAt: string | null;
  /** Événements `rateLimited` : attentes locales de discord.js, PAS le nombre de 429 reçus. */
  rateLimited: number;
  lastRateLimitedAt: string | null;
  invalid: {
    /** Réponses invalides des 10 dernières minutes (comparables aux 10 000 de Discord). */
    window10m: number;
    byStatus: Record<StatusKey, number>;
    /** Depuis le démarrage du runner, tous redémarrages du bot confondus. */
    total: number;
    /** 429 de scope « shared » : vus, mais non comptés par Discord. */
    sharedRateLimited: number;
    topRoutes: Array<{ route: string; status: number; count: number }>;
  };
}

/**
 * Route sans identifiant ni jeton : snowflakes en `:id`, jeton d'une interaction ou d'un webhook en
 * `:token` (le bucketRoute de discord.js garde celui des interactions), origine, version d'API et
 * paramètres de requête retirés.
 */
export function normalizeDiscordRoute(input: string): string {
  let route = input.trim();
  const origin = /^https?:\/\/[^/]+/i.exec(route);
  if (origin) route = route.slice(origin[0].length);
  route = route.split('?')[0] ?? '';
  route = route.replace(/^\/api(?:\/v\d+)?(?=\/)/, '');
  route = route.replace(/\d{17,20}/g, ':id');
  route = route.replace(/^\/(webhooks|interactions)\/:id\/[^/]+/, '/$1/:id/:token');
  // Filet : un long segment opaque n'a rien à faire dans une ligne de journal.
  route = route.replace(/\/[\w-]{40,}(?=\/|$)/g, '/:token');
  return route;
}

function emptyByStatus(): Record<StatusKey, number> {
  return { '401': 0, '403': 0, '429': 0 };
}

export function emptyDiscordRestSnapshot(): DiscordRestSnapshot {
  return {
    invalidRequestWarnings: 0,
    lastInvalidRequestWarningAt: null,
    rateLimited: 0,
    lastRateLimitedAt: null,
    invalid: {
      window10m: 0,
      byStatus: emptyByStatus(),
      total: 0,
      sharedRateLimited: 0,
      topRoutes: [],
    },
  };
}

export type RestLogKind = 'invalid_request_warning' | 'rate_limited';

/**
 * Compteurs REST d'UN bot. Ils appartiennent au bot, pas au client discord.js : le superviseur crée
 * un runner (donc un client) à chaque démarrage, et un bot qui boucle sur ses redémarrages est
 * précisément le cas où les compteurs ne doivent pas repartir de zéro.
 */
export class DiscordRestStats {
  private invalidRequestWarnings = 0;
  private lastInvalidRequestWarningAt: string | null = null;
  private rateLimited = 0;
  private lastRateLimitedAt: string | null = null;
  private total = 0;
  private sharedRateLimited = 0;
  private readonly buckets: Array<{ start: number; counts: Record<StatusKey, number> }> = [];
  private readonly routes = new Map<string, { route: string; status: number; count: number }>();
  private readonly lineWindows = new Map<RestLogKind, { start: number; count: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  recordInvalidResponse(info: DiscordResponseInfo): void {
    if (!isInvalidStatus(info.status)) return;
    if (info.status === 429 && (info.scope ?? '').trim().toLowerCase() === 'shared') {
      this.sharedRateLimited += 1;
      return;
    }
    const now = this.now();
    const key = String(info.status) as StatusKey;
    this.total += 1;

    const start = Math.floor(now / BUCKET_MS) * BUCKET_MS;
    let bucket = this.buckets[this.buckets.length - 1];
    if (!bucket || bucket.start !== start) {
      bucket = { start, counts: emptyByStatus() };
      this.buckets.push(bucket);
    }
    bucket.counts[key] += 1;
    this.pruneBuckets(now);

    const route = `${info.method.toUpperCase()} ${normalizeDiscordRoute(info.url)}`;
    let routeKey = `${route}|${info.status}`;
    if (!this.routes.has(routeKey) && this.routes.size >= MAX_ROUTE_KEYS) {
      routeKey = `other|${info.status}`;
    }
    const entry = this.routes.get(routeKey);
    if (entry) {
      entry.count += 1;
    } else {
      this.routes.set(routeKey, {
        route: routeKey.startsWith('other|') ? 'other' : route,
        status: info.status,
        count: 1,
      });
    }
  }

  recordInvalidRequestWarning(): void {
    this.invalidRequestWarnings += 1;
    this.lastInvalidRequestWarningAt = new Date(this.now()).toISOString();
  }

  recordRateLimited(): void {
    this.rateLimited += 1;
    this.lastRateLimitedAt = new Date(this.now()).toISOString();
  }

  /** Une ligne par événement, dans la limite de REST_LOG_MAX_LINES_PER_MINUTE ; la suivante dit qu'on coupe. */
  takeLogSlot(kind: RestLogKind): 'emit' | 'notice' | 'drop' {
    const now = this.now();
    let window = this.lineWindows.get(kind);
    if (!window || now - window.start >= LINE_WINDOW_MS) {
      window = { start: now, count: 0 };
      this.lineWindows.set(kind, window);
    }
    window.count += 1;
    if (window.count <= REST_LOG_MAX_LINES_PER_MINUTE) return 'emit';
    return window.count === REST_LOG_MAX_LINES_PER_MINUTE + 1 ? 'notice' : 'drop';
  }

  window(): { total: number; byStatus: Record<StatusKey, number> } {
    this.pruneBuckets(this.now());
    const byStatus = emptyByStatus();
    for (const bucket of this.buckets) {
      for (const key of Object.keys(byStatus) as StatusKey[]) {
        byStatus[key] += bucket.counts[key];
      }
    }
    return { total: byStatus['401'] + byStatus['403'] + byStatus['429'], byStatus };
  }

  topRoutes(limit = SNAPSHOT_TOP_ROUTES): Array<{ route: string; status: number; count: number }> {
    return [...this.routes.values()]
      .sort((a, b) => b.count - a.count || a.route.localeCompare(b.route) || a.status - b.status)
      .slice(0, limit)
      .map(({ route, status, count }) => ({ route, status, count }));
  }

  snapshot(): DiscordRestSnapshot {
    const window = this.window();
    return {
      invalidRequestWarnings: this.invalidRequestWarnings,
      lastInvalidRequestWarningAt: this.lastInvalidRequestWarningAt,
      rateLimited: this.rateLimited,
      lastRateLimitedAt: this.lastRateLimitedAt,
      invalid: {
        window10m: window.total,
        byStatus: window.byStatus,
        total: this.total,
        sharedRateLimited: this.sharedRateLimited,
        topRoutes: this.topRoutes(),
      },
    };
  }

  private pruneBuckets(now: number): void {
    const oldest = now - DISCORD_INVALID_WINDOW_MS;
    while (this.buckets.length > 0 && this.buckets[0]!.start + BUCKET_MS <= oldest) {
      this.buckets.shift();
    }
  }
}

/** Le strict nécessaire de `client.rest` (un émetteur d'événements). */
export type RestEventSource = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): unknown;
};

export type RestLog = (
  level: 'info' | 'warn' | 'error' | 'debug',
  message: string,
  origin?: LogOrigin,
) => void;

type InvalidRequestWarningData = { count: number; remainingTime: number };
type RateLimitedData = {
  global?: boolean;
  method?: string;
  route?: string;
  scope?: string;
  retryAfter?: number;
  timeToReset?: number;
};

/**
 * Branche les événements REST de discord.js : une ligne `warn` par événement (recopiée sur stdout
 * par le LogStore), plafonnée par minute et par type, les compteurs restant exacts. À rappeler
 * après chaque `new Client(...)` : l'émetteur change, les compteurs (stats) non.
 *
 * `rateLimited` n'est PAS un compteur de 429 : discord.js ne l'émet que quand il met une requête
 * en attente d'une limite déjà connue (bucket épuisé, limite globale). Un 429 inattendu, et surtout
 * un 429 sans en-têtes de Cloudflare, ne l'émet pas ; ils sont comptés par le transport
 * (createGuardedMakeRequest) dans stats.invalid.
 */
export function attachRestObservers(
  rest: RestEventSource,
  botId: string,
  onLog: RestLog,
  stats: DiscordRestStats,
): void {
  const log = (kind: RestLogKind, message: () => string): void => {
    const slot = stats.takeLogSlot(kind);
    if (slot === 'drop') return;
    if (slot === 'notice') {
      onLog(
        'warn',
        `Discord REST ${kind} lines suppressed bot=${botId}: more than ${REST_LOG_MAX_LINES_PER_MINUTE} per minute, counters keep counting (discordRest in /status)`,
      );
      return;
    }
    onLog('warn', message());
  };

  rest.on('invalidRequestWarning', (data: InvalidRequestWarningData) => {
    stats.recordInvalidRequestWarning();
    log('invalid_request_warning', () => {
      const window = stats.window();
      const top = stats
        .topRoutes(LINE_TOP_ROUTES)
        .map((entry) => `${entry.route} ${entry.status}:${entry.count}`)
        .join(';');
      return (
        `Discord REST invalid_request_warning bot=${botId} process_count=${data.count} ` +
        `window_remaining_s=${Math.round(data.remainingTime / 1000)} bot_invalid_10m=${window.total} ` +
        `by_status=401:${window.byStatus['401']},403:${window.byStatus['403']},429:${window.byStatus['429']} ` +
        `top=${top || 'none'}`
      );
    });
  });

  rest.on('rateLimited', (data: RateLimitedData) => {
    stats.recordRateLimited();
    log('rate_limited', () => {
      const retryAfter = data.retryAfter ?? data.timeToReset ?? 0;
      return (
        `Discord REST rate_limited bot=${botId} method=${(data.method ?? '?').toUpperCase()} ` +
        `route=${data.route ? normalizeDiscordRoute(data.route) : '?'} global=${Boolean(data.global)} ` +
        `scope=${data.scope ?? '?'} retry_after_ms=${Math.round(retryAfter)}`
      );
    });
  });
}
