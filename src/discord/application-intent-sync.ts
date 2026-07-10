import type { JsBotConfig } from '../config/js-bot-config.js';
import { DiscordTokenUnauthorizedError } from './discord-auth-errors.js';
import { PRIVILEGED_INTENT_KEYS, resolveRequiredIntentKeys } from './intent-resolver.js';

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

export async function fetchPortalEnabledPrivilegedIntents(
  token: string,
): Promise<Set<string>> {
  // 1. Récupérer l'application actuelle
  const appResponse = await fetch('https://discord.com/api/v10/applications/@me', {
    headers: { Authorization: `Bot ${token}` },
  });

  if (!appResponse.ok) {
    if (appResponse.status === 401 || appResponse.status === 403) {
      throw new DiscordTokenUnauthorizedError(`Failed to fetch application flags (${appResponse.status})`);
    }
    throw new Error(`Failed to fetch application flags (${appResponse.status})`);
  }

  let app = (await appResponse.json()) as DiscordApplication;
  let flags = app.flags ?? 0;
  const enabled = new Set<string>();

  // Vérification des intents actifs (majeurs ou limités)
  if ((flags & APPLICATION_FLAG_GATEWAY_GUILD_MEMBERS) !== 0 || (flags & APPLICATION_FLAG_GATEWAY_GUILD_MEMBERS_LIMITED) !== 0) {
    enabled.add('Guild Members');
  }
  if ((flags & APPLICATION_FLAG_GATEWAY_PRESENCE) !== 0 || (flags & APPLICATION_FLAG_GATEWAY_PRESENCE_LIMITED) !== 0) {
    enabled.add('Guild Presence');
  }
  if ((flags & APPLICATION_FLAG_GATEWAY_MESSAGE_CONTENT) !== 0 || (flags & APPLICATION_FLAG_GATEWAY_MESSAGE_CONTENT_LIMITED) !== 0) {
    enabled.add('Message Content');
  }

  // Si au moins un intent est manquant
  if (enabled.size < 3) {
    // 2. Récupérer les infos de l'utilisateur (Bot) pour vérifier s'il est vérifié
    const userResponse = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bot ${token}` },
    });

    if (!userResponse.ok) {
      if (userResponse.status === 401 || userResponse.status === 403) {
        throw new DiscordTokenUnauthorizedError(`Failed to fetch user info (${userResponse.status})`);
      }
      throw new Error(`Failed to fetch user info (${userResponse.status})`);
    }

    const user = (await userResponse.json()) as DiscordApplication;
    const userFlags = user.flags ?? 0;

    // 1 << 16 correspond à USER_FLAG_VERIFIED_BOT
    if ((userFlags & (1 << 16)) !== 0) {
      throw new Error('Bot is verified, cannot enable privileged intents automatically. Please enable them in the Discord Developer Portal.');
    }

    // 3. COMBINAISON SÉCURISÉE DES FLAGS
    // On garde l'existant (flags) et on ajoute les versions LIMITED via l'opérateur binaire |
    const updatedFlags = flags |
      APPLICATION_FLAG_GATEWAY_GUILD_MEMBERS_LIMITED |
      APPLICATION_FLAG_GATEWAY_PRESENCE_LIMITED |
      APPLICATION_FLAG_GATEWAY_MESSAGE_CONTENT_LIMITED;

    const patchResponse = await fetch('https://discord.com/api/v10/applications/@me', {
      method: 'PATCH',
      headers: {
        Authorization: `Bot ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        flags: updatedFlags, // Envoi des flags combinés
      }),
    });

    if (!patchResponse.ok) {
      throw new Error(`Failed to update application flags via PATCH (${patchResponse.status})`);
    }

    // On remplit le set puisque la modification a réussi
    enabled.add('Guild Members');
    enabled.add('Guild Presence');
    enabled.add('Message Content');
  }

  return enabled;
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
