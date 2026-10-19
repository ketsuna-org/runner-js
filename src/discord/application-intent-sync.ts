import { resolveCommandPrefix, type JsBotConfig } from '../config/js-bot-config.js';
import {
  DiscordTokenUnauthorizedError,
  armDiscordIpBlock,
  classifyDiscord429,
  clampRetryAfterSeconds,
  discord429RetryAfterSeconds,
  discordIpBlockRemainingMs,
} from './discord-auth-errors.js';
import { PRIVILEGED_INTENT_KEYS, resolveRequiredIntentKeys } from './intent-resolver.js';

// Business logic mirrored in bot-creator-shared `application_intent_sync.dart`.
// Valeurs de la doc Discord (ApplicationFlags) : le bit « normal » désigne
// l'intent approuvé (bot vérifié), le bit « _LIMITED » l'intent activé dans le
// portail (bot non vérifié). Les deux comptent comme « activé ».
const APPLICATION_FLAG_GATEWAY_PRESENCE = 1 << 12;
const APPLICATION_FLAG_GATEWAY_PRESENCE_LIMITED = 1 << 13;
const APPLICATION_FLAG_GATEWAY_GUILD_MEMBERS = 1 << 14;
const APPLICATION_FLAG_GATEWAY_GUILD_MEMBERS_LIMITED = 1 << 15;
const APPLICATION_FLAG_GATEWAY_MESSAGE_CONTENT = 1 << 18;
const APPLICATION_FLAG_GATEWAY_MESSAGE_CONTENT_LIMITED = 1 << 19;

/** Budget global de la récupération (toutes tentatives et attentes comprises). */
export const PORTAL_SYNC_TOTAL_BUDGET_MS = 15_000;
const PORTAL_SYNC_ATTEMPT_TIMEOUT_MS = 8_000;
const PORTAL_SYNC_MAX_ATTEMPTS = 4;
const PORTAL_SYNC_BASE_BACKOFF_MS = 500;
const PORTAL_SYNC_MAX_WAIT_MS = 5_000;

const ALL_INTENT_KEYS = [
  'Guilds',
  'Guild Members',
  'Guild Moderation',
  'Guild Expressions',
  'Guild Integrations',
  'Guild Webhooks',
  'Guild Invites',
  'Guild Voice States',
  'Guild Presence',
  'Guild Messages',
  'Guild Message Reactions',
  'Guild Message Typing',
  'Direct Messages',
  'Direct Message Reactions',
  'Direct Message Typing',
  'Message Content',
  'Guild Scheduled Events',
  'Auto Moderation Configuration',
  'Auto Moderation Execution',
  'Guild Message Polls',
  'Direct Message Polls',
] as const;

type DiscordApplication = {
  flags?: number;
};

export class PortalIntentAutoEnableError extends Error {
  constructor(
    message = 'Bot is verified, cannot enable privileged intents automatically. Please enable them in the Discord Developer Portal.',
  ) {
    super(message);
    this.name = 'PortalIntentAutoEnableError';
  }
}

export class PortalIntentPatchFailedError extends Error {
  constructor(public readonly statusCode: number) {
    super(`Failed to update application flags via PATCH (${statusCode})`);
    this.name = 'PortalIntentPatchFailedError';
  }
}

export type PortalPrivilegedIntentSyncResult = {
  enabled: Set<string>;
  didAutoEnable: boolean;
};

function portalEnabledPrivilegedIntentsFromFlags(flags: number): Set<string> {
  const enabled = new Set<string>();

  if (
    (flags & APPLICATION_FLAG_GATEWAY_GUILD_MEMBERS) !== 0 ||
    (flags & APPLICATION_FLAG_GATEWAY_GUILD_MEMBERS_LIMITED) !== 0
  ) {
    enabled.add('Guild Members');
  }
  if (
    (flags & APPLICATION_FLAG_GATEWAY_PRESENCE) !== 0 ||
    (flags & APPLICATION_FLAG_GATEWAY_PRESENCE_LIMITED) !== 0
  ) {
    enabled.add('Guild Presence');
  }
  if (
    (flags & APPLICATION_FLAG_GATEWAY_MESSAGE_CONTENT) !== 0 ||
    (flags & APPLICATION_FLAG_GATEWAY_MESSAGE_CONTENT_LIMITED) !== 0
  ) {
    enabled.add('Message Content');
  }

  return enabled;
}

