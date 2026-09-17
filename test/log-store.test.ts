import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'bun:test';

import { LogStore } from '../src/runtime/log-store.js';

describe('LogStore', () => {
  it('hydrates bot-scoped lines from the log file on startup', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'runner-js-logs-'));
    const logFile = path.join(dir, 'runner.log');

    try {
      const now = new Date();
      const recentTs = new Date(now.getTime() - 1000 * 60).toISOString();
      const expiredTs = new Date(now.getTime() - 8 * 24 * 3600 * 1000).toISOString();

      await writeFile(
        logFile,
        `[${expiredTs}] [INFO] [bot:bot-a] old expired log\n` +
          `[${recentTs}] [INFO] [bot:bot-a] command executed\n`,
        'utf8',
      );

      const store = new LogStore(logFile);
      await store.init();

      expect(store.tailForBot('bot-a', 10)).toEqual([
        `[${recentTs}] [INFO] command executed`,
      ]);
      expect(store.tailForBot('bot-b', 10)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
