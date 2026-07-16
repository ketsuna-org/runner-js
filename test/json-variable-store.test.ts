import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { JsonVariableStore } from '../src/runtime/json-variable-store.js';

describe('JsonVariableStore read cache', () => {
  let dir: string;
  let store: JsonVariableStore;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'runner-js-jsonvars-'));
    store = new JsonVariableStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('serves repeated scoped reads after a single write', async () => {
    await store.setScopedVariable('bot-1', 'user', 'u1', 'coins', 10);
    await store.setScopedVariable('bot-1', 'user', 'u2', 'coins', 20);

    expect(await store.getScopedVariable('bot-1', 'user', 'u1', 'coins')).toBe(10);
    expect(await store.getScopedVariable('bot-1', 'user', 'u2', 'coins')).toBe(20);
    expect(await store.listContextIds('bot-1', 'user', 'coins')).toEqual(['u1', 'u2']);
  });

  it('invalidates the cache when the file mtime changes externally', async () => {
    await store.setScopedVariable('bot-1', 'user', 'u1', 'coins', 10);
    expect(await store.getScopedVariable('bot-1', 'user', 'u1', 'coins')).toBe(10);

    const filePath = path.join(dir, 'bot-1.json');
    // Ensure mtime changes even on filesystems with coarse resolution.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(
      filePath,
      JSON.stringify({
        global: {},
        scoped: { user: { coins: { u1: 99 } } },
      }),
      'utf8',
    );

    expect(await store.getScopedVariable('bot-1', 'user', 'u1', 'coins')).toBe(99);
  });
});
