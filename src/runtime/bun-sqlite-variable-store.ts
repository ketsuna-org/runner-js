import { Database } from 'bun:sqlite';
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

interface VariableRow {
  id?: number;
  bot_id: string;
  scope: string;
  context_id_1: string;
  context_id_2: string | null;
  key: string;
  value_raw: string;
  value_type: string;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
}

export class BunSqliteVariableStore implements VariableDatabase {
  private db: Database | null = null;
  private initialized = false;
  private readonly inMemory: boolean;

  constructor(
    private readonly workDir: string,
    options?: { inMemory?: boolean },
  ) {
    this.inMemory = options?.inMemory === true || workDir === ':memory:';
  }

  get dbPath(): string {
    if (this.inMemory) {
      return ':memory:';
    }
    return path.join(this.workDir, 'variables.db');
  }

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (!this.inMemory) {
      mkdirSync(this.workDir, { recursive: true });
    }
    this.db = new Database(this.dbPath);
    const journalMode = this.inMemory || process.platform === 'win32' ? 'DELETE' : 'WAL';
    this.db.exec(`PRAGMA journal_mode = ${journalMode}`);
    this.db.exec(`
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
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_bot_lookup
      ON variables(bot_id, scope, context_id_1, context_id_2)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_scope_key_lookup
      ON variables(bot_id, scope, key)
    `);
    this.initialized = true;
    this.migrateExpiresAtColumnIfNeeded();
  }

  private get database(): Database {
    if (!this.db || !this.initialized) {
      throw new Error('BunSqliteVariableStore is not initialized.');
    }
    return this.db;
  }

  private migrateExpiresAtColumnIfNeeded(): void {
    const row = this.database
      .query<{ sql: string | null }, []>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'variables' LIMIT 1",
      )
      .get();
    const sql = row?.sql ?? '';
    if (!sql || sql.includes('expires_at')) {
      return;
    }
    this.database.exec('ALTER TABLE variables ADD COLUMN expires_at INTEGER');
  }

  private scopedWhere(includeKey: boolean): string {
    const keyClause = includeKey ? ' AND key = ?' : '';
    return `bot_id = ? AND scope = ? AND context_id_1 = ? AND COALESCE(context_id_2, '') = ?${keyClause}`;
  }

  private isExpired(expiresAt: number | null | undefined, now: number): boolean {
    return expiresAt != null && expiresAt < now;
  }

  async getGlobalVariables(botId: string): Promise<Record<string, unknown>> {
    await this.init();
    const now = Date.now();
    const rows = this.database
      .query<
        { key: string; value_raw: string; value_type: string; expires_at: number | null },
        [string, string]
      >(
        'SELECT key, value_raw, value_type, expires_at FROM variables WHERE bot_id = ? AND scope = ? ORDER BY updated_at ASC, id ASC',
      )
      .all(botId, '_global_');

    const output: Record<string, unknown> = {};
    for (const row of rows) {
      if (this.isExpired(row.expires_at, now)) {
        continue;
      }
      output[row.key] = deserializeVariableValue(row.value_raw, row.value_type);
    }
    return output;
  }

  async getGlobalVariable(botId: string, key: string): Promise<unknown> {
    const globals = await this.getGlobalVariables(botId);
    return globals[key];
  }

  async setGlobalVariable(botId: string, key: string, value: unknown): Promise<void> {
    await this.init();
    const { raw, type } = serializeVariableValue(value);
    const now = Date.now();
    this.database
      .query(
        `INSERT INTO variables (bot_id, scope, context_id_1, context_id_2, key, value_raw, value_type, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(bot_id, scope, context_id_1, context_id_2, key) DO UPDATE SET
           value_raw = excluded.value_raw,
           value_type = excluded.value_type,
           updated_at = excluded.updated_at,
           expires_at = excluded.expires_at`,
      )
      .run(botId, '_global_', '', null, key, raw, type, now, now, null);
  }

  async removeGlobalVariable(botId: string, key: string): Promise<void> {
    await this.init();
    this.database
      .query('DELETE FROM variables WHERE bot_id = ? AND scope = ? AND key = ?')
      .run(botId, '_global_', key);
  }

  async renameGlobalVariable(botId: string, oldKey: string, newKey: string): Promise<void> {
    await this.init();
    const now = Date.now();
    this.database
      .query('UPDATE variables SET key = ?, updated_at = ? WHERE bot_id = ? AND scope = ? AND key = ?')
      .run(newKey, now, botId, '_global_', oldKey);
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
    const row = this.database
      .query<
        { value_raw: string; value_type: string; expires_at: number | null },
        [string, string, string, string, string]
      >(
        `SELECT value_raw, value_type, expires_at FROM variables WHERE ${this.scopedWhere(true)} ORDER BY updated_at DESC, id DESC LIMIT 1`,
      )
      .get(botId, scope, ctx1, ctx2, key);

    if (!row) {
      return null;
    }
    if (this.isExpired(row.expires_at, now)) {
      await this.removeScopedVariable(botId, scope, contextId, key);
      return null;
    }
    return deserializeVariableValue(row.value_raw, row.value_type);
  }

  async getScopedVariables(
    botId: string,
    scope: string,
    contextId: string,
  ): Promise<Record<string, unknown>> {
    await this.init();
    const { ctx1, ctx2 } = parseScopedContextParts(scope, contextId);
    const now = Date.now();
    const rows = this.database
      .query<
        { key: string; value_raw: string; value_type: string; expires_at: number | null },
        [string, string, string, string]
      >(
        `SELECT key, value_raw, value_type, expires_at FROM variables WHERE ${this.scopedWhere(false)}`,
      )
      .all(botId, scope, ctx1, ctx2);

    const output: Record<string, unknown> = {};
    for (const row of rows) {
      if (this.isExpired(row.expires_at, now)) {
        continue;
      }
      output[row.key] = deserializeVariableValue(row.value_raw, row.value_type);
    }
    return output;
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
    this.database
      .query(
        `INSERT INTO variables (bot_id, scope, context_id_1, context_id_2, key, value_raw, value_type, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(bot_id, scope, context_id_1, context_id_2, key) DO UPDATE SET
           value_raw = excluded.value_raw,
           value_type = excluded.value_type,
           updated_at = excluded.updated_at,
           expires_at = excluded.expires_at`,
      )
      .run(botId, scope, ctx1, ctx2 || null, key, raw, type, now, now, null);
  }

  async removeScopedVariable(
    botId: string,
    scope: string,
    contextId: string,
    key: string,
  ): Promise<void> {
    await this.init();
    const { ctx1, ctx2 } = parseScopedContextParts(scope, contextId);
    this.database
      .query(`DELETE FROM variables WHERE ${this.scopedWhere(true)}`)
      .run(botId, scope, ctx1, ctx2, key);
  }

  async listContextIds(
    botId: string,
    scope: string,
    searchKey: string,
  ): Promise<string[]> {
    await this.init();
    const trimmedSearchKey = searchKey.trim();

    if (scope === 'guildMember') {
      let rows: Array<{ context_id_1: string; context_id_2: string | null }>;
      if (trimmedSearchKey.length > 0) {
        rows = this.database
          .query<{ context_id_1: string; context_id_2: string | null }, [string, string, string]>(
            'SELECT DISTINCT context_id_1, context_id_2 FROM variables WHERE bot_id = ? AND scope = ? AND key = ?',
          )
          .all(botId, scope, trimmedSearchKey);
      } else {
        rows = this.database
          .query<{ context_id_1: string; context_id_2: string | null }, [string, string]>(
            'SELECT DISTINCT context_id_1, context_id_2 FROM variables WHERE bot_id = ? AND scope = ?',
          )
          .all(botId, scope);
      }
      return rows
        .map((row) => composeGuildMemberContextId(row.context_id_1, row.context_id_2 ?? ''))
        .filter((id) => id.length > 0);
    }

    let rows: Array<{ context_id_1: string }>;
    if (trimmedSearchKey.length > 0) {
      rows = this.database
        .query<{ context_id_1: string }, [string, string, string]>(
          "SELECT DISTINCT context_id_1 FROM variables WHERE bot_id = ? AND scope = ? AND key = ? AND context_id_1 != ''",
        )
        .all(botId, scope, trimmedSearchKey);
    } else {
      rows = this.database
        .query<{ context_id_1: string }, [string, string]>(
          "SELECT DISTINCT context_id_1 FROM variables WHERE bot_id = ? AND scope = ? AND context_id_1 != ''",
        )
        .all(botId, scope);
    }
    return rows.map((row) => row.context_id_1).filter((id) => id.length > 0);
  }

  async removeAllScopedValuesForKey(botId: string, scope: string, key: string): Promise<void> {
    await this.init();
    this.database
      .query('DELETE FROM variables WHERE bot_id = ? AND scope = ? AND key = ?')
      .run(botId, scope, key);
  }

  async deleteAllForBot(botId: string): Promise<void> {
    await this.init();
    this.database
      .query('DELETE FROM variables WHERE bot_id = ?')
      .run(botId);
  }

  async queryScopedVariableIndex(
    botId: string,
    scope: string,
    key: string,
    options: ScopedIndexQueryOptions = {},
  ): Promise<ScopedIndexQueryResult> {
    await this.init();
    const safeOffset = options.offset != null && options.offset > 0 ? options.offset : 0;
    const safeLimit = Math.min(Math.max(options.limit ?? 25, 1), 1000);
    const descending = options.descending !== false;
    const now = Date.now();

    const rows = this.database
      .query<
        {
          context_id_1: string;
          context_id_2: string | null;
          key: string;
          value_raw: string;
          value_type: string;
          expires_at: number | null;
        },
        [string, string, string]
      >(
        'SELECT context_id_1, context_id_2, key, value_raw, value_type, expires_at FROM variables WHERE bot_id = ? AND scope = ? AND key = ?',
      )
      .all(botId, scope, key);

    const items = rows
      .filter((row) => !this.isExpired(row.expires_at, now))
      .map((row) => {
        const contextId =
          scope === 'guildMember'
            ? composeGuildMemberContextId(row.context_id_1, row.context_id_2 ?? '')
            : row.context_id_1;
        return {
          contextId,
          key: row.key,
          value: deserializeVariableValue(row.value_raw, row.value_type),
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
    if (this.db) {
      this.db.close();
      this.db = null;
      this.initialized = false;
    }
  }
}
