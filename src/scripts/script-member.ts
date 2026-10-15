import { PermissionsBitField } from 'discord.js';

/**
 * Quand la guilde n'est pas en cache (cache minimal du runner), discord.js
 * expose `interaction.member` sous la forme d'un APIInteractionGuildMember
 * BRUT : `permissions` y est une chaîne (bitfield décimal), donc
 * `member.permissions.has(...)` plante. Les scripts sont écrits « à la
 * discord.js » : on leur présente un vrai `PermissionsBitField`.
 */
function hasPermissionsApi(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { has?: unknown }).has === 'function'
  );
}

function toPermissionsBitField(raw: unknown): PermissionsBitField {
  try {
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'bigint') {
      const text = typeof raw === 'string' ? raw.trim() : raw;
      if (text !== '') {
        return new PermissionsBitField(BigInt(text)).freeze() as PermissionsBitField;
      }
    }
  } catch {
    // valeur illisible : traitée comme « aucune permission » (fail-closed)
  }
  return new PermissionsBitField(0n).freeze() as PermissionsBitField;
}

/**
 * Renvoie le membre tel quel s'il expose déjà `permissions.has` (GuildMember),
 * sinon un proxy non mutant dont `permissions` est un `PermissionsBitField`
 * (les autres propriétés — `roles`, `user`, … — restent celles du membre brut).
 */
