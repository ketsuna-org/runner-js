import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { LogStore } from '../src/runtime/log-store.js';

describe('LogStore', () => {
  it('hydrates bot-scoped lines from the log file on startup', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'runner-js-logs-'));
    const logFile = path.join(dir, 'runner.log');

    try {
      await writeFile(
        logFile,
        '[2026-01-01T00:00:00.000Z] [INFO] [bot:bot-a] command executed\n',
        'utf8',
      );

      const store = new LogStore(logFile);
      await store.init();

      expect(store.tailForBot('bot-a', 10)).toEqual([
        '[2026-01-01T00:00:00.000Z] [INFO] command executed',
      ]);
      expect(store.tailForBot('bot-b', 10)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
