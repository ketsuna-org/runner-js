import {
  DefaultRestOptions,
  GatewayIntentBits,
  Options,
  type Client,
  type ClientOptions,
  type RESTOptions,
} from 'discord.js';

import {
  DiscordUnavailableError,
  armDiscordIpBlock,
  classifyDiscord429,
  discord429RetryAfterSeconds,
  discordIpBlockRemainingMs,
} from './discord-auth-errors.js';
import { mapIntents } from './intent-mapper.js';

/** Valeurs explicites (celles de discord.js 14 pour le délai) : plus de dépendance silencieuse au défaut. */
export const DISCORD_REST_TIMEOUT_MS = 15_000;
/** Réessais REST pour les 5xx et délais dépassés seulement : un 429 n'en consomme jamais. */
export const DISCORD_REST_RETRIES = 1;

/**
 * Routes de la connexion : un 429 y fait échouer l'appel tout de suite (RateLimitError) au lieu
 * d'attendre le Retry-After sans plafond (le login attendait, puis retombait en 500).
 */
export function isLoginCriticalRoute(route: string): boolean {
  return route.startsWith('/gateway') || route === '/applications/@me';
}

type MakeRequest = RESTOptions['makeRequest'];

/**
 * Enveloppe le transport REST de discord.js :
 *  - un 429 de type blocage d'IP (voir classifyDiscord429) arme le blocage du processus et
 *    échoue tout de suite (discord.js le réessaierait sans attente, Retry-After absent) ;
 *  - tant que le blocage dure, plus aucune requête ne part.
 * Les autres 429 (limite de jeton ou de route) ne sont pas touchés : discord.js les gère.
 */
export function createGuardedMakeRequest(base: MakeRequest): MakeRequest {
  return async (url, init) => {
    const remainingMs = discordIpBlockRemainingMs();
    if (remainingMs > 0) {
      throw new DiscordUnavailableError('blocked', remainingMs / 1000);
    }

    const response = await base(url, init);
    if (response.status !== 429) {
      return response;
    }

    const body = await response.arrayBuffer();
    const signals = {
      headers: response.headers,
      bodyText: new TextDecoder().decode(body.slice(0, 4096)),
    };
    if (classifyDiscord429(signals) === 'ip-block') {
      const seconds = armDiscordIpBlock(discord429RetryAfterSeconds(signals));
      throw new DiscordUnavailableError('blocked', seconds);
    }
    // Le corps a été consommé pour le classer : discord.js le relit depuis une copie.
    const headers = new Headers();
    response.headers.forEach((value, name) => headers.append(name, value));
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    }) as unknown as Awaited<ReturnType<MakeRequest>>;
  };
}

function keepClientUser<T extends { id: string; client: { user?: { id: string } | null } }>(
  entry: T,
): boolean {
  return entry.id === entry.client.user?.id;
}

/**
 * Builds discord.js Client options with minimal in-memory caches.
 * Cache limits are intent-aware so we only retain data the bot can receive,
 * except GuildMemberManager which keeps a small cache so MESSAGE_CREATE
 * partial members remain resolvable via message.member.
 *
 * The bot's own GuildMember / VoiceState are always kept — discord.js only
 * forwards VOICE_STATE_UPDATE to @discordjs/voice when the bot member is
 * present in cache; otherwise joins stay stuck in signalling.
 *
 * Note: GuildManager / GuildChannelManager cannot be limited via cacheWithLimits
 * in current discord.js (typed as TODO) — guild/channel growth is mitigated by
 * the pod cgroup memory limit (OOMKill) instead.
 */
export function buildDiscordClientOptions(
  intentsMap: Record<string, boolean>,
  /** Transport de base, remplaçable en test. */
  baseMakeRequest: MakeRequest = DefaultRestOptions.makeRequest,
): ClientOptions {
  const hasGuildMembers = Boolean(intentsMap['Guild Members']);
  const hasVoiceStates = Boolean(intentsMap['Guild Voice States']);
  const hasPresences = Boolean(intentsMap['Guild Presence'] || intentsMap['Guild Presences']);

  return {
    intents: mapIntents(intentsMap),
    rest: {
      timeout: DISCORD_REST_TIMEOUT_MS,
      retries: DISCORD_REST_RETRIES,
      rejectOnRateLimit: (data) => isLoginCriticalRoute(data.route),
      makeRequest: createGuardedMakeRequest(baseMakeRequest),
    },
    makeCache: Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,
      ApplicationCommandManager: 0,
      AutoModerationRuleManager: 0,
      BaseGuildEmojiManager: 0,
      DMMessageManager: 0,
      GuildBanManager: 0,
      GuildEmojiManager: 0,
      GuildForumThreadManager: 0,
      GuildInviteManager: 0,
      // Keep a small member cache even without Guild Members intent so
      // MESSAGE_CREATE partial members remain resolvable via message.member.
      // Always retain the bot's own member for voice adapter wiring.
      GuildMemberManager: {
        maxSize: 25,
        keepOverLimit: keepClientUser,
      },
      GuildScheduledEventManager: 0,
      GuildStickerManager: 0,
      GuildTextThreadManager: 25,
      MessageManager: 0,
      // member.presence reads this cache: with the Guild Presence intent a
      // zero-size cache makes every member look offline with no activities.
      PresenceManager: hasPresences ? 200 : 0,
      ReactionManager: 0,
      StageInstanceManager: 0,
      ThreadManager: 25,
      ThreadMemberManager: 0,
      UserManager: 0,
      VoiceStateManager: hasVoiceStates
        ? {
            maxSize: 50,
            keepOverLimit: keepClientUser,
          }
        : 0,
    }),
    sweepers: {
      ...Options.DefaultSweeperSettings,
      messages: { interval: 300, lifetime: 300 },
      threads: { interval: 300, lifetime: 600 },
      users: {
        interval: 300,
        filter: () => (user) => user.id !== user.client.user?.id,
      },
      ...(hasGuildMembers
        ? {
            guildMembers: {
              interval: 300,
              filter: () => (member) => member.id !== member.client.user?.id,
            },
          }
        : {}),
    },
  };
}

export function clientHasGuildVoiceStatesIntent(client: Client): boolean {
  const intents = client.options.intents;
  if (intents == null) {
    return false;
  }
  if (typeof (intents as { has?: (bit: number) => boolean }).has === 'function') {
    return (intents as { has: (bit: number) => boolean }).has(GatewayIntentBits.GuildVoiceStates);
  }
  const bits = Array.isArray(intents)
    ? intents.reduce<number>((acc, bit) => acc | Number(bit), 0)
    : Number(intents);
  return (bits & GatewayIntentBits.GuildVoiceStates) !== 0;
}
