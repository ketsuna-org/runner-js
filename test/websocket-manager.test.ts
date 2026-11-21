import { describe, expect, test } from 'bun:test';

import { WebSocketSourceManager, type WsEvent } from '../src/runtime/websocket/ws-manager.js';
import { parseWebSocketSource, parseWebSocketSources, wsFilterMatches, wsJsonPath } from '../src/runtime/websocket/ws-source.js';
import { WsException, WsTokenBucket, wsReconnectDelay } from '../src/runtime/websocket/ws-support.js';
import {
  WsHandshakeException,
  isForbiddenAddress,
  type WsConnection,
  type WsConnector,
} from '../src/runtime/websocket/ws-transport.js';

class FakeConn implements WsConnection {
  sent: string[] = [];
  closedWith: number | null = null;
  private msg: ((d: string | Uint8Array) => void) | null = null;
  private cls: ((i: { code: number | null; reason: string; error: boolean }) => void) | null = null;
  constructor(private readonly onSend?: (c: FakeConn, t: string) => void) {}
  onMessage(h: (d: string | Uint8Array) => void) {
    this.msg = h;
  }
  onClose(h: (i: { code: number | null; reason: string; error: boolean }) => void) {
    this.cls = h;
  }
  send(t: string) {
    this.sent.push(t);
    this.onSend?.(this, t);
  }
  sendBinary() {}
  async close(code = 1000) {
    this.closedWith = code;
  }
  push(d: string | Uint8Array) {
    this.msg?.(d);
  }
  drop(code: number | null = 1006) {
    this.cls?.({ code, reason: '', error: false });
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function source(extra: Record<string, unknown> = {}) {
  return parseWebSocketSource({ id: 's1', name: 'feed', url: 'wss://example.com/x?k={{secret.KEY}}', workflowName: 'w', script: '1', secrets: { KEY: 'abc' }, ...extra })!;
}

function make(connect: WsConnector, events: WsEvent[], opts: Record<string, unknown> = {}) {
  return new WebSocketSourceManager({
    botId: 'b',
    onEvent: async (_s, e) => {
      events.push(e);
    },
    connector: connect,
    reconnectDelay: () => 5,
    ...opts,
  });
}

describe('parsing', () => {
  test('bounds and defaults', () => {
    const s = parseWebSocketSource({ name: 'a', url: 'wss://h', limits: { maxMessagesPerMinute: 99999, idleCloseMinutes: 0 } })!;
    expect(s.maxMessagesPerMinute).toBe(600);
    expect(s.idleCloseMinutes).toBe(1);
    expect(s.onDemand).toBe(false);
    expect(parseWebSocketSources([{ name: '' }, 3, null])).toEqual([]);
  });
  test('filters', () => {
    expect(wsFilterMatches({ kind: 'contains', text: 'hi', path: '', equals: '' }, 'oh hi')).toBe(true);
    const f = { kind: 'json' as const, text: '', path: 'a.b[1]', equals: '2' };
    expect(wsFilterMatches(f, '{"a":{"b":[1,2]}}')).toBe(true);
    expect(wsFilterMatches(f, 'nope')).toBe(false);
    expect(wsJsonPath({ a: [1] }, 'a.5')).toBeUndefined();
  });
});

describe('guard', () => {
  test('forbidden addresses', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '192.168.0.1', '172.16.0.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:10.0.0.1', '100.64.0.1'])
      expect(isForbiddenAddress(a)).toBe(true);
    for (const a of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) expect(isForbiddenAddress(a)).toBe(false);
  });
});

