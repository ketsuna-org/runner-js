import { describe, expect, it, afterEach } from 'vitest';

import { LibsqlVariableStore } from '../src/runtime/libsql-variable-store.js';
import type { VariableDatabase } from '../src/runtime/variable-database.js';
import { ScriptDb } from '../src/scripts/script-db.js';

describe('ScriptDb', () => {
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

  afterEach(() => {
    store?.dispose?.();
    store = null as never;
  });

  async function createDb(
    ctx: Record<string, unknown> = interactionCtx,
    variables: Record<string, unknown> = {},
    configOverride: typeof config = config,
  ) {
    store = new LibsqlVariableStore(':memory:', { inMemory: true });
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

  it('gets and sets guildMember scope for the current member', async () => {
    const variables: Record<string, unknown> = {};
    const db = await createDb(interactionCtx, variables);

    await db.guildMember.set('xp', 42);
    expect(await db.guildMember.get('xp')).toBe(42);
    expect(variables.xp).toBe(42);
  });

  it('gets and sets guildMember with explicit user and guild ids', async () => {
    const db = await createDb();

    await db.guildMember.set('xp', 99, 'user-other', 'guild-9');
    expect(await db.guildMember.get('xp', 'user-other', 'guild-9')).toBe(99);
    expect(await db.guildMember.get('xp')).not.toBe(99);
  });

  it('deletes guildMember values for explicit ids', async () => {
    const db = await createDb();

    await db.guildMember.set('xp', 10, 'user-a', 'guild-1');
    await db.guildMember.delete('xp', 'user-a', 'guild-1');
    expect(await db.guildMember.get('xp', 'user-a', 'guild-1')).toBeUndefined();
  });

  it('lists guildMember values sorted by value', async () => {
    const db = await createDb();

    await db.guildMember.set('xp', 10, 'user-a');
    await db.guildMember.set('xp', 50, 'user-b');
    await db.guildMember.set('xp', 25, 'user-c');

    const rows = await db.guildMember.list('xp', 'desc', 2, 0);
    expect(rows).toEqual([
      { id: 'user-b', value: 50 },
      { id: 'user-c', value: 25 },
    ]);
  });

  it('finds guildMember entries with a filter function', async () => {
    const db = await createDb();

    await db.guildMember.set('xp', 10, 'user-a');
    await db.guildMember.set('xp', 50, 'user-b');

    const rows = await db.guildMember.find((entry) => Number(entry.value) >= 20);
    expect(rows).toEqual([
      { key: 'xp', id: 'user-b', value: 50 },
    ]);
  });

  it('resets user scoped values and removes the definition in guild context', async () => {
    const mutableConfig = structuredClone(config);
    const db = await createDb(interactionCtx, {}, mutableConfig);

    await db.user.set('xp', 10, 'user-a');
    await db.user.set('xp', 50, 'user-b');
    await db.user.reset('xp');

    expect(await db.user.get('xp', 'user-a')).toBeUndefined();
    expect(await db.user.get('xp', 'user-b')).toBeUndefined();
    expect(mutableConfig.scopedVariableDefinitions.some(
      (entry) => entry.key === 'xp' && entry.scope === 'guildMember',
    )).toBe(false);
  });

  it('resets guildMember scoped values and removes the definition', async () => {
    const mutableConfig = structuredClone(config);
    const db = await createDb(interactionCtx, {}, mutableConfig);

    await db.guildMember.set('xp', 10, 'user-a');
    await db.guildMember.set('xp', 50, 'user-b');
    await db.guildMember.reset('xp');

    expect(mutableConfig.scopedVariableDefinitions.some(
      (entry) => entry.key === 'xp' && entry.scope === 'guildMember',
    )).toBe(false);
  });

  it('resets guild scoped values and removes the definition', async () => {
    const mutableConfig = structuredClone(config);
    const db = await createDb(interactionCtx, {}, mutableConfig);

    await db.guild.set('score', 100, 'guild-a');
    await db.guild.set('score', 200, 'guild-b');
    await db.guild.reset('score');

    expect(mutableConfig.scopedVariableDefinitions.some(
      (entry) => entry.key === 'score' && entry.scope === 'guild',
    )).toBe(false);
  });
});