/** Échec de récupération des flags : ne porte jamais le jeton ni un corps de réponse. */
export class PortalFetchError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number | null,
    public readonly retryAfterSeconds: number | null,
    // 'blocked' : blocage de l'IP de sortie (jamais réessayé, voir classifyDiscord429).
    public readonly kind: 'http' | 'timeout' | 'network' | 'invalid-body' | 'blocked',
    // Limite globale d'un seul jeton (429 « http » uniquement) : n'affecte pas la plateforme.
    public readonly tokenGlobal = false,
  ) {
    super(message);
    this.name = 'PortalFetchError';
  }
}

export type PortalSyncOptions = {
  /** Attente injectable (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Horloge injectable (tests). */
  now?: () => number;
  totalBudgetMs?: number;
};

function parseRetryAfterSeconds(header: string | null): number | null {
  if (header == null) return null;
  const value = Number(header.trim());
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}

function isRetryable(error: PortalFetchError): boolean {
  if (error.kind === 'blocked') return false;
  if (error.kind === 'timeout' || error.kind === 'network') return true;
  if (error.kind === 'invalid-body') return false;
  const status = error.statusCode ?? 0;
  return status === 429 || status >= 500;
}

/** Cause lisible et sans secret, pour le warning de repli. */
export function describePortalSyncFailure(error: unknown): string {
  if (error instanceof PortalFetchError) {
    switch (error.kind) {
      case 'timeout':
        return 'timeout';
      case 'network':
        return error.message;
      case 'invalid-body':
        return 'invalid response body';
      case 'blocked':
        return `Discord is blocking requests from this network, retry after ${error.retryAfterSeconds ?? '?'}s`;
      default: {
        const retry =
          error.retryAfterSeconds != null
            ? `, retry after ${error.retryAfterSeconds}s`
            : '';
        const scope = error.tokenGlobal ? ' (token global limit)' : '';
        return `HTTP ${error.statusCode}${scope}${retry}`;
      }
    }
  }
  const name = error instanceof Error ? error.name : typeof error;
  return `error ${name}`;
}

/** Corps d'un 429, borné et sans effet de bord : sert uniquement à le classer. */
async function readBodyForClassification(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 4096);
  } catch {
    return '';
  }
}

