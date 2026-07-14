export class DiscordTokenUnauthorizedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DiscordTokenUnauthorizedError';
  }
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

  const message = error instanceof Error ? error.message : String(error);
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