export function normalizeScriptMember<M>(member: M): M {
  if (typeof member !== 'object' || member === null) {
    return member;
  }
  const raw = (member as { permissions?: unknown }).permissions;
  if (hasPermissionsApi(raw)) {
    return member;
  }
  const permissions = toPermissionsBitField(raw);
  return new Proxy(member as object, {
    get(target, property) {
      if (property === 'permissions') {
        return permissions;
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as M;
}

/** Surcharges que le runner applique à la vue « script » d'une interaction / d'un message. */
export interface ScriptViewOverrides {
  member?: unknown;
  guild?: unknown;
  channel?: unknown;
}

/**
 * Vue de `target` (interaction / message) dont `member`, `guild` et `channel`
 * sont ceux que le runner donne aux scripts (membre normalisé, guilde et salon
 * résolus à la demande). Le reste est délégué à l'objet d'origine, qui n'est
 * pas modifié. Une clé absente de `overrides` n'est pas surchargée.
 */
export function withScriptView<T extends object>(target: T, overrides: ScriptViewOverrides): T {
  if (!target) {
    return target;
  }
  const keys = (['member', 'guild', 'channel'] as const).filter(
    (key) =>
      key in overrides &&
      (key === 'member' ? overrides[key] !== undefined : overrides[key] != null) &&
      (target as Record<string, unknown>)[key] !== overrides[key],
  );
  if (keys.length === 0) {
    return target;
  }
  return new Proxy(target, {
    get(obj, property, receiver) {
      if (typeof property === 'string' && (keys as string[]).includes(property)) {
        return overrides[property as keyof ScriptViewOverrides];
      }
      return Reflect.get(obj, property, receiver);
    },
  });
}

/** Compat : vue dont seul `member` est surchargé. */
export function withScriptMember<T extends object>(target: T, member: unknown): T {
  return withScriptView(target, { member });
}

// ---------------------------------------------------------------------------
// Résolution de guild / channel hors cache
// ---------------------------------------------------------------------------

interface FetchableClient {
  guilds: {
    cache?: { get(id: string): unknown };
    fetch(id: string): Promise<unknown>;
  };
  channels: {
    cache?: { get(id: string): unknown };
    fetch(id: string): Promise<unknown>;
  };
}

interface FetchableGuild {
  members?: { me?: unknown; fetchMe?: () => Promise<unknown> };
}

/** Durée pendant laquelle un échec de fetch est mémorisé (évite une rafale REST). */
export const SCRIPT_FETCH_FAILURE_TTL_MS = 30_000;
const MAX_TRACKED_FAILURES = 200;

interface ResolverState {
  inflight: Map<string, Promise<unknown>>;
  failures: Map<string, number>;
}

// État par client : disparaît avec lui, et reste borné (inflight vidé à la fin
// de chaque fetch, échecs plafonnés + TTL).
const states = new WeakMap<object, ResolverState>();

function stateFor(client: object): ResolverState {
  let state = states.get(client);
  if (!state) {
    state = { inflight: new Map(), failures: new Map() };
    states.set(client, state);
  }
  return state;
}

/** Un seul fetch REST par clé en vol ; échec => `null`, mémorisé brièvement. */
async function fetchOnce<T>(
  client: object,
  key: string,
  run: () => Promise<T>,
  now: () => number,
): Promise<T | null> {
  const state = stateFor(client);
  const failedAt = state.failures.get(key);
  if (failedAt !== undefined) {
    if (now() - failedAt < SCRIPT_FETCH_FAILURE_TTL_MS) {
      return null;
    }
    state.failures.delete(key);
  }
  const pending = state.inflight.get(key);
  if (pending) {
    return (await pending) as T | null;
  }
  const task = (async () => {
    // laisse `inflight.set` s'exécuter avant tout `finally` (run() synchrone qui lève)
    await Promise.resolve();
    try {
      return (await run()) ?? null;
    } catch {
      if (state.failures.size >= MAX_TRACKED_FAILURES) {
        const oldest = state.failures.keys().next().value;
        if (oldest !== undefined) state.failures.delete(oldest);
      }
      state.failures.set(key, now());
      return null;
    } finally {
      state.inflight.delete(key);
    }
  })();
  state.inflight.set(key, task);
  return (await task) as T | null;
}

export interface ScriptGuildChannel {
  guild: unknown;
  channel: unknown;
}

/**
 * Résout `guild` et `channel` d'une interaction / d'un message comme le ferait
 * discord.js avec un cache complet : cache d'abord (aucun appel REST s'il y
 * est), sinon un seul fetch par type. Jamais d'exception : `null` en cas
 * d'échec (guilde inaccessible…) ou d'absence (DM : `guild` reste `null`).
 * Si la guilde est connue mais que le membre du bot n'est pas en cache,
 * `guild.members.me` est rempli par `fetchMe()` (un fetch, mis en cache).
 */
export async function resolveScriptGuildChannel(
  client: unknown,
  source: { guild?: unknown; channel?: unknown; guildId?: unknown; channelId?: unknown } | undefined,
  now: () => number = Date.now,
): Promise<ScriptGuildChannel> {
  let guild: unknown = source?.guild ?? null;
  let channel: unknown = source?.channel ?? null;
  if (!source || !client || typeof client !== 'object') {
    return { guild, channel };
  }
  const c = client as FetchableClient;
  const guildId = typeof source.guildId === 'string' ? source.guildId : null;
  const channelId = typeof source.channelId === 'string' ? source.channelId : null;

  const guildTask = async () => {
    if (guild || !guildId) return;
    guild = c.guilds?.cache?.get(guildId) ?? null;
    if (!guild && typeof c.guilds?.fetch === 'function') {
      guild = await fetchOnce(c, `g:${guildId}`, () => c.guilds.fetch(guildId), now);
    }
  };
  const channelTask = async () => {
    if (channel || !channelId) return;
    channel = c.channels?.cache?.get(channelId) ?? null;
    if (!channel && typeof c.channels?.fetch === 'function') {
      channel = await fetchOnce(c, `c:${channelId}`, () => c.channels.fetch(channelId), now);
    }
  };
  await Promise.all([guildTask(), channelTask()]);

  const members = (guild as FetchableGuild | null)?.members;
  if (guildId && members && !members.me && typeof members.fetchMe === 'function') {
    await fetchOnce(c, `m:${guildId}`, () => members.fetchMe!(), now);
  }
  return { guild, channel };
}
