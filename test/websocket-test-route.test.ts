import { describe, expect, test } from 'bun:test';

import { runWebSocketTest } from '../src/runtime/websocket/ws-test.js';
import { WsHandshakeException, type WsConnection, type WsConnector } from '../src/runtime/websocket/ws-transport.js';

class Fake implements WsConnection {
  sent: string[] = [];
  closedWith: number | null = null;
  private msg: ((d: string | Uint8Array) => void) | null = null;
  private cls: ((i: { code: number | null; reason: string; error: boolean }) => void) | null = null;
  constructor(private readonly reply?: (c: Fake, t: string) => void) {}
  onMessage(h: (d: string | Uint8Array) => void) {
    this.msg = h;
  }
  onClose(h: (i: { code: number | null; reason: string; error: boolean }) => void) {
    this.cls = h;
  }
  send(t: string) {
    this.sent.push(t);
    setTimeout(() => this.reply?.(this, t), 1);
  }
  sendBinary() {}
  async close(code = 1000) {
    this.closedWith = code;
  }
  push(d: string) {
    this.msg?.(d);
  }
  drop() {
    this.cls?.({ code: 1011, reason: 'bye', error: false });
  }
}

const raw = (extra: Record<string, unknown> = {}) => ({
  id: 's',
  name: 'feed',
  url: 'wss://example.com/x',
  workflowName: 'w',
  secrets: { TOKEN: 'sekret-value' },
  joinSequence: [
    { send: '{"op":"auth","token":"{{secret.TOKEN}}"}', waitFor: 'authed', timeoutMs: 500 },
    { send: '{"op":"subscribe","room":"{{ctx}}"}' },
  ],
  ...extra,
});

describe('route de test', () => {
  test('joue la séquence, masque les secrets, ferme proprement', async () => {
    const conn = new Fake((c, t) => {
      if (t.includes('auth')) c.push('{"op":"authed"}');
      if (t.includes('subscribe')) {
        c.push('{"type":"tick","echo":"sekret-value"}');
        c.push('{"type":"tick"}');
      }
    });
    const connector: WsConnector = async () => conn;
    const result = await runWebSocketTest(raw(), { connector, totalMs: 200, maxMessages: 3, context: 'salon-1' });
    expect(result.ok).toBe(true);
    expect(conn.sent[0]).toContain('sekret-value');
    expect(conn.sent[1]).toContain('salon-1');
    expect(conn.closedWith).toBe(1000);
    const log = JSON.stringify(result.events);
    expect(log).not.toContain('sekret-value');
    expect(log).toContain('••••');
    expect(result.received).toBe(3);
  });

  test("s'arrête dès 20 messages vus", async () => {
    const conn = new Fake((c) => {
      for (let i = 0; i < 40; i++) c.push(`m${i}`);
    });
    const result = await runWebSocketTest(raw({ joinSequence: [{ send: 'hi' }] }), { connector: async () => conn, totalMs: 2000 });
    expect(result.ok).toBe(true);
    expect(result.received).toBe(20);
  });

  test('réponse attendue absente : ws_join_timeout et fermeture', async () => {
    const conn = new Fake();
    const result = await runWebSocketTest(raw(), { connector: async () => conn, totalMs: 1000 });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('ws_join_timeout');
    expect(conn.closedWith).toBe(1000);
  });

  test('refus d\'authentification de la poignée de main', async () => {
    const connector: WsConnector = async () => {
      throw new WsHandshakeException(401, 'unauthorized');
    };
    const result = await runWebSocketTest(raw(), { connector });
    expect(result.error).toBe('ws_auth_refused');
  });

  test('la fermeture par le service est dite', async () => {
    const conn = new Fake((c) => c.drop());
    const result = await runWebSocketTest(raw({ joinSequence: [{ send: 'hi' }] }), { connector: async () => conn, totalMs: 500 });
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.events)).toContain('closed by the service');
    expect(conn.closedWith).toBeNull();
  });

  test('source illisible', async () => {
    const result = await runWebSocketTest({}, {});
    expect(result.error).toBe('ws_unknown_source');
  });
});
