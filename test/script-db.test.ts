import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, afterEach } from 'vitest';

import { VariableStore } from '../src/runtime/variable-store.js';
import { ScriptDb } from '../src/scripts/script-db.js';

describe('ScriptDb', () => {
  let dataDir = '';
  let store: VariableStore;

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
    if (dataDir) {
      await rm(dataDir, { recursive: true, force: true });
      dataDir = '';
    }
  });

  async function createDb(variables: Record<string, unknown> = {}) {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'runner-js-db-'));
    store = new VariableStore(path.join(dataDir, 'variables'));
    return new ScriptDb('bot-1', config, store, interactionCtx, variables);
  }

  it('gets and sets for the current user context', async () => {
    const variables: Record<string, unknown> = {};
    const db = await createDb(variables);

    await db.set('coins', 42);
    expect(await db.get('coins')).toBe(42);
    expect(variables.coins).toBe(42);
    expect(await db.has('coins')).toBe(true);
  });

  it('gets and sets for an explicit userId', async () => {
    const db = await createDb();

    await db.set('coins', 100, { userId: 'user-other' });
    expect(await db.get('coins', { userId: 'user-other' })).toBe(100);
    expect(await db.get('coins')).not.toBe(100);
  });

  it('gets and sets for an explicit guildId', async () => {
    const db = await createDb();

    await db.set('score', 9001, { guildId: 'guild-42' });
    expect(await db.get('score', { guildId: 'guild-42' })).toBe(9001);
  });

  it('gets and sets guildMember scope with guildId + userId', async () => {
    const db = await createDb();

    await db.set('xp', 15, { guildId: 'g1', userId: 'u1' });
    expect(await db.get('xp', { guildId: 'g1', userId: 'u1' })).toBe(15);
    expect(await db.get('xp', { contextId: 'g1:u1' })).toBe(15);
  });

  it('lists all stored values for a scoped key sorted by value desc', async () => {
    const db = await createDb();

    await db.set('coins', 1, { userId: 'u1' });
    await db.set('coins', 8, { userId: 'u2' });
    await db.set('coins', 3, { userId: 'u3' });

    expect(await db.list('coins')).toEqual({ u2: 8, u3: 3, u1: 1 });
  });

  it('lists guildMember values for a guild with userId keys in leaderboard order', async () => {
    const db = await createDb();

    await db.set('xp', 10, { guildId: 'g1', userId: 'u1' });
    await db.set('xp', 50, { guildId: 'g1', userId: 'u2' });
    await db.set('xp', 99, { guildId: 'g2', userId: 'u9' });

    expect(await db.list('xp', { guildId: 'g1' })).toEqual({ u2: 50, u1: 10 });
  });

  it('filters list to a single user when userId is provided', async () => {
    const db = await createDb();

    await db.set('coins', 1, { userId: 'u1' });
    await db.set('coins', 8, { userId: 'u2' });

    expect(await db.list('coins', { userId: 'u2' })).toEqual({ u2: 8 });
  });

  it('limits list results after sorting', async () => {
    const db = await createDb();

    await db.set('coins', 1, { userId: 'u1' });
    await db.set('coins', 50, { userId: 'u2' });
    await db.set('coins', 25, { userId: 'u3' });
    await db.set('coins', 100, { userId: 'u4' });

    expect(await db.list('coins', { limit: 2 })).toEqual({ u4: 100, u2: 50 });
  });

  it('rejects invalid list limit', async () => {
    const db = await createDb();
    await expect(db.list('coins', { limit: 0 })).rejects.toThrow(/limit must be a positive number/);
  });

  it('deletes a single context and resets all contexts', async () => {
    const db = await createDb();

    await db.set('coins', 5, { userId: 'u1' });
    await db.set('coins', 8, { userId: 'u2' });

    await db.delete('coins', { userId: 'u1' });
    expect(await db.has('coins', { userId: 'u1' })).toBe(false);
    expect(await db.get('coins', { userId: 'u2' })).toBe(8);

    await db.reset('coins');
    expect(await db.list('coins')).toEqual({});
  });

  it('supports db.global get/set/delete', async () => {
    const variables: Record<string, unknown> = { welcome: 'hi' };
    const db = await createDb(variables);

    expect(await db.global.get('welcome')).toBe('hi');
    await db.global.set('counter', 3);
    expect(await db.global.get('counter')).toBe(3);
    expect(variables.counter).toBe(3);
    await db.global.delete('counter');
    expect(await db.global.has('counter')).toBe(false);
  });
});
