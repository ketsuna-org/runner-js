import type { JsBotConfig } from '../config/js-bot-config.js';
import {
  applyVariableAlias,
  ensureScopedVariableDefinition,
  findScopedVariableDefinition,
  parseGuildMemberContextId,
  resolveContextIdForScope,
  type DbTarget,
  type ScopedExecutionContext,
} from '../runtime/scoped-context.js';
import { normalizeScopedStorageKey, toScopedReferenceKey } from '../runtime/variable-keys.js';
import type { VariableDatabase } from '../runtime/variable-database.js';

export type DbScopeNamespace = 'user' | 'guild' | 'channel' | 'message';

export interface DbListEntry {
  id: string;
  value: unknown;
}

export interface DbFindEntry {
  key: string;
  id: string;
  value: unknown;
}

export interface ScriptDbGlobalApi {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface ScriptDbScopedApi {
  set(key: string, value: unknown, id?: string): Promise<void>;
  get(key: string, id?: string): Promise<unknown>;
  delete(key: string, id?: string): Promise<void>;
  list(
    key: string,
    order?: 'asc' | 'desc',
    limit?: number,
    offset?: number,
    filter?: (entry: DbListEntry) => boolean,
  ): Promise<DbListEntry[]>;
  find(filter?: (entry: DbFindEntry) => boolean): Promise<DbFindEntry[]>;
}

/**
 * Persistent bot storage for JavaScript scripts.
 *
 * @example
 * await db.user.set('coins', 10);
 * const coins = await db.user.get('coins');
 *
 * @example
 * await db.global.set('counter', 1);
 * const top = await db.user.list('coins', 'desc', 10, 0);
 */
export class ScriptDb {
  readonly global: ScriptDbGlobalApi;
  readonly user: ScriptDbScopedApi;
  readonly guild: ScriptDbScopedApi;
  readonly channel: ScriptDbScopedApi;
  readonly message: ScriptDbScopedApi;

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
    };
    this.user = this.createScopedApi('user');
    this.guild = this.createScopedApi('guild');
    this.channel = this.createScopedApi('channel');
    this.message = this.createScopedApi('message');
  }

  private createScopedApi(namespace: DbScopeNamespace): ScriptDbScopedApi {
    return {
      set: (key, value, id) => this.setScoped(namespace, key, value, id),
      get: (key, id) => this.getScoped(namespace, key, id),
      delete: (key, id) => this.deleteScoped(namespace, key, id),
      list: (key, order, limit, offset, filter) =>
        this.listScoped(namespace, key, order, limit, offset, filter),
      find: (filter) => this.findScoped(namespace, filter),
    };
  }

  private resolveStorageScope(namespace: DbScopeNamespace): string {
    if (namespace === 'user' && resolveGuildId(this.ctx)) {
      return 'guildMember';
    }
    return namespace;
  }

  private targetForId(namespace: DbScopeNamespace, id?: string): DbTarget | undefined {
    const trimmed = id?.trim();
    if (!trimmed) {
      return undefined;
    }
    switch (namespace) {
      case 'user':
        return { userId: trimmed };
      case 'guild':
        return { guildId: trimmed };
      case 'channel':
        return { channelId: trimmed };
      case 'message':
        return { messageId: trimmed };
      default:
        return undefined;
    }
  }

  private async setScoped(
    namespace: DbScopeNamespace,
    key: string,
    value: unknown,
    id?: string,
  ): Promise<void> {
    const scope = this.resolveStorageScope(namespace);
    const definition = ensureScopedVariableDefinition(this.config, key, scope);
    const target = this.targetForId(namespace, id);
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

  private async getScoped(
    namespace: DbScopeNamespace,
    key: string,
    id?: string,
  ): Promise<unknown> {
    const scope = this.resolveStorageScope(namespace);
    let definition: { scope: string; key: string; defaultValue?: unknown };
    try {
      definition = findScopedVariableDefinition(this.config, key);
      if (definition.scope !== scope) {
        definition = ensureScopedVariableDefinition(this.config, key, scope);
      }
    } catch {
      definition = ensureScopedVariableDefinition(this.config, key, scope);
    }
    const target = this.targetForId(namespace, id);
    const contextId = resolveContextIdForScope(definition.scope, this.ctx, target);
    return this.readScopedValue(definition, contextId);
  }

  private async deleteScoped(
    namespace: DbScopeNamespace,
    key: string,
    id?: string,
  ): Promise<void> {
    const scope = this.resolveStorageScope(namespace);
    const definition = findScopedVariableDefinition(this.config, key);
    if (definition.scope !== scope) {
      throw new Error(`Scoped variable "${key.trim()}" is not stored under ${namespace}.`);
    }
    const target = this.targetForId(namespace, id);
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

  private async listScoped(
    namespace: DbScopeNamespace,
    key: string,
    order: 'asc' | 'desc' = 'desc',
    limit?: number,
    offset = 0,
    filter?: (entry: DbListEntry) => boolean,
  ): Promise<DbListEntry[]> {
    const scope = this.resolveStorageScope(namespace);
    let definition: { scope: string; key: string };
    try {
      definition = findScopedVariableDefinition(this.config, key);
    } catch {
      definition = ensureScopedVariableDefinition(this.config, key, scope);
    }

    const contextIds = await this.collectContextIds(definition.key, definition.scope);
    const entries: DbListEntry[] = [];

    for (const contextId of contextIds) {
      const value = await this.readStoredScopedValue(definition, contextId);
      if (value === undefined || value === null) {
        continue;
      }
      const mapped = this.mapListEntry(definition.scope, contextId, namespace);
      if (!mapped) {
        continue;
      }
      entries.push({ id: mapped, value });
    }

    entries.sort((left, right) => {
      const cmp = compareSortableValues(left.value, right.value);
      return (order === 'asc' ? 1 : -1) * cmp;
    });

    const filtered = typeof filter === 'function' ? entries.filter(filter) : entries;
    const normalizedOffset = normalizeNonNegativeInt(offset, 'offset');
    const normalizedLimit = limit == null ? undefined : normalizePositiveInt(limit, 'limit');
    const sliced = filtered.slice(normalizedOffset);
    return normalizedLimit == null ? sliced : sliced.slice(0, normalizedLimit);
  }

  private async findScoped(
    namespace: DbScopeNamespace,
    filter?: (entry: DbFindEntry) => boolean,
  ): Promise<DbFindEntry[]> {

    const scope = this.resolveStorageScope(namespace);
    const scopesToScan =
      namespace === 'user' && scope === 'guildMember'
        ? ['guildMember']
        : namespace === 'user'
          ? ['user', 'guildMember']
          : [scope];

    const results: DbFindEntry[] = [];
    const seen = new Set<string>();

    for (const scanScope of scopesToScan) {
      for (const definition of this.config.scopedVariableDefinitions) {
        const entryScope = String(definition.scope ?? '').trim();
        if (entryScope !== scanScope) {
          continue;
        }
        const storageKey = normalizeScopedStorageKey(String(definition.key ?? '').trim());
        if (!storageKey) {
          continue;
        }

        const contextIds = await this.collectContextIds(storageKey, entryScope);
        for (const contextId of contextIds) {
          const dedupeKey = `${entryScope}:${storageKey}:${contextId}`;
          if (seen.has(dedupeKey)) {
            continue;
          }
          seen.add(dedupeKey);

          const value = await this.readStoredScopedValue(
            { scope: entryScope, key: storageKey },
            contextId,
          );
          if (value === undefined || value === null) {
            continue;
          }

          const mappedId = this.mapListEntry(entryScope, contextId, namespace);
          if (!mappedId) {
            continue;
          }

          const entry: DbFindEntry = { key: storageKey, id: mappedId, value };
          if (!filter || filter(entry)) {
            results.push(entry);
          }
        }
      }
    }

    return results;
  }

  private mapListEntry(
    scope: string,
    contextId: string,
    namespace: DbScopeNamespace,
  ): string | null {
    switch (scope) {
      case 'guildMember': {
        const { guildId, userId } = parseGuildMemberContextId(contextId);
        if (namespace === 'user') {
          const currentGuildId = resolveGuildId(this.ctx);
          if (currentGuildId && guildId !== currentGuildId) {
            return null;
          }
          return userId || null;
        }
        return contextId;
      }
      case 'user':
        return namespace === 'user' ? contextId : null;
      case 'guild':
        return namespace === 'guild' ? contextId : null;
      case 'channel':
        return namespace === 'channel' ? contextId : null;
      case 'message':
        return namespace === 'message' ? contextId : null;
      default:
        return contextId;
    }
  }

  private async collectContextIds(storageKey: string, scope: string): Promise<string[]> {
    const contextIds = new Set(await this.store.listContextIds(this.botId, scope, storageKey));
    const legacyKey = toScopedReferenceKey(storageKey);
    if (legacyKey !== storageKey) {
      for (const contextId of await this.store.listContextIds(
        this.botId,
        scope,
        legacyKey,
      )) {
        contextIds.add(contextId);
      }
    }
    return [...contextIds];
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
    if (
      target &&
      (target.contextId ||
        target.userId ||
        target.guildId ||
        target.channelId ||
        target.messageId)
    ) {
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

function normalizePositiveInt(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`db.list: ${label} must be a positive number.`);
  }
  return Math.floor(value);
}

function normalizeNonNegativeInt(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`db.list: ${label} must be zero or greater.`);
  }
  return Math.floor(value);
}
