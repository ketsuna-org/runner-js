export class DiscordTokenUnauthorizedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DiscordTokenUnauthorizedError';
  }
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
