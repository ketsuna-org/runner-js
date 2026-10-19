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

    it('keeps a multi-line message on one stdout line and cannot forge a runner line', () => {
      store.append(
        'error',
        'boom\n[2026-10-19T00:00:00Z] [ERROR] [bot:other] Bot start failed: fake\r\nnext',
        'bot-a',
        'script',
      );
      expect(out).toHaveLength(1);
      expect(out[0]).not.toMatch(/[\r\n]/);
      expect(out[0]).toContain('boom\\n[2026-10-19T00:00:00Z]');
      expect(out[0].startsWith('[')).toBe(true);
      expect(out[0].match(/\[bot:/g)).toHaveLength(2);
      expect(out[0]).toContain('[bot:bot-a] boom');
    });

    it('caps a mirrored line and redacts a token before cutting it', () => {
      const token = `${'A'.repeat(24)}.${'b'.repeat(6)}.${'C'.repeat(27)}`;
      store.append('error', `${'x'.repeat(1990)}${token}${'y'.repeat(5000)}`, 'bot-a');
      expect(out).toHaveLength(1);
      expect(out[0].length).toBeLessThan(2400);
      expect(out[0]).toContain('[truncated');
      expect(out[0]).not.toContain('AAAAAAAA');
    });

    it('rate-limits script-origin warn/error lines per bot, with a single suppression notice', () => {
      for (let i = 0; i < 100; i += 1) {
        store.append('error', `Handler script failed (command:x): boom ${i}`, 'bot-a', 'script');
      }
      // 20 lignes recopiées + 1 ligne qui signale la coupure.
      expect(out).toHaveLength(21);
      expect(out[20]).toContain('suppressed');
      expect(out[19]).toContain('boom 19');

      // Un autre bot a son propre plafond ; les lignes du runner ne sont jamais coupées.
      store.append('error', 'Handler script failed: other', 'bot-b', 'script');
      store.append('error', 'Bot start failed: still visible', 'bot-a');
      expect(out).toHaveLength(23);
      expect(out[22]).toContain('Bot start failed: still visible');
    });

    it('does not let a script borrow the unconditional prefixes', () => {
      store.append('info', 'Bot start failed: forged by a script', 'bot-a', 'script');
      store.append('info', 'Fatal disconnect: forged', 'bot-a', 'script');
      expect(out).toEqual([]);
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
