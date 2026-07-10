import { createClient, type Client } from '@libsql/client';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import {
  composeGuildMemberContextId,
  parseScopedContextParts,
} from './scoped-context-parts.js';
import type {
  ScopedIndexQueryOptions,
  ScopedIndexQueryResult,
  VariableDatabase,
} from './variable-database.js';
import {
  compareVariableValues,
  deserializeVariableValue,
  serializeVariableValue,
} from './variable-serialization.js';

function rowString(row: Record<string, unknown>, column: string): string {
  const value = row[column];
  return value == null ? '' : String(value);
}

function rowNullableString(row: Record<string, unknown>, column: string): string | null {
  const value = row[column];
  if (value == null) {
    return null;
  }
  return String(value);
}

function rowNullableNumber(row: Record<string, unknown>, column: string): number | null {
  const value = row[column];
  if (value == null) {
    return null;
  }
  return Number(value);
}

export class LibsqlVariableStore implements VariableDatabase {
  private client: Client | null = null;
  private initialized = false;

  constructor(private readonly workDir: string) {}

  get dbPath(): string {
    return path.join(this.workDir, 'variables.db');
  }

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    mkdirSync(this.workDir, { recursive: true });
    this.client = createClient({ url: `file:${this.dbPath}` });
    await this.client.execute('PRAGMA journal_mode = WAL');
    await this.client.execute(`
      CREATE TABLE IF NOT EXISTS variables (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bot_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        context_id_1 TEXT NOT NULL,
        context_id_2 TEXT,
        key TEXT NOT NULL,
        value_raw TEXT NOT NULL,
        value_type TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER,
        UNIQUE(bot_id, scope, context_id_1, context_id_2, key),
        CHECK(scope IN ('_global_', 'guild', 'user', 'channel', 'guildMember', 'message'))
      )
    `);
    await this.client.execute(`
      CREATE INDEX IF NOT EXISTS idx_bot_lookup
      ON variables(bot_id, scope, context_id_1, context_id_2)
    `);
    await this.client.execute(`
      CREATE INDEX IF NOT EXISTS idx_scope_key_lookup
      ON variables(bot_id, scope, key)
    `);
    await this.migrateExpiresAtColumnIfNeeded();
    this.initialized = true;
  }

  private get database(): Client {
    if (!this.client || !this.initialized) {
      throw new Error('LibsqlVariableStore is not initialized.');
    }
    return this.client;
  }

  private async migrateExpiresAtColumnIfNeeded(): Promise<void> {
    const result = await this.client!.execute({
      sql: "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'variables' LIMIT 1",
      args: [],
    });
    const row = result.rows[0] as Record<string, unknown> | undefined;
    const sql = rowString(row ?? {}, 'sql');
    if (!sql || sql.includes('expires_at')) {
      return;
    }
    await this.client!.execute('ALTER TABLE variables ADD COLUMN expires_at INTEGER');
  }

  private scopedWhere(includeKey: boolean): string {
    const keyClause = includeKey ? ' AND key = ?' : '';
    return `bot_id = ? AND scope = ? AND context_id_1 = ? AND COALESCE(context_id_2, '') = ?${keyClause}`;
  }

  private scopedArgs(
    botId: string,
    scope: string,
    ctx1: string,
    ctx2: string,
    key?: string,
  ): Array<string | null> {
    const args: Array<string | null> = [botId, scope, ctx1, ctx2];
    if (key != null) {
      args.push(key);
    }
    return args;
  }

  private isExpired(expiresAt: number | null | undefined, now: number): boolean {
    return expiresAt != null && expiresAt < now;
  }

  async getGlobalVariables(botId: string): Promise<Record<string, unknown>> {
    await this.init();
    const now = Date.now();
    const result = await this.database.execute({
      sql: 'SELECT key, value_raw, value_type, expires_at FROM variables WHERE bot_id = ? AND scope = ? ORDER BY updated_at ASC, id ASC',
      args: [botId, '_global_'],
    });

    const output: Record<string, unknown> = {};
    for (const row of result.rows as Record<string, unknown>[]) {
      const expiresAt = rowNullableNumber(row, 'expires_at');
      if (this.isExpired(expiresAt, now)) {
        continue;
      }
      output[rowString(row, 'key')] = deserializeVariableValue(
        rowString(row, 'value_raw'),
        rowString(row, 'value_type'),
      );
    }
    return output;
  }

  async setGlobalVariable(botId: string, key: string, value: unknown): Promise<void> {
    await this.init();
    const { raw, type } = serializeVariableValue(value);
    const now = Date.now();
    await this.database.execute({
      sql: `INSERT INTO variables (bot_id, scope, context_id_1, context_id_2, key, value_raw, value_type, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(bot_id, scope, context_id_1, context_id_2, key) DO UPDATE SET
           value_raw = excluded.value_raw,
           value_type = excluded.value_type,
           updated_at = excluded.updated_at,
           expires_at = excluded.expires_at`,
      args: [botId, '_global_', '', null, key, raw, type, now, now, null],
    });
  }

  async removeGlobalVariable(botId: string, key: string): Promise<void> {
    await this.init();
    await this.database.execute({
      sql: 'DELETE FROM variables WHERE bot_id = ? AND scope = ? AND key = ?',
      args: [botId, '_global_', key],
    });
  }

  async renameGlobalVariable(botId: string, oldKey: string, newKey: string): Promise<void> {
    await this.init();
    const now = Date.now();
    await this.database.execute({
      sql: 'UPDATE variables SET key = ?, updated_at = ? WHERE bot_id = ? AND scope = ? AND key = ?',
      args: [newKey, now, botId, '_global_', oldKey],
    });
  }

  async getScopedVariable(
    botId: string,
    scope: string,
    contextId: string,
    key: string,
  ): Promise<unknown> {
    await this.init();
    const { ctx1, ctx2 } = parseScopedContextParts(scope, contextId);
    const now = Date.now();
    const result = await this.database.execute({
      sql: `SELECT value_raw, value_type, expires_at FROM variables WHERE ${this.scopedWhere(true)} ORDER BY updated_at DESC, id DESC LIMIT 1`,
      args: this.scopedArgs(botId, scope, ctx1, ctx2, key),
    });
    const row = result.rows[0] as Record<string, unknown> | undefined;

    if (!row) {
      return null;
    }
    const expiresAt = rowNullableNumber(row, 'expires_at');
    if (this.isExpired(expiresAt, now)) {
      await this.removeScopedVariable(botId, scope, contextId, key);
      return null;
    }
    return deserializeVariableValue(rowString(row, 'value_raw'), rowString(row, 'value_type'));
  }

  async setScopedVariable(
    botId: string,
    scope: string,
    contextId: string,
    key: string,
    value: unknown,
  ): Promise<void> {
    await this.init();
    const { ctx1, ctx2 } = parseScopedContextParts(scope, contextId);
    const { raw, type } = serializeVariableValue(value);
    const now = Date.now();
    await this.database.execute({
      sql: `INSERT INTO variables (bot_id, scope, context_id_1, context_id_2, key, value_raw, value_type, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(bot_id, scope, context_id_1, context_id_2, key) DO UPDATE SET
           value_raw = excluded.value_raw,
           value_type = excluded.value_type,
           updated_at = excluded.updated_at,
           expires_at = excluded.expires_at`,
      args: [botId, scope, ctx1, ctx2 || null, key, raw, type, now, now, null],
    });
  }

  async removeScopedVariable(
    botId: string,
    scope: string,
    contextId: string,
    key: string,
  ): Promise<void> {
    await this.init();
    const { ctx1, ctx2 } = parseScopedContextParts(scope, contextId);
    await this.database.execute({
      sql: `DELETE FROM variables WHERE ${this.scopedWhere(true)}`,
      args: this.scopedArgs(botId, scope, ctx1, ctx2, key),
    });
  }

  async listContextIds(
    botId: string,
    scope: string,
    searchKey: string,
  ): Promise<string[]> {
    await this.init();
    const trimmedSearchKey = searchKey.trim();
    const args: Array<string> = [botId, scope];
    const whereClauses = ['bot_id = ?', 'scope = ?'];
    if (trimmedSearchKey.length > 0) {
      whereClauses.push('key = ?');
      args.push(trimmedSearchKey);
    }
    const where = whereClauses.join(' AND ');

    if (scope === 'guildMember') {
      const result = await this.database.execute({
        sql: `SELECT DISTINCT context_id_1, context_id_2 FROM variables WHERE ${where}`,
        args,
      });
      return (result.rows as Record<string, unknown>[])
        .map((row) =>
          composeGuildMemberContextId(
            rowString(row, 'context_id_1'),
            rowNullableString(row, 'context_id_2') ?? '',
          ),
        )
        .filter((id) => id.length > 0);
    }

    const result = await this.database.execute({
      sql: `SELECT DISTINCT context_id_1 FROM variables WHERE ${where} AND context_id_1 != ''`,
      args,
    });
    return (result.rows as Record<string, unknown>[])
      .map((row) => rowString(row, 'context_id_1'))
      .filter((id) => id.length > 0);
  }

  async removeAllScopedValuesForKey(botId: string, scope: string, key: string): Promise<void> {
    await this.init();
    await this.database.execute({
      sql: 'DELETE FROM variables WHERE bot_id = ? AND scope = ? AND key = ?',
      args: [botId, scope, key],
    });
  }

  async queryScopedVariableIndex(
    botId: string,
    scope: string,
    key: string,
    options: ScopedIndexQueryOptions = {},
  ): Promise<ScopedIndexQueryResult> {
    await this.init();
    const safeOffset = options.offset != null && options.offset > 0 ? options.offset : 0;
    const safeLimit = Math.min(Math.max(options.limit ?? 25, 1), 25);
    const descending = options.descending !== false;
    const now = Date.now();

    const result = await this.database.execute({
      sql: 'SELECT context_id_1, context_id_2, key, value_raw, value_type, expires_at FROM variables WHERE bot_id = ? AND scope = ? AND key = ?',
      args: [botId, scope, key],
    });

    const items = (result.rows as Record<string, unknown>[])
      .filter((row) => !this.isExpired(rowNullableNumber(row, 'expires_at'), now))
      .map((row) => {
        const contextId =
          scope === 'guildMember'
            ? composeGuildMemberContextId(
                rowString(row, 'context_id_1'),
                rowNullableString(row, 'context_id_2') ?? '',
              )
            : rowString(row, 'context_id_1');
        return {
          contextId,
          key: rowString(row, 'key'),
          value: deserializeVariableValue(rowString(row, 'value_raw'), rowString(row, 'value_type')),
        };
      })
      .filter((entry) => entry.contextId.length > 0)
      .sort((left, right) => compareVariableValues(left.value, right.value, descending));

    const total = items.length;
    const end = Math.min(safeOffset + safeLimit, total);
    const paged = safeOffset >= total ? [] : items.slice(safeOffset, end);

    return {
      items: paged,
      count: paged.length,
      total,
    };
  }

  dispose(): void {
    if (this.client) {
      this.client.close();
      this.client = null;
      this.initialized = false;
    }
  }
}
