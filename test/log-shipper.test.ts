import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'bun:test';

import { LogShipper, type ShippedLogRecord } from '../src/runtime/log-shipper.js';
import { LogStore } from '../src/runtime/log-store.js';

function rec(botId: string, message: string, extra: Partial<ShippedLogRecord> = {}): ShippedLogRecord {
  return {
    bot_id: botId,
    at: new Date().toISOString(),
    level: 'info',
    audience: 'support',
    category: 'runner',
    source: 'runner-js',
    message,
    ...extra,
  };
}

describe('LogShipper', () => {
  it('posts batches to <base>/bot-logs with the runner token', async () => {
    const calls: { url: string; auth: string; body: { records: ShippedLogRecord[] } }[] = [];
    const shipper = new LogShipper({
      baseUrl: 'https://manager.test/internal/runners/owner-1/',
      token: 'tok',
      maxBatch: 2,
      fetchFn: (async (url: string, init: RequestInit) => {
        calls.push({
          url,
          auth: (init.headers as Record<string, string>).Authorization,
          body: JSON.parse(String(init.body)),
        });
        return new Response('{"ok":true}', { status: 200 });
      }) as unknown as typeof fetch,
    });
    for (let i = 0; i < 5; i++) shipper.enqueue(rec('b1', `m${i}`));
    await shipper.flush();
    expect(calls.map((c) => c.body.records.length)).toEqual([2, 2, 1]);
    expect(calls[0].url).toBe('https://manager.test/internal/runners/owner-1/bot-logs');
    expect(calls[0].auth).toBe('Bearer tok');
    expect(shipper.pending).toBe(0);
  });

  it('keeps the batch on a server error and retries after the backoff', async () => {
    let now = 1_000_000;
    let status = 503;
    let sent = 0;
    const shipper = new LogShipper({
      baseUrl: 'https://m.test/x',
      token: 't',
      now: () => now,
      fetchFn: (async () => {
        sent += 1;
        return new Response('', { status });
      }) as unknown as typeof fetch,
    });
    shipper.enqueue(rec('b1', 'a'));
    await shipper.flush();
    expect(shipper.pending).toBe(1);
    await shipper.flush(); // dans le backoff: pas de nouvel essai
    expect(sent).toBe(1);
    now += 10_000;
    status = 200;
    await shipper.flush();
    expect(shipper.pending).toBe(0);
    expect(sent).toBe(2);
  });

  it('drops a refused batch (4xx) instead of replaying it forever', async () => {
    const shipper = new LogShipper({
      baseUrl: 'https://m.test/x',
      token: 't',
      fetchFn: (async () => new Response('bad', { status: 400 })) as unknown as typeof fetch,
    });
    shipper.enqueue(rec('b1', 'a'));
    await shipper.flush();
    expect(shipper.pending).toBe(0);
  });

  it('bounds the queue and throttles a chatty bot but never errors or internal lines', () => {
    const shipper = new LogShipper({
      baseUrl: 'https://m.test/x',
      token: 't',
      maxQueue: 50,
      perBotPerMinute: 10,
      fetchFn: (async () => new Response('', { status: 200 })) as unknown as typeof fetch,
    });
    for (let i = 0; i < 100; i++) shipper.enqueue(rec('chatty', `m${i}`));
    // 10 lignes + 1 ligne qui signale la coupure
    expect(shipper.pending).toBe(11);
    for (let i = 0; i < 5; i++) shipper.enqueue(rec('chatty', 'boom', { level: 'error' }));
    for (let i = 0; i < 5; i++) shipper.enqueue(rec('chatty', 'perf', { audience: 'internal' }));
    expect(shipper.pending).toBe(21);
    for (let i = 0; i < 200; i++) shipper.enqueue(rec('b2', 'x', { level: 'error' }));
    expect(shipper.pending).toBe(50);
  });
});

describe('LogStore audiences', () => {
  it('ships script lines as user and runner info lines as support, with the bot id', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'runner-js-ship-'));
    try {
      const store = new LogStore(path.join(dir, 'runner.log'));
      await store.init();
      const shipped: ShippedLogRecord[] = [];
      store.setShipper({ enqueue: (r: ShippedLogRecord) => shipped.push(r) } as unknown as LogShipper);
      store.append('info', 'hello from script', 'b1', 'script');
      store.append('error', 'script blew up', 'b1', 'script');
      store.append('info', 'Started bot b1', 'b1');
      store.append('warn', 'Intent warning: x', 'b1');
      store.append('info', 'no bot, not shipped');
      store.append('info', 'perf', 'b1', 'runner', {
        audience: 'internal',
        category: 'perf',
        durationMs: 12.4,
        fields: { hydrate_ms: 3 },
      });
      await store.flush();
      expect(shipped.map((r) => [r.audience, r.category, r.level])).toEqual([
        ['user', 'log', 'info'],
        ['user', 'script_error', 'error'],
        ['support', 'runner', 'info'],
        ['user', 'runner', 'warning'],
        ['internal', 'perf', 'info'],
      ]);
      expect(shipped[4].duration_ms).toBe(12);
      expect(shipped[4].fields).toEqual({ hydrate_ms: 3 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
