import type { Guild, GuildMember, Interaction, Message } from 'discord.js';

import type { JsBotConfig } from '../config/js-bot-config.js';
import { normalizeScopedStorageKey, toScopedReferenceKey } from './variable-keys.js';
import type { VariableStore } from './variable-store.js';

export interface ScopedExecutionContext {
  interaction?: Interaction;
  message?: Message;
  guild?: Guild | null;
  member?: GuildMember | Interaction['member'] | Message['member'] | null;
  channel?: Interaction['channel'] | Message['channel'] | null;
}

export function findScopedVariableDefinition(
  config: JsBotConfig,
  key: string,
): { scope: string; key: string; defaultValue?: unknown } {
  const trimmed = key.trim();
  if (!trimmed) {
    throw new Error('Missing scoped variable key.');
  }

  const storageKey = normalizeScopedStorageKey(trimmed);
  const referenceKey = toScopedReferenceKey(storageKey);

  for (const entry of config.scopedVariableDefinitions) {
    const entryKey = normalizeScopedStorageKey(String(entry.key ?? '').trim());
    const entryRef = toScopedReferenceKey(entryKey);
    if (entryKey === storageKey || entryRef === referenceKey || entryKey === trimmed) {
      const scope = String(entry.scope ?? '').trim();
      if (!scope) {
        throw new Error(`Scoped variable "${trimmed}" has no scope configured.`);
      }
      return { scope, key: entryKey, defaultValue: entry['defaultValue'] };
    }
  }

  throw new Error(
    `Scoped variable "${trimmed}" is not defined. Add it in the Variables screen first.`,
  );
}

export interface DbTarget {
  /** Raw context id (user id, guild id, `guildId:userId`, message id, …). */
  contextId?: string;
  userId?: string;
  guildId?: string;
  channelId?: string;
  messageId?: string;
}

export interface DbListOptions extends DbTarget {
  /** Sort by stored value, user id, or raw context id. Default: `value`. */
  sort?: 'value' | 'userId' | 'contextId';
  /** Default: `desc` (highest value first — leaderboard order). */
  order?: 'asc' | 'desc';
  /** Max entries returned after sort (e.g. top 10 leaderboard). */
  limit?: number;
}

export function parseGuildMemberContextId(contextId: string): { guildId: string; userId: string } {
  const parts = contextId.split(':');
  return {
    guildId: parts[0] ?? '',
    userId: parts.length > 1 ? parts.slice(1).join(':') : '',
  };
}

export function resolveContextIdForScope(
  scope: string,
  executionCtx: ScopedExecutionContext,
  target?: DbTarget,
): string {
  if (target?.contextId?.trim()) {
    return target.contextId.trim();
  }

  const normalizedScope = scope.trim();
  switch (normalizedScope) {
    case 'user': {
      const userId = target?.userId?.trim() || resolveUserId(executionCtx);
      if (!userId) {
        throw new Error(
          'db: missing userId — pass { userId: "..." } or run inside a user context.',
        );
      }
      return userId;
    }
    case 'guild': {
      const guildId = target?.guildId?.trim() || resolveGuildId(executionCtx);
      if (!guildId) {
        throw new Error(
          'db: missing guildId — pass { guildId: "..." } or run inside a guild context.',
        );
      }
      return guildId;
    }
    case 'channel': {
      const channelId = target?.channelId?.trim() || resolveChannelId(executionCtx);
      if (!channelId) {
        throw new Error(
          'db: missing channelId — pass { channelId: "..." } or run inside a channel context.',
        );
      }
      return channelId;
    }
    case 'guildMember': {
      const guildId = target?.guildId?.trim() || resolveGuildId(executionCtx);
      const userId = target?.userId?.trim() || resolveUserId(executionCtx);
      if (!guildId || !userId) {
        throw new Error(
          'db: missing guildId/userId — pass { guildId, userId } or run inside a guild interaction.',
        );
      }
      return `${guildId}:${userId}`;
    }
    case 'message': {
      const messageId = target?.messageId?.trim() || executionCtx.message?.id;
      if (!messageId) {
        throw new Error(
          'db: missing messageId — pass { messageId: "..." } or run inside a message context.',
        );
      }
      return messageId;
    }
    default:
      throw new Error(`Unsupported scoped variable scope: ${normalizedScope}`);
  }
}

export function resolveScopedContextId(
  scope: string,
  ctx: ScopedExecutionContext,
): string {
  return resolveContextIdForScope(scope, ctx);
}

export function hasResolvableScopedContext(ctx: ScopedExecutionContext): boolean {
  return Boolean(resolveUserId(ctx) || resolveGuildId(ctx) || resolveChannelId(ctx) || ctx.message?.id);
}

export async function buildScriptVariables(
  botId: string,
  config: JsBotConfig,
  store: VariableStore,
  ctx: ScopedExecutionContext,
): Promise<Record<string, unknown>> {
  const runtimeGlobals = await store.getGlobalVariables(botId);
  const variables: Record<string, unknown> = {
    ...config.globalVariables,
    ...runtimeGlobals,
  };

  if (!hasResolvableScopedContext(ctx)) {
    return variables;
  }

  for (const definition of config.scopedVariableDefinitions) {
    const scope = String(definition.scope ?? '').trim();
    const storageKey = normalizeScopedStorageKey(String(definition.key ?? '').trim());
    if (!scope || !storageKey) {
      continue;
    }

    let contextId: string;
    try {
      contextId = resolveScopedContextId(scope, ctx);
    } catch {
      continue;
    }

    let value = await store.getScopedVariable(botId, scope, contextId, storageKey);
    if (value == null) {
      const legacyKey = toScopedReferenceKey(storageKey);
      if (legacyKey !== storageKey) {
        value = await store.getScopedVariable(botId, scope, contextId, legacyKey);
      }
    }
    if (value == null && definition['defaultValue'] != null) {
      value = definition['defaultValue'];
    }
    if (value != null) {
      applyVariableAlias(variables, storageKey, value);
    }
  }

  return variables;
}

export function applyVariableAlias(
  variables: Record<string, unknown>,
  storageKey: string,
  value: unknown,
): void {
  variables[storageKey] = value;
  const referenceKey = toScopedReferenceKey(storageKey);
  if (referenceKey !== storageKey) {
    variables[referenceKey] = value;
  }
  if (!storageKey.startsWith('bc_')) {
    variables[`bc_${storageKey}`] = value;
  }
}

function resolveUserId(ctx: ScopedExecutionContext): string | null {
  if (ctx.message?.author?.id) {
    return ctx.message.author.id;
  }
  if (ctx.interaction?.user?.id) {
    return ctx.interaction.user.id;
  }
  if (ctx.member && typeof ctx.member === 'object' && 'id' in ctx.member) {
    const id = (ctx.member as { id?: string }).id;
    if (id) {
      return id;
    }
  }
  return null;
}

function resolveGuildId(ctx: ScopedExecutionContext): string | null {
  if (ctx.guild?.id) {
    return ctx.guild.id;
  }
  if (ctx.interaction?.guildId) {
    return ctx.interaction.guildId;
  }
  if (ctx.message?.guildId) {
    return ctx.message.guildId;
  }
  return null;
}

function resolveChannelId(ctx: ScopedExecutionContext): string | null {
  if (ctx.message?.channelId) {
    return ctx.message.channelId;
  }
  if (ctx.interaction?.channelId) {
    return ctx.interaction.channelId;
  }
  if (ctx.channel && typeof ctx.channel === 'object' && 'id' in ctx.channel) {
    const id = (ctx.channel as { id?: string }).id;
    if (id) {
      return id;
    }
  }
  return null;
}
