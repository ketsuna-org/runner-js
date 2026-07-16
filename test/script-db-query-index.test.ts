import { afterEach, describe, expect, it, vi } from 'vitest';

import type { VariableDatabase } from '../src/runtime/variable-database.js';
import { ScriptDb } from '../src/scripts/script-db.js';

describe('ScriptDb query-index path', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists via queryScopedVariableIndex when available', async () => {
    const queryScopedVariableIndex = vi.fn(async () => ({
      items: [
        { contextId: 'user-b', key: 'xp', value: 50 },
        { contextId: 'user-a', key: 'xp', value: 10 },
      ],
      count: 2,
      total: 2,
    }));
    const listContextIds = vi.fn(async () => {
      throw new Error('listContextIds should not be used');
    });
    const store = {
      getGlobalVariables: async () => ({}),
      setGlobalVariable: async () => undefined,
      removeGlobalVariable: async () => undefined,
      renameGlobalVariable: async () => undefined,
      getScopedVariable: async () => undefined,
      setScopedVariable: async () => undefined,
      removeScopedVariable: async () => undefined,
      listContextIds,
      removeAllScopedValuesForKey: async () => undefined,
      queryScopedVariableIndex,
    } satisfies VariableDatabase;

    const config = {
      globalVariables: {},
      scopedVariableDefinitions: [{ key: 'xp', scope: 'user' }],
      commands: [],
      events: [],
      inboundWebhooks: [],
      intents: [],
      token: 'token',
      scriptTimeoutMs: 1000,
    };
    const db = new ScriptDb('bot-1', config, store, {}, {});
    const rows = await db.user.list('xp', 'desc', 2, 0);
    expect(rows).toEqual([
      { id: 'user-b', value: 50 },
      { id: 'user-a', value: 10 },
    ]);
    expect(queryScopedVariableIndex).toHaveBeenCalledWith('bot-1', 'user', 'xp', {
      offset: 0,
      limit: 2,
      descending: true,
    });
    expect(listContextIds).not.toHaveBeenCalled();
  });
});