describe('manager', () => {
  test('join, message, send, secrets resolved, events delivered in order', async () => {
    const events: WsEvent[] = [];
    let seenUrl = '';
    const conn = new FakeConn();
    const m = make(async (url) => {
      seenUrl = url.toString();
      return conn;
    }, events);
    m.updateSources([source({ mode: 'on_demand', joinSequence: [{ send: 'hello {{ctx}} {{secret.KEY}}' }] })]);
    await m.join('feed', 'room1');
    expect(seenUrl).toContain('k=abc');
    expect(conn.sent[0]).toBe('hello room1 abc');
    conn.push('one');
    conn.push('two');
    await wait(20);
    expect(events.map((e) => e.event + ':' + e.message)).toEqual(['open:', 'message:one', 'message:two']);
    await m.send('feed', 'ping');
    expect(conn.sent.at(-1)).toBe('ping');
    expect(m.status('feed')).toBe('open');
    await m.close('feed');
    expect(m.status('feed')).toBe('closed');
  });

  test('send errors and unknown source', async () => {
    const m = make(async () => new FakeConn(), []);
    m.updateSources([source({ mode: 'on_demand' })]);
    await expect(m.send('feed', 'x')).rejects.toMatchObject({ code: 'ws_not_open' });
    await expect(m.join('nope')).rejects.toMatchObject({ code: 'ws_unknown_source' });
    await m.join('feed');
    await expect(m.send('feed', 'x'.repeat(300 * 1024))).rejects.toMatchObject({ code: 'ws_message_too_big' });
    await expect(m.sendBinary('feed', new Uint8Array(1))).rejects.toMatchObject({ code: 'ws_binary_refused' });
  });

  test('filter and rate limit drop messages', async () => {
    const events: WsEvent[] = [];
    const conn = new FakeConn();
    const m = make(async () => conn, events);
    m.updateSources([source({ mode: 'on_demand', filter: { kind: 'contains', text: 'keep' }, limits: { maxMessagesPerMinute: 2 } })]);
    await m.join('feed');
    for (const t of ['drop', 'keep1', 'keep2', 'keep3']) conn.push(t);
    await wait(20);
    const msgs = events.filter((e) => e.event === 'message').map((e) => e.message);
    expect(msgs).toEqual(['keep1', 'keep2']);
    const snap = m.snapshot()[0] as { counters: Record<string, number> };
    expect(snap.counters.dropped_filter).toBe(1);
    expect(snap.counters.dropped_rate).toBe(1);
  });

  test('join waitFor timeout is reported and refused', async () => {
    const events: WsEvent[] = [];
    const m = make(async () => new FakeConn(), events);
    m.updateSources([source({ mode: 'on_demand', joinSequence: [{ send: 'sub', waitFor: 'ok', timeoutMs: 500 }] })]);
    await expect(m.join('feed')).rejects.toMatchObject({ code: 'ws_join_timeout' });
    expect(m.status('feed')).toBe('closed');
  });

  test('join waitFor satisfied', async () => {
    const conn = new FakeConn((c) => queueMicrotask(() => c.push('{"ok":true}')));
    const m = make(async () => conn, []);
    m.updateSources([source({ mode: 'on_demand', joinSequence: [{ send: 'sub', waitFor: 'ok', timeoutMs: 1000 }] })]);
    await m.join('feed');
    expect(m.status('feed')).toBe('open');
  });

  test('permanent source reconnects after a drop and flags reconnected', async () => {
    const events: WsEvent[] = [];
    const conns: FakeConn[] = [];
    const m = make(async () => {
      const c = new FakeConn();
      conns.push(c);
      return c;
    }, events);
    m.updateSources([source()]);
    m.startPermanent();
    await wait(400);
    expect(conns.length).toBe(1);
    conns[0].drop();
    await wait(400);
    expect(conns.length).toBe(2);
    const opens = events.filter((e) => e.event === 'open');
    expect(opens.map((e) => e.reconnected)).toEqual([false, true]);
    expect(events.some((e) => e.event === 'close')).toBe(true);
    await m.stop();
  });

  test('stops after repeated auth refusals', async () => {
    let tries = 0;
    const m = make(async () => {
      tries++;
      throw new WsHandshakeException(401);
    }, []);
    m.updateSources([source()]);
    m.startPermanent();
    await wait(1200);
    expect(tries).toBe(3);
    expect(m.status('feed')).toBe('error');
    await m.stop();
  });

  test('too many open per bot', async () => {
    const m = make(async () => new FakeConn(), [], { maxOpen: 1 });
    m.updateSources([source({ mode: 'on_demand' }), source({ name: 'other', mode: 'on_demand' })]);
    await m.join('feed');
    await expect(m.join('other')).rejects.toMatchObject({ code: 'ws_too_many_open' });
    await m.stop();
  });

  test('idle close counts only bot actions', async () => {
    const conn = new FakeConn();
    const m = make(async () => conn, [], { minuteMs: 30 });
    m.updateSources([source({ mode: 'on_demand', limits: { idleCloseMinutes: 1 } })]);
    await m.join('feed');
    conn.push('noise');
    await wait(80);
    expect(m.status('feed')).toBe('closed');
    expect(conn.closedWith).toBe(1000);
  });

  test('oversize message closes with 1009', async () => {
    const conn = new FakeConn();
    const m = make(async () => conn, []);
    m.updateSources([source({ mode: 'on_demand', limits: { maxMessageBytes: 1024 } })]);
    await m.join('feed');
    conn.push('x'.repeat(2000));
    await wait(20);
    expect(conn.closedWith).toBe(1009);
    expect(m.status('feed')).toBe('error');
  });

  test('config change recreates the source; removal closes it', async () => {
    const conn = new FakeConn();
    const m = make(async () => conn, []);
    m.updateSources([source({ mode: 'on_demand' })]);
    await m.join('feed');
    m.updateSources([]);
    expect(m.status('feed')).toBe('closed');
    await expect(m.join('feed')).rejects.toBeInstanceOf(WsException);
  });
});

describe('support', () => {
  test('token bucket and reconnect delay', () => {
    let now = 0;
    const b = new WsTokenBucket(2, () => now);
    expect([b.take(), b.take(), b.take()]).toEqual([true, true, false]);
    now += 30000;
    expect(b.take()).toBe(true);
    expect(wsReconnectDelay(1, () => 0.5)).toBe(1000);
    expect(wsReconnectDelay(20, () => 0.5)).toBe(60000);
  });
});