async function fetchApplicationFlagsOnce(
  token: string,
  timeoutMs: number,
  now: () => number,
): Promise<number> {
  let response: Response;
  try {
    response = await fetch('https://discord.com/api/v10/applications/@me', {
      headers: { Authorization: `Bot ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : 'unknown';
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new PortalFetchError('timeout', null, null, 'timeout');
    }
    throw new PortalFetchError(`network error (${name})`, null, null, 'network');
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new DiscordTokenUnauthorizedError(
        `Failed to fetch application flags (${response.status})`,
      );
    }
    if (response.status === 429) {
      const signals = {
        headers: response.headers,
        bodyText: await readBodyForClassification(response),
      };
      const retryAfter = discord429RetryAfterSeconds(signals);
      const kind = classifyDiscord429(signals);
      if (kind === 'ip-block') {
        const seconds = armDiscordIpBlock(retryAfter, now());
        throw new PortalFetchError(
          'Failed to fetch application flags (429, IP block)',
          429,
          seconds,
          'blocked',
        );
      }
      throw new PortalFetchError(
        'Failed to fetch application flags (429)',
        429,
        retryAfter,
        'http',
        kind === 'token-global',
      );
    }
    throw new PortalFetchError(
      `Failed to fetch application flags (${response.status})`,
      response.status,
      parseRetryAfterSeconds(response.headers.get('retry-after')),
      'http',
    );
  }

  try {
    const app = (await response.json()) as DiscordApplication;
    return app.flags ?? 0;
  } catch (error) {
    const name = error instanceof Error ? error.name : 'unknown';
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new PortalFetchError('timeout', null, null, 'timeout');
    }
    throw new PortalFetchError('invalid response body', null, null, 'invalid-body');
  }
}

export async function fetchPortalEnabledPrivilegedIntents(
  token: string,
  options: PortalSyncOptions = {},
): Promise<PortalPrivilegedIntentSyncResult> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const budget = options.totalBudgetMs ?? PORTAL_SYNC_TOTAL_BUDGET_MS;
  const deadline = now() + budget;

  // Blocage d'IP connu : aucune requête de plus, repli immédiat sur les derniers intents.
  const blockedMs = discordIpBlockRemainingMs(now());
  if (blockedMs > 0) {
    throw new PortalFetchError(
      'Discord IP block in effect',
      429,
      clampRetryAfterSeconds(blockedMs / 1000),
      'blocked',
    );
  }

  for (let attempt = 1; ; attempt++) {
    const remaining = deadline - now();
    try {
      const flags = await fetchApplicationFlagsOnce(
        token,
        Math.max(1, Math.min(PORTAL_SYNC_ATTEMPT_TIMEOUT_MS, remaining)),
        now,
      );
      return {
        enabled: portalEnabledPrivilegedIntentsFromFlags(flags),
        didAutoEnable: false,
      };
    } catch (error) {
      // 401/403 (DiscordTokenUnauthorizedError) et tout le reste : pas de retry.
      if (!(error instanceof PortalFetchError) || !isRetryable(error)) throw error;
      if (attempt >= PORTAL_SYNC_MAX_ATTEMPTS) throw error;

      const backoff = PORTAL_SYNC_BASE_BACKOFF_MS * 2 ** (attempt - 1);
      const retryAfterMs =
        error.retryAfterSeconds != null ? error.retryAfterSeconds * 1000 : null;
      // Retry-After trop long : réessayer plus tôt redonnerait un 429, on
      // abandonne tout de suite avec la cause.
      if (retryAfterMs != null && retryAfterMs > PORTAL_SYNC_MAX_WAIT_MS) throw error;
      const waitMs = Math.max(backoff, retryAfterMs ?? 0);
      // Rester dans le budget global : si l'attente ne laisse pas de temps pour
      // une nouvelle tentative, on s'arrête ici avec la cause réelle.
      if (deadline - now() - waitMs <= 0) throw error;
      await sleep(waitMs);
    }
  }
}

export type LastKnownPortalIntents = { enabled: Set<string>; at: Date };

// Mémoire du processus, par bot : dernier ensemble lu avec succès.
const lastKnownPortalIntents = new Map<string, LastKnownPortalIntents>();

export function rememberPortalIntents(
  botId: string,
  enabled: Set<string>,
  at: Date = new Date(),
): void {
  lastKnownPortalIntents.set(botId, { enabled: new Set(enabled), at });
}

export function getLastKnownPortalIntents(
  botId: string,
): LastKnownPortalIntents | undefined {
  return lastKnownPortalIntents.get(botId);
}

export function clearLastKnownPortalIntents(botId?: string): void {
  if (botId === undefined) lastKnownPortalIntents.clear();
  else lastKnownPortalIntents.delete(botId);
}

export function buildPortalIntentsMap(portalEnabledPrivileged: Set<string>): Record<string, boolean> {
  const intents: Record<string, boolean> = {
    Guilds: true,
  };
  for (const key of portalEnabledPrivileged) {
    intents[key] = true;
  }
  return intents;
}

function configEventNames(config: JsBotConfig): string[] {
  return (config.events ?? []).map((event) => event.name);
}

export function configHasLegacyPrefixCommands(config: JsBotConfig): boolean {
  return Boolean(resolveCommandPrefix(config));
}

export function buildEffectiveIntentsMap(
  config: JsBotConfig,
  portalEnabledPrivileged: Set<string>,
  warnings?: string[],
): Record<string, boolean> {
  const requiredKeys = resolveRequiredIntentKeys({
    eventNames: configEventNames(config),
    hasLegacyCommands: configHasLegacyPrefixCommands(config),
    approvedPrivilegedIntents: portalEnabledPrivileged,
    warnings,
  });

  // Non-privileged intents are always on. Privileged ones stay off unless
  // required by the bot config AND approved in the Discord Developer Portal.
  const effective: Record<string, boolean> = {};
  for (const key of ALL_INTENT_KEYS) {
    effective[key] = !PRIVILEGED_INTENT_KEYS.has(key);
  }

  for (const key of requiredKeys) {
    if (PRIVILEGED_INTENT_KEYS.has(key)) {
      effective[key] = portalEnabledPrivileged.has(key);
    }
  }

  return effective;
}

export function buildSafeFallbackIntentsMap(
  config: JsBotConfig,
  warnings?: string[],
  options: { cause?: string; lastKnown?: LastKnownPortalIntents } = {},
): Record<string, boolean> {
  const cause = options.cause ? ` (${options.cause})` : '';
  const head = `Could not sync intents from Discord Developer Portal${cause}`;
  if (options.lastKnown) {
    warnings?.push(
      `${head} — using last known intents read at ` +
        `${options.lastKnown.at.toISOString()}.`,
    );
    return buildEffectiveIntentsMap(config, options.lastKnown.enabled, warnings);
  }
  warnings?.push(`${head} — privileged intents disabled for this connection.`);
  return buildEffectiveIntentsMap(config, new Set(), warnings);
}

export function intentsMapsEqual(
  a: Record<string, boolean>,
  b: Record<string, boolean>,
): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if ((a[key] ?? false) !== (b[key] ?? false)) {
      return false;
    }
  }
  return true;
}
