import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseJsBotConfig } from '../src/config/js-bot-config.js';
import { BotStore } from '../src/runtime/bot-store.js';

describe('BotStore disk persistence', () => {
  let dir: string;
  let store: BotStore;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'runner-js-botstore-'));
    store = new BotStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function sampleConfig(script = 'return 1;') {
    return parseJsBotConfig({
      token: 'test-token',
      commands: [{ id: 'c1', name: 'ping', script }],
    });
  }

  it('saves and loads config from disk', async () => {
    await store.save('bot-1', 'Alpha', sampleConfig('return 42;'));
    const loaded = await store.load('bot-1');
    expect(loaded?.name).toBe('Alpha');
    expect(loaded?.config.commands[0]?.script).toBe('return 42;');
  });

  it('lists bots sorted by name', async () => {
    await store.save('bot-b', 'Bravo', sampleConfig());
    await store.save('bot-a', 'Alpha', sampleConfig());
    const listed = await store.listAll();
    expect(listed.map((entry) => entry.name)).toEqual(['Alpha', 'Bravo']);
  });

  it('updates config via transform', async () => {
    await store.save('bot-1', 'Alpha', sampleConfig('old'));
    const updated = await store.updateConfig('bot-1', (config) => ({
      ...config,
      commands: [{ ...config.commands[0]!, script: 'new' }],
    }));
    expect(updated.config.commands[0]?.script).toBe('new');
    const reloaded = await store.load('bot-1');
    expect(reloaded?.config.commands[0]?.script).toBe('new');
  });

  it('hydrates metadata from existing files on a fresh instance', async () => {
    await store.save('bot-1', 'Alpha', sampleConfig());
    const other = new BotStore(dir);
    const listed = await other.listAll();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe('bot-1');
  });

  it('returns null for missing bots', async () => {
    expect(await store.load('missing')).toBeNull();
  });

  it('skips corrupt files during hydration', async () => {
    await writeFile(path.join(dir, 'broken.json'), '{not-json', 'utf8');
    await store.save('bot-1', 'Alpha', sampleConfig());
    const other = new BotStore(dir);
    const listed = await other.listAll();
    expect(listed.map((entry) => entry.id)).toEqual(['bot-1']);
  });
});
