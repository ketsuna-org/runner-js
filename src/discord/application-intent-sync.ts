import type { JsBotConfig } from '../config/js-bot-config.js';
import { DiscordTokenUnauthorizedError } from './discord-auth-errors.js';
import { PRIVILEGED_INTENT_KEYS, resolveRequiredIntentKeys } from './intent-resolver.js';

// Business logic mirrored in bot-creator-shared `application_intent_sync.dart`.
const APPLICATION_FLAG_GATEWAY_PRESENCE_LIMITED = 1 << 12;
const APPLICATION_FLAG_GATEWAY_PRESENCE = 1 << 13;
const APPLICATION_FLAG_GATEWAY_GUILD_MEMBERS_LIMITED = 1 << 14;
const APPLICATION_FLAG_GATEWAY_GUILD_MEMBERS = 1 << 15;
const APPLICATION_FLAG_GATEWAY_MESSAGE_CONTENT_LIMITED = 1 << 18;
const APPLICATION_FLAG_GATEWAY_MESSAGE_CONTENT = 1 << 19;

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

export async function fetchPortalEnabledPrivilegedIntents(
  token: string,
): Promise<PortalPrivilegedIntentSyncResult> {
  const appResponse = await fetch('https://discord.com/api/v10/applications/@me', {
    headers: { Authorization: `Bot ${token}` },
  });

  if (!appResponse.ok) {
    if (appResponse.status === 401 || appResponse.status === 403) {
      throw new DiscordTokenUnauthorizedError(
        `Failed to fetch application flags (${appResponse.status})`,
      );
    }
    throw new Error(`Failed to fetch application flags (${appResponse.status})`);
  }

  const app = (await appResponse.json()) as DiscordApplication;
  const flags = app.flags ?? 0;
  const enabled = portalEnabledPrivilegedIntentsFromFlags(flags);

  return { enabled, didAutoEnable: false };
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
  return Boolean(config.prefix?.trim());
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

  const effective: Record<string, boolean> = {};
  for (const key of ALL_INTENT_KEYS) {
    effective[key] = false;
  }
  effective.Guilds = true;

  for (const key of requiredKeys) {
    if (PRIVILEGED_INTENT_KEYS.has(key)) {
      effective[key] = portalEnabledPrivileged.has(key);
    } else {
      effective[key] = true;
    }
  }

  return effective;
}

export function buildSafeFallbackIntentsMap(
  config: JsBotConfig,
  warnings?: string[],
): Record<string, boolean> {
  warnings?.push(
    'Could not sync intents from Discord Developer Portal — ' +
      'privileged intents disabled for this connection.',
  );
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
