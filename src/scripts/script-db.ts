import type { JsBotConfig } from '../config/js-bot-config.js';
import {
  applyVariableAlias,
  findScopedVariableDefinition,
  resolveContextIdForScope,
  parseGuildMemberContextId,
  type DbTarget,
  type DbListOptions,
  type ScopedExecutionContext,
} from '../runtime/scoped-context.js';
import { normalizeScopedStorageKey, toScopedReferenceKey } from '../runtime/variable-keys.js';
import type { VariableDatabase } from '../runtime/variable-database.js';

export type { DbTarget, DbListOptions };

export interface ScriptDbGlobalApi {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  has(key: string): Promise<boolean>;
}

/**
 * Persistent bot storage for JavaScript command scripts.
 *
 * Scoped keys must be declared in the Variables editor (same as workflow bots).
 *
 * @example
 * // Current interaction context (user who ran the command)
 * const coins = await db.get('coins');
 * await db.set('coins', Number(coins ?? 0) + 10);
 *
 * @example
 * // Explicit targets — works even in scheduled scripts
 * await db.set('coins', 100, { userId: '123456789' });
 * const guildScore = await db.get('score', { guildId: interaction.guildId });
 * const memberXp = await db.get('xp', { guildId: guild.id, userId: member.id });
 *
 * @example
 * // Leaderboard for a guild (guildMember-scoped key, sorted by value desc)
 * const board = await db.list('coins', {
 *   guildId: interaction.guildId,
 *   sort: 'value',
 *   order: 'desc',
 * });
 * // → { "userIdA": 120, "userIdB": 45, ... }
 *
 * @example
 * // Top 10 only
 * const top10 = await db.list('coins', { guildId: interaction.guildId, limit: 10 });
 */
export class ScriptDb {
  readonly global: ScriptDbGlobalApi;

  constructor(
    private readonly botId: string,
    private readonly config: JsBotConfig,
    private readonly store: VariableDatabase,
    private readonly ctx: ScopedExecutionContext,
    private readonly variables: Record<string, unknown>,
  ) {
    this.global = {
      get: (key) => this.getGlobal(key),
      set: (key, value) => this.setGlobal(key, value),
      delete: (key) => this.deleteGlobal(key),
      has: (key) => this.hasGlobal(key),
    };
  }

  async get(key: string, target?: DbTarget): Promise<unknown> {
    const definition = findScopedVariableDefinition(this.config, key);
    const contextId = resolveContextIdForScope(definition.scope, this.ctx, target);
    return this.readScopedValue(definition, contextId);
  }

  async set(key: string, value: unknown, target?: DbTarget): Promise<void> {
    const definition = findScopedVariableDefinition(this.config, key);
    const contextId = resolveContextIdForScope(definition.scope, this.ctx, target);
    await this.store.setScopedVariable(
      this.botId,
      definition.scope,
      contextId,
      definition.key,
      value,
    );
    if (this.isCurrentContext(definition.scope, contextId, target)) {
      applyVariableAlias(this.variables, definition.key, value);
    }
  }

  async delete(key: string, target?: DbTarget): Promise<void> {
    const definition = findScopedVariableDefinition(this.config, key);
    const contextId = resolveContextIdForScope(definition.scope, this.ctx, target);
    await this.store.removeScopedVariable(
      this.botId,
      definition.scope,
      contextId,
      definition.key,
    );
    if (this.isCurrentContext(definition.scope, contextId, target)) {
      this.removeVariableAlias(definition.key);
    }
  }

  /** Removes every stored value for this scoped key (all users/guilds/channels). */
  async reset(key: string): Promise<void> {
    const definition = findScopedVariableDefinition(this.config, key);
    await this.store.removeAllScopedValuesForKey(this.botId, definition.scope, definition.key);
    const legacyKey = toScopedReferenceKey(definition.key);
    if (legacyKey !== definition.key) {
      await this.store.removeAllScopedValuesForKey(this.botId, definition.scope, legacyKey);
    }
    this.removeVariableAlias(definition.key);
  }

