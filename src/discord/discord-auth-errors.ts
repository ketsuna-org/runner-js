export class DiscordTokenUnauthorizedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DiscordTokenUnauthorizedError';
  }
}

// --- Discord indisponible (blocage d'IP ou limite) --------------------------------------------
// Contrat Manager : `discord_temporarily_blocked` = blocage de l'IP de sortie (toute la
// plateforme) ; `discord_rate_limited` = limite d'UN jeton (globale 50 req/s) ou d'une route.

export type DiscordUnavailableKind = 'blocked' | 'rate_limited';

const DEFAULT_RETRY_AFTER_SECONDS = 60;
const MAX_RETRY_AFTER_SECONDS = 600;

/** Entier de secondes >= 1, 60 par défaut, plafonné à 10 min (même borne que le Manager). */
export function clampRetryAfterSeconds(seconds: number | null | undefined): number {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) {
    return DEFAULT_RETRY_AFTER_SECONDS;
  }
  return Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(1, Math.ceil(seconds)));
}

/** Ne porte jamais le jeton ni un corps de réponse. */
export class DiscordUnavailableError extends Error {
  readonly retryAfterSeconds: number;

  constructor(
    public readonly kind: DiscordUnavailableKind,
    retryAfterSeconds?: number | null,
    options?: { cause?: unknown },
  ) {
    const retry = clampRetryAfterSeconds(retryAfterSeconds);
    super(
      kind === 'blocked'
        ? `Discord is temporarily blocking requests from this network (retry after ${retry}s)`
        : `Discord is rate limiting this bot (retry after ${retry}s)`,
      options,
    );
    this.name = 'DiscordUnavailableError';
    this.retryAfterSeconds = retry;
  }

  get code(): 'discord_temporarily_blocked' | 'discord_rate_limited' {
    return this.kind === 'blocked' ? 'discord_temporarily_blocked' : 'discord_rate_limited';
  }
}

/** Le strict nécessaire d'un Headers (celui de undici, de Bun ou d'un ResponseLike). */
export type HeadersLike = {
  get(name: string): string | null;
  forEach(callback: (value: string, name: string) => void): void;
};

export type Discord429Class = 'ip-block' | 'token-global' | 'rate-limit';

const IP_BLOCK_TEXT_PATTERNS = ['you are being blocked', 'error code: 1015'];

export function isDiscordIpBlockText(text: string | null | undefined): boolean {
  const normalized = (text ?? '').toLowerCase();
  return IP_BLOCK_TEXT_PATTERNS.some((pattern) => normalized.includes(pattern));
}

function hasRateLimitHeader(headers: HeadersLike): boolean {
  let found = false;
  headers.forEach((_value, name) => {
    if (name.toLowerCase().startsWith('x-ratelimit-')) found = true;
  });
  return found;
}

function isJsonContentType(contentType: string | null): boolean {
  return (contentType ?? '').toLowerCase().includes('json');
}

/**
 * Classe un 429 de Discord (fonction pure). Prudente : dans le doute, c'est une limite
 * ordinaire ('rate-limit'), jamais un blocage d'IP.
 *  1. 'ip-block' : texte « you are being blocked » / « error code: 1015 », ou Content-Type
 *     présent et non JSON SANS aucun en-tête X-RateLimit-* (page Cloudflare), sauf si le corps
 *     est tout de même celui de Discord (objet JSON avec `retry_after` numérique ou `global`
 *     booléen) : c'est alors une vraie limite de débit (même règle que le Manager).
 *  2. 'token-global' : limite globale d'un seul jeton (X-RateLimit-Global: true,
 *     X-RateLimit-Scope: global ou `"global": true` dans le JSON).
 *  3. 'rate-limit' : tout le reste.
 */
