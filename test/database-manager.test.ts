import { describe, expect, it } from 'bun:test';
import { DatabaseManager } from '../src/runtime/database-manager.js';
import { ScriptDirectRuntime } from '../src/scripts/script-direct-runtime.js';
import type { ScriptExecutionContext } from '../src/scripts/script-context.js';

describe('DatabaseManager', () => {
  it('returns empty handles when type is none', async () => {
    const manager = new DatabaseManager({ type: 'none' });
    expect(manager.handles.pgsql).toBeUndefined();
    expect(manager.handles.sql).toBeUndefined();
    expect(manager.handles.mongo).toBeUndefined();
    await manager.dispose();
  });

  it('initializes pgsql handle when type is postgres', async () => {
    const manager = new DatabaseManager({
      type: 'postgres',
      host: 'localhost',
      port: 5432,
      database: 'testdb',
    });
    expect(manager.handles.pgsql).toBeDefined();
    expect(typeof manager.handles.pgsql?.query).toBe('function');
    expect(typeof manager.handles.pgsql?.connect).toBe('function');
    expect(manager.handles.pgsql?.pool).toBeDefined();
    await manager.dispose();
  });

  it('initializes sql handle when type is mysql', async () => {
    const manager = new DatabaseManager({
      type: 'mysql',
      host: 'localhost',
      port: 3306,
      database: 'testdb',
    });
    expect(manager.handles.sql).toBeDefined();
    expect(typeof manager.handles.sql?.query).toBe('function');
    expect(typeof manager.handles.sql?.execute).toBe('function');
    expect(manager.handles.sql?.pool).toBeDefined();
    await manager.dispose();
  });

  it('initializes mongo handle when type is mongo', async () => {
    const manager = new DatabaseManager({
      type: 'mongo',
      uri: 'mongodb://localhost:27017/testdb',
      database: 'testdb',
    });
    expect(manager.handles.mongo).toBeDefined();
    expect(typeof manager.handles.mongo?.db).toBe('function');
    expect(typeof manager.handles.mongo?.collection).toBe('function');
    expect(manager.handles.mongo?.client).toBeDefined();
    await manager.dispose();
  });

  it('injects database handles into script execution context', async () => {
    const runtime = new ScriptDirectRuntime();
    const mockPgsql = {
      query: async (text: string) => ({ rows: [{ msg: text }] }),
      connect: async () => ({} as never),
      pool: {} as never,
    };
    const mockSql = {
      query: async (sqlText: string) => [[{ msg: sqlText }], []],
      execute: async () => [[], []] as never,
      getConnection: async () => ({} as never),
      pool: {} as never,
    };
    const mockMongo = {
      db: () => ({} as never),
      collection: () => ({ find: () => [] } as never),
      client: {} as never,
    };

    const logs: string[] = [];
    const logger = {
      log: (msg: string) => logs.push(msg),
      info: (msg: string) => logs.push(msg),
      warn: (msg: string) => logs.push(msg),
      error: (msg: string) => logs.push(msg),
      debug: (msg: string) => logs.push(msg),
    };

    const context = {
      client: {} as never,
      config: {
        token: 'test',
        commands: [],
        events: [],
        intents: {},
        scheduled: [],
        inboundWebhooks: [],
        globalVariables: {},
        scopedVariableDefinitions: [],
        scriptTimeoutMs: 1000,
        autoRestart: true,
        presence: {},
        databaseConfig: { type: 'postgres' as const },
      },
      variables: {},
      pgsql: mockPgsql,
      sql: mockSql,
      mongo: mockMongo,
    } as unknown as ScriptExecutionContext;

    const script = `
      const pgRes = await pgsql.query("SELECT 1");
      const sqlRes = await sql.query("SELECT 2");
      const col = mongo.collection("users");
      console.log(pgRes.rows[0].msg + " | " + sqlRes[0][0].msg + " | " + typeof col.find);
    `;

    await runtime.execute(script, context, logger, 5000);
    expect(logs).toContain('SELECT 1 | SELECT 2 | function');
  });
});