  /** Returns true when a persisted value exists (defaults do not count). */
  async has(key: string, target?: DbTarget): Promise<boolean> {
    const definition = findScopedVariableDefinition(this.config, key);
    const contextId = resolveContextIdForScope(definition.scope, this.ctx, target);
    const value = await this.readStoredScopedValue(definition, contextId);
    return value !== undefined && value !== null;
  }

  /**
   * Lists stored values for a scoped key.
   *
   * - `user` scope → keys are user ids
   * - `guildMember` scope + `{ guildId }` → keys are user ids for that guild only
   * - Default sort: value descending (leaderboard order)
   */
  async list(key: string, options?: DbListOptions): Promise<Record<string, unknown>> {
    const definition = findScopedVariableDefinition(this.config, key);
    const contextIds = await this.collectContextIds(definition.key, definition.scope);

    const filterGuildId =
      options?.guildId?.trim() ||
      (definition.scope === 'guildMember' ? resolveGuildId(this.ctx) ?? undefined : undefined);
    const filterUserId = options?.userId?.trim();
    const filterChannelId = options?.channelId?.trim();

    const entries: Array<{
      outputKey: string;
      value: unknown;
      userId: string;
      contextId: string;
    }> = [];

    for (const contextId of contextIds) {
      const value = await this.readStoredScopedValue(definition, contextId);
      if (value === undefined || value === null) {
        continue;
      }

      const mapped = this.mapListEntry(definition.scope, contextId, {
        guildId: filterGuildId,
        userId: filterUserId,
        channelId: filterChannelId,
      });
      if (!mapped) {
        continue;
      }

      entries.push({
        outputKey: mapped.outputKey,
        value,
        userId: mapped.userId,
        contextId,
      });
    }

    const sortBy = options?.sort ?? 'value';
    const order = options?.order ?? 'desc';
    const direction = order === 'asc' ? 1 : -1;

    entries.sort((left, right) => {
      let cmp = 0;
      if (sortBy === 'value') {
        cmp = compareSortableValues(left.value, right.value);
      } else if (sortBy === 'userId') {
        cmp = left.userId.localeCompare(right.userId);
      } else {
        cmp = left.contextId.localeCompare(right.contextId);
      }
      if (cmp === 0) {
        cmp = left.userId.localeCompare(right.userId);
      }
      return cmp * direction;
    });

    const limit = normalizeListLimit(options?.limit);
    const limitedEntries = limit != null ? entries.slice(0, limit) : entries;

    const values: Record<string, unknown> = {};
    for (const entry of limitedEntries) {
      values[entry.outputKey] = entry.value;
    }
    return values;
  }

  private async collectContextIds(storageKey: string, scope: string): Promise<string[]> {
    const contextIds = new Set(
      await this.store.listContextIds(this.botId, scope, storageKey),
    );
    const legacyKey = toScopedReferenceKey(storageKey);
    if (legacyKey !== storageKey) {
      for (const contextId of await this.store.listContextIds(this.botId, scope, legacyKey)) {
        contextIds.add(contextId);
      }
    }
    return [...contextIds];
  }

  private mapListEntry(
    scope: string,
    contextId: string,
    filter: { guildId?: string; userId?: string; channelId?: string },
  ): { outputKey: string; userId: string } | null {
    switch (scope) {
      case 'guildMember': {
        const { guildId, userId } = parseGuildMemberContextId(contextId);
        if (!userId) {
          return null;
        }
        if (filter.guildId && guildId !== filter.guildId) {
          return null;
        }
        if (filter.userId && userId !== filter.userId) {
          return null;
        }
        return { outputKey: userId, userId };
      }
      case 'user': {
        if (filter.userId && contextId !== filter.userId) {
          return null;
        }
        return { outputKey: contextId, userId: contextId };
      }
      case 'guild': {
        if (filter.guildId && contextId !== filter.guildId) {
          return null;
        }
        return { outputKey: contextId, userId: contextId };
      }
      case 'channel': {
        if (filter.channelId && contextId !== filter.channelId) {
          return null;
        }
        return { outputKey: contextId, userId: contextId };
      }
      case 'message': {
        return { outputKey: contextId, userId: contextId };
      }
      default:
        return { outputKey: contextId, userId: contextId };
    }
  }

