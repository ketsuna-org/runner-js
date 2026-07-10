import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, afterEach } from 'vitest';

import { SqliteVariableStore } from '../src/runtime/sqlite-variable-store.js';
import type { VariableDatabase } from '../src/runtime/variable-database.js';
import { ScriptDb } from '../src/scripts/script-db.js';

describe('ScriptDb', () => {
  let dataDir = '';
  let store: VariableDatabase;

  const config = {
    globalVariables: { welcome: 'hi' },
    scopedVariableDefinitions: [
      { key: 'coins', scope: 'user', defaultValue: 0 },
      { key: 'score', scope: 'guild' },
      { key: 'notes', scope: 'channel' },
      { key: 'xp', scope: 'guildMember' },
    ],
    commands: [],
    events: [],
    inboundWebhooks: [],
    intents: [],
    token: 'token',
    scriptTimeoutMs: 1000,
  };

  const interactionCtx = {
    interaction: { user: { id: 'user-current' }, guildId: 'guild-1' } as never,
    guild: { id: 'guild-1' } as never,
  };

  afterEach(async () => {
    if (store?.dispose) {
      store.dispose();
    }
    if (dataDir) {
      await rm(dataDir, { recursive: true, force: true });
      dataDir = '';
    }
  });

  async function createDb(
    ctx: Record<string, unknown> = interactionCtx,
    variables: Record<string, unknown> = {},
    configOverride: typeof config = config,
  ) {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'runner-js-db-'));
    store = new SqliteVariableStore(path.join(dataDir, 'variables'));
    await store.init();
    return new ScriptDb('bot-1', configOverride, store, ctx, variables);
  }

  it('auto-creates scoped variables on set', async () => {
    const mutableConfig = structuredClone(config);
    mutableConfig.scopedVariableDefinitions = [];
    const db = await createDb(interactionCtx, {}, mutableConfig);

    await db.user.set('coins', 42);
    expect(await db.user.get('coins')).toBe(42);
    expect(mutableConfig.scopedVariableDefinitions).toEqual([
      { key: 'coins', scope: 'guildMember' },
    ]);
  });

  it('gets and sets for the current guild member context', async () => {
    const variables: Record<string, unknown> = {};
    const db = await createDb(interactionCtx, variables);

    await db.user.set('xp', 42);
    expect(await db.user.get('xp')).toBe(42);
    expect(variables.xp).toBe(42);
  });

  it('gets and sets for an explicit user id', async () => {
    const db = await createDb();

    await db.user.set('coins', 100, 'user-other');
    expect(await db.user.get('coins', 'user-other')).toBe(100);
    expect(await db.user.get('coins')).not.toBe(100);
  });

  it('gets and sets guild scope values', async () => {
    const db = await createDb();

    await db.guild.set('score', 9001, 'guild-42');
    expect(await db.guild.get('score', 'guild-42')).toBe(9001);
  });

  it('lists guild member values for a key sorted by value', async () => {
    const db = await createDb();

    await db.user.set('xp', 10, 'user-a');
    await db.user.set('xp', 50, 'user-b');
    await db.user.set('xp', 25, 'user-c');

    const rows = await db.user.list('xp', 'desc', 2, 0);
    expect(rows).toEqual([
      { id: 'user-b', value: 50 },
      { id: 'user-c', value: 25 },
    ]);
  });

  it('finds entries with a filter function', async () => {
    const db = await createDb();

    await db.user.set('xp', 10, 'user-a');
    await db.user.set('xp', 50, 'user-b');

    const rows = await db.user.find((entry) => Number(entry.value) >= 20);
    expect(rows).toEqual([
      { key: 'xp', id: 'user-b', value: 50 },
    ]);
  });

  it('supports db.global get/set/delete', async () => {
    const variables: Record<string, unknown> = {};
    const db = await createDb(interactionCtx, variables);

    await db.global.set('counter', 3);
    expect(await db.global.get('counter')).toBe(3);
    expect(variables.counter).toBe(3);

    await db.global.delete('counter');
    expect(await db.global.get('counter')).toBeUndefined();
  });
});
