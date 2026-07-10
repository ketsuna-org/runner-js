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
const USER_FLAG_VERIFIED_BOT = 1 << 16;

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

type DiscordUser = {
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

  if (enabled.size >= PRIVILEGED_INTENT_KEYS.size) {
    return { enabled, didAutoEnable: false };
  }

  const userResponse = await fetch('https://discord.com/api/v10/users/@me', {
    headers: { Authorization: `Bot ${token}` },
  });

  if (!userResponse.ok) {
    if (userResponse.status === 401 || userResponse.status === 403) {
      throw new DiscordTokenUnauthorizedError(
        `Failed to fetch user info (${userResponse.status})`,
      );
    }
    throw new Error(`Failed to fetch user info (${userResponse.status})`);
  }

  const user = (await userResponse.json()) as DiscordUser;
  const userFlags = user.flags ?? 0;

  if ((userFlags & USER_FLAG_VERIFIED_BOT) !== 0) {
    throw new PortalIntentAutoEnableError();
  }

  const hasMembers = enabled.has('Guild Members');
  const hasPresence = enabled.has('Guild Presence');
  const hasMessageContent = enabled.has('Message Content');

  let patchFlags = flags;
  if (!hasMembers) {
    patchFlags |= APPLICATION_FLAG_GATEWAY_GUILD_MEMBERS_LIMITED;
  }
  if (!hasPresence) {
    patchFlags |= APPLICATION_FLAG_GATEWAY_PRESENCE_LIMITED;
  }
  if (!hasMessageContent) {
    patchFlags |= APPLICATION_FLAG_GATEWAY_MESSAGE_CONTENT_LIMITED;
  }

  if (patchFlags === flags) {
    return { enabled, didAutoEnable: false };
  }

  const patchResponse = await fetch('https://discord.com/api/v10/applications/@me', {
    method: 'PATCH',
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ flags: patchFlags }),
  });

  if (patchResponse.status === 401) {
    throw new DiscordTokenUnauthorizedError(
      `Failed to update application flags via PATCH (${patchResponse.status})`,
    );
  }

  if (!patchResponse.ok) {
    throw new PortalIntentPatchFailedError(patchResponse.status);
  }

  return {
    enabled: new Set(PRIVILEGED_INTENT_KEYS),
    didAutoEnable: true,
  };
}

export function buildPortalIntentsMap(portalEnabledPrivileged: Set<string>): Record<string, boolean> {
  const intents: Record<string, boolean> = {};
  for (const key of ALL_INTENT_KEYS) {
    intents[key] = !PRIVILEGED_INTENT_KEYS.has(key);
  }
  for (const key of portalEnabledPrivileged) {
    intents[key] = true;
  }
  return intents;
}

function configEventNames(config: JsBotConfig): string[] {
  return (config.events ?? []).map((event) => event.name);
}

export function buildEffectiveIntentsMap(
  config: JsBotConfig,
  portalEnabledPrivileged: Set<string>,
  warnings?: string[],
): Record<string, boolean> {
  const portalMap = buildPortalIntentsMap(portalEnabledPrivileged);
  const requiredKeys = resolveRequiredIntentKeys({
    eventNames: configEventNames(config),
    hasLegacyCommands: false,
    approvedPrivilegedIntents: portalEnabledPrivileged,
    warnings,
  });

  const effective = { ...portalMap };
  for (const key of PRIVILEGED_INTENT_KEYS) {
    effective[key] = requiredKeys.has(key) && portalEnabledPrivileged.has(key);
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