  async getGlobal(key: string): Promise<unknown> {
    const normalizedKey = key.trim();
    if (!normalizedKey) {
      throw new Error('db.global: missing key.');
    }
    const runtime = await this.store.getGlobalVariables(this.botId);
    if (normalizedKey in runtime) {
      return runtime[normalizedKey];
    }
    if (normalizedKey in this.config.globalVariables) {
      return this.config.globalVariables[normalizedKey];
    }
    return undefined;
  }

  async setGlobal(key: string, value: unknown): Promise<void> {
    const normalizedKey = key.trim();
    if (!normalizedKey) {
      throw new Error('db.global: missing key.');
    }
    await this.store.setGlobalVariable(this.botId, normalizedKey, value);
    this.variables[normalizedKey] = value;
  }

  async deleteGlobal(key: string): Promise<void> {
    const normalizedKey = key.trim();
    if (!normalizedKey) {
      throw new Error('db.global: missing key.');
    }
    await this.store.removeGlobalVariable(this.botId, normalizedKey);
    delete this.variables[normalizedKey];
  }

  async hasGlobal(key: string): Promise<boolean> {
    const normalizedKey = key.trim();
    if (!normalizedKey) {
      throw new Error('db.global: missing key.');
    }
    const runtime = await this.store.getGlobalVariables(this.botId);
    return normalizedKey in runtime;
  }

  private async readScopedValue(
    definition: { scope: string; key: string; defaultValue?: unknown },
    contextId: string,
  ): Promise<unknown> {
    const stored = await this.readStoredScopedValue(definition, contextId);
    if (stored == null && definition.defaultValue != null) {
      return definition.defaultValue;
    }
    return stored ?? undefined;
  }

  private async readStoredScopedValue(
    definition: { scope: string; key: string },
    contextId: string,
  ): Promise<unknown> {
    let value = await this.store.getScopedVariable(
      this.botId,
      definition.scope,
      contextId,
      definition.key,
    );
    if (value == null) {
      const legacyKey = toScopedReferenceKey(definition.key);
      if (legacyKey !== definition.key) {
        value = await this.store.getScopedVariable(
          this.botId,
          definition.scope,
          contextId,
          legacyKey,
        );
      }
    }
    return value ?? undefined;
  }

  private isCurrentContext(scope: string, contextId: string, target?: DbTarget): boolean {
    if (target && (target.contextId || target.userId || target.guildId || target.channelId || target.messageId)) {
      return false;
    }
    try {
      return resolveContextIdForScope(scope, this.ctx) === contextId;
    } catch {
      return false;
    }
  }

  private removeVariableAlias(storageKey: string): void {
    delete this.variables[storageKey];
    delete this.variables[normalizeScopedStorageKey(storageKey)];
    const referenceKey = toScopedReferenceKey(storageKey);
    if (referenceKey !== storageKey) {
      delete this.variables[referenceKey];
    }
  }
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

function compareSortableValues(left: unknown, right: unknown): number {
  const leftNum = coerceSortNumber(left);
  const rightNum = coerceSortNumber(right);
  if (leftNum != null && rightNum != null) {
    return leftNum - rightNum;
  }
  return String(left).localeCompare(String(right));
}

function coerceSortNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeListLimit(limit: number | undefined): number | null {
  if (limit == null) {
    return null;
  }
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error('db.list: limit must be a positive number.');
  }
  return Math.floor(limit);
}
