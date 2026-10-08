import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { BotStore } from '../src/runtime/bot-store.js';
import { parseJsBotConfig } from '../src/config/js-bot-config.js';

describe('BotStore.updateConfig', () => {
  it('serializes concurrent updates so none is lost', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'botstore-'));
    try {
      const store = new BotStore(dir);
      await store.save('b1', 'Bot', parseJsBotConfig({ token: 't' }));
      await Promise.all(
        ['a', 'b', 'c', 'd'].map((id) =>
          store.updateConfig('b1', (config) => ({
            ...config,
            globalVariables: { ...config.globalVariables, [id]: 1 },
          })),
        ),
      );
      const entry = await store.load('b1');
      expect(Object.keys(entry!.config.globalVariables).sort()).toEqual(['a', 'b', 'c', 'd']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('listAll skips a corrupt bot file instead of failing', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'botstore-'));
    try {
      const store = new BotStore(dir);
      await store.save('good', 'Good', parseJsBotConfig({ token: 't' }));
      await store.save('bad', 'Bad', parseJsBotConfig({ token: 't' }));
      await Bun.write(path.join(dir, 'bad.json'), '{"id":"bad","config":{"commands":"nope"}}');
      const names = (await store.listAll()).map((e) => e.id);
      expect(names).toEqual(['good']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
