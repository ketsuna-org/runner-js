import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

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

  it('rotates the log file to <file>.1 once it passes the size cap', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'runner-js-logs-'));
    const logFile = path.join(dir, 'runner.log');

    try {
      const store = new LogStore(logFile, 2000, 200);
      await store.init();
      for (let i = 0; i < 20; i += 1) {
        store.append('info', `line-${i} ${'x'.repeat(30)}`);
      }
      await store.flush();

      const rotated = await readFile(`${logFile}.1`, 'utf8');
      const current = await readFile(logFile, 'utf8');
      expect(rotated.length).toBeGreaterThan(0);
      expect(current.length).toBeLessThan(400);
      expect((await stat(logFile)).size).toBeLessThan(400);
      // the newest line is never lost to a rotation
      expect(current).toContain('line-19');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  describe('stdout mirror (kubectl logs)', () => {
    let dir: string;
    let store: LogStore;
    let out: string[];
    let logSpy: ReturnType<typeof spyOn>;

    beforeEach(async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), 'runner-js-logs-'));
      store = new LogStore(path.join(dir, 'runner.log'));
      await store.init();
      out = [];
      logSpy = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        out.push(args.join(' '));
      });
    });

    afterEach(async () => {
      logSpy.mockRestore();
      await rm(dir, { recursive: true, force: true });
    });

    it('mirrors warn and error lines, one line each, same text as the file', async () => {
      store.append('warn', 'something odd', 'bot-a');
      store.append('error', 'Bot start failed: boom', 'bot-a');
      await store.flush();

      expect(out).toHaveLength(2);
      expect(out[0]).toMatch(/^\[[^\]]+\] \[WARN\] \[bot:bot-a\] something odd$/);
      expect(out[1]).toMatch(/^\[[^\]]+\] \[ERROR\] \[bot:bot-a\] Bot start failed: boom$/);
      const file = await readFile(path.join(dir, 'runner.log'), 'utf8');
      expect(file.trimEnd().split('\n')).toEqual(out);
    });

    it('does not mirror ordinary info and debug lines', () => {
      store.append('info', 'command executed', 'bot-a');
      store.append('debug', 'trace', 'bot-a');
      expect(out).toEqual([]);
    });

    it('mirrors start failures, fatal disconnects and intent warnings whatever their level', () => {
      store.append('info', 'Bot start failed: x', 'bot-a');
      store.append('info', 'Fatal disconnect: 4014', 'bot-a');
      store.append('info', 'Intent warning: message content missing', 'bot-a');
      expect(out).toHaveLength(3);
      expect(out[0]).toContain('Bot start failed: x');
      expect(out[1]).toContain('Fatal disconnect: 4014');
      expect(out[2]).toContain('Intent warning: message content missing');
    });

    it('never prints a Discord token on stdout', () => {
      const token = `${'A'.repeat(24)}.${'b'.repeat(6)}.${'C'.repeat(27)}`;
      store.append('error', `Bot start failed: login with ${token} refused`, 'bot-a');
      store.append('error', `request failed Authorization: Bot ${token}`, 'bot-a');
      expect(out).toHaveLength(2);
      for (const line of out) {
        expect(line).not.toContain(token);
        expect(line).toContain('[redacted]');
      }
    });
  });
});