export function classifyDiscord429(input: {
  headers: HeadersLike;
  bodyText?: string | null;
}): Discord429Class {
  const { headers } = input;
  const bodyText = input.bodyText ?? '';
  if (isDiscordIpBlockText(bodyText)) return 'ip-block';

  const parsed = parseJsonObject(bodyText);
  const contentType = headers.get('content-type');
  if (contentType != null && !isJsonContentType(contentType) && !hasRateLimitHeader(headers)) {
    const discordShaped =
      parsed != null &&
      ((typeof parsed.retry_after === 'number' && Number.isFinite(parsed.retry_after)) ||
        typeof parsed.global === 'boolean');
    if (!discordShaped) return 'ip-block';
  }

  if (
    (headers.get('x-ratelimit-global') ?? '').trim().toLowerCase() === 'true' ||
    (headers.get('x-ratelimit-scope') ?? '').trim().toLowerCase() === 'global'
  ) {
    return 'token-global';
  }
  if (parsed?.global === true) return 'token-global';

  return 'rate-limit';
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Retry-After (en-tête, puis `retry_after` du JSON) en secondes, ou null. */
export function discord429RetryAfterSeconds(input: {
  headers: HeadersLike;
  bodyText?: string | null;
}): number | null {
  const header = input.headers.get('retry-after');
  if (header != null && header.trim() !== '') {
    const value = Number(header.trim());
    if (Number.isFinite(value) && value >= 0) return value;
  }
  const retry = parseJsonObject(input.bodyText ?? '')?.retry_after;
  return typeof retry === 'number' && Number.isFinite(retry) && retry >= 0 ? retry : null;
}

// Blocage d'IP : état du processus (tous les bots du runner partagent l'IP de sortie).
// Armé uniquement par un signal de blocage d'IP, jamais par une limite de jeton.
let ipBlockedUntilMs = 0;

/** Arme (ou prolonge) le blocage ; renvoie la durée retenue en secondes. */
export function armDiscordIpBlock(
  retryAfterSeconds: number | null | undefined,
  nowMs: number = Date.now(),
): number {
  const seconds = clampRetryAfterSeconds(retryAfterSeconds);
  ipBlockedUntilMs = Math.max(ipBlockedUntilMs, nowMs + seconds * 1000);
  return seconds;
}

export function discordIpBlockRemainingMs(nowMs: number = Date.now()): number {
  return Math.max(0, ipBlockedUntilMs - nowMs);
}

export function clearDiscordIpBlock(): void {
  ipBlockedUntilMs = 0;
}

/**
 * Erreur typée « Discord indisponible » pour un échec de connexion : l'erreur elle-même, ou
 * le `RateLimitError` de discord.js (message vide) converti. null si ce n'est pas le cas.
 */
export function asDiscordUnavailable(error: unknown): DiscordUnavailableError | null {
  if (error instanceof DiscordUnavailableError) return error;
  // `name` vaut « RateLimitError[/gateway/bot] » : la route est ajoutée au nom.
  if (error instanceof Error && error.name.startsWith('RateLimitError')) {
    const { retryAfter, timeToReset } = error as Error & {
      retryAfter?: unknown;
      timeToReset?: unknown;
    };
    const ms = [retryAfter, timeToReset].find(
      (value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0,
    );
    return new DiscordUnavailableError(
      'rate_limited',
      ms != null ? Math.ceil(ms / 1000) : null,
      { cause: error },
    );
  }
  return null;
}

const GATEWAY_FATAL_CLOSE_CODES = new Set([
  4004, // authentication failed
  4010, // invalid shard
  4011, // sharding required
  4012, // invalid api version
  4013, // invalid intents
]);

const GATEWAY_DISALLOWED_INTENTS_CODE = 4014;

export function isDiscordGatewayDisallowedIntentsClose(
  code: number | null | undefined,
  reason?: string | null,
): boolean {
  if (code === GATEWAY_DISALLOWED_INTENTS_CODE) {
    return true;
  }

  const normalized = (reason ?? '').toLowerCase();
  return normalized.includes('disallowed intent');
}

export function formatGatewayCloseMessage(
  code: number | null | undefined,
  reason?: string | null,
): string {
  if (isDiscordGatewayDisallowedIntentsClose(code, reason)) {
    return (
      'Disallowed intents (4014) — enable the required intents in ' +
      'Discord Developer Portal → Bot → Privileged Gateway Intents'
    );
  }

  if (code != null && GATEWAY_FATAL_CLOSE_CODES.has(code)) {
    return `Gateway disconnected (code=${code})`;
  }

  if (code != null) {
    return `Gateway disconnected (code=${code})`;
  }

  return reason?.trim() || 'Gateway disconnected';
}

export function isDiscordGatewayFatalClose(
  code: number | null | undefined,
  reason?: string | null,
): boolean {
  if (isDiscordGatewayDisallowedIntentsClose(code, reason)) {
    return false;
  }

  if (code != null && GATEWAY_FATAL_CLOSE_CODES.has(code)) {
    return true;
  }

  const normalized = (reason ?? '').toLowerCase();
  if (!normalized) {
    return false;
  }

  if (
    normalized.includes('invalid intent') ||
    normalized.includes('authentication failed')
  ) {
    return true;
  }

  for (const fatalCode of GATEWAY_FATAL_CLOSE_CODES) {
    if (
      normalized.includes(String(fatalCode)) &&
      (normalized.includes('disconnect') ||
        normalized.includes('close') ||
        normalized.includes('gateway') ||
        normalized.includes('auth'))
    ) {
      return true;
    }
  }

  return false;
}

export function isDiscordTokenUnauthorized(error: unknown): boolean {
  if (error instanceof DiscordTokenUnauthorizedError) {
    return true;
  }
  // Un blocage d'IP ou une limite n'invalide pas le jeton (même si le texte contient « 4013 »).
  if (error instanceof DiscordUnavailableError) {
    return false;
  }

  const message = error instanceof Error ? error.message : String(error);
  if (isDiscordIpBlockText(message)) {
    return false;
  }
  const normalized = message.toLowerCase();

  if (normalized.includes('discord_token_invalid')) {
    return true;
  }

  if (isDiscordGatewayDisallowedIntentsClose(null, message)) {
    return true;
  }

  if (isDiscordGatewayFatalClose(null, message)) {
    return true;
  }

  const hasAuthStatus = normalized.includes('401') || normalized.includes('403');
  const hasUnauthorized =
    normalized.includes('unauthorized') || normalized.includes('forbidden');
  const mentionsDiscordApi =
    normalized.includes('discord.com/api') ||
    normalized.includes('applications/@me') ||
    normalized.includes('/applications/');

  if (hasAuthStatus && (hasUnauthorized || mentionsDiscordApi)) {
    return true;
  }

  const gatewayAuthCodes = ['4004', '4010', '4011', '4012', '4013', '4014'];
  for (const code of gatewayAuthCodes) {
    if (
      normalized.includes(code) &&
      (normalized.includes('disconnect') ||
        normalized.includes('close') ||
        normalized.includes('gateway') ||
        normalized.includes('auth'))
    ) {
      return true;
    }
  }

  return false;
}

export function throwIfDiscordTokenUnauthorized(error: unknown, context?: string): never {
  if (!isDiscordTokenUnauthorized(error)) {
    throw error;
  }

  const prefix = context ? `${context}: ` : '';
  const message = error instanceof Error ? error.message : String(error);
  throw new DiscordTokenUnauthorizedError(`${prefix}${message}`, { cause: error });
}
