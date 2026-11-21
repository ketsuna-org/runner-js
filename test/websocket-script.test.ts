import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { parseJsBotConfig } from '../src/config/js-bot-config.js';
import { BotStore } from '../src/runtime/bot-store.js';
import { WebSocketSourceManager, type WsEvent } from '../src/runtime/websocket/ws-manager.js';
import { parseWebSocketSources } from '../src/runtime/websocket/ws-source.js';
import { createBcWs } from '../src/scripts/script-ws.js';
import { sanitizeConfigForScript } from '../src/scripts/script-config-sanitize.js';

const rawSource = {
  id: 's1',
  name: 'feed',
  url: 'wss://example.com/x',
  workflowName: 'w',
  script: 'bc.ws.event',
  secrets: { KEY: 'top-secret-value' },
  headers: [{ name: 'Authorization', value: 'Bearer {{secret.KEY}}' }],
};

describe('bc.ws', () => {
  test('without a bridge every operation rejects ws_unavailable and status is closed', async () => {
    const ws = createBcWs(undefined, undefined);
    expect(ws.event).toBeNull();
    await expect(ws.join('feed')).rejects.toMatchObject({ code: 'ws_unavailable' });
    expect(ws.lastError()).toBe('ws_unavailable');
    expect(ws.status('feed')).toBe('closed');
  });

  test('event exposes json and payload without interpreting the message', () => {
    const event: WsEvent = {
      source: 'feed',
      event: 'message',
      message: '{"a":{"b":7},"t":"{{secret.KEY}}"}',
      closeCode: null,
      closeReason: '',
      error: '',
      reconnected: false,
      gapMs: 0,
      context: 'room',
    };
    const ws = createBcWs(undefined, event);
    expect(ws.event?.payload('a.b')).toBe('7');
    expect(ws.event?.payload('t')).toBe('{{secret.KEY}}');
    expect(ws.event?.json).toEqual({ a: { b: 7 }, t: '{{secret.KEY}}' });
    expect(ws.event?.context).toBe('room');
  });

  test('operations reach the bridge and errors carry the ws_* code', async () => {
    const m = new WebSocketSourceManager({ botId: 'b', onEvent: async () => {}, connector: async () => { throw new Error('boom'); } });
    m.updateSources(parseWebSocketSources([{ ...rawSource, mode: 'on_demand' }]));
    const ws = createBcWs(m, undefined);
    await expect(ws.join('nope')).rejects.toMatchObject({ code: 'ws_unknown_source' });
    await expect(ws.join('feed')).rejects.toMatchObject({ code: 'ws_connect_failed' });
    expect(ws.lastError()).toBe('ws_connect_failed');
    await expect(ws.send('feed', 'x')).rejects.toMatchObject({ code: 'ws_not_open' });
  });
});

describe('secrets never leak', () => {
  test('config parses and scripts only see names', () => {
    const config = parseJsBotConfig({ token: 't', webSocketSources: [rawSource] });
    expect(config.webSocketSources).toHaveLength(1);
    const seen = JSON.stringify(sanitizeConfigForScript(config));
    expect(seen).not.toContain('top-secret-value');
    expect(seen).not.toContain('Bearer');
    expect(seen).toContain('feed');
  });

  test('secrets are not written to disk but survive in memory', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ws-store-'));
    const store = new BotStore(dir);
    await store.save('bot1', 'Bot', parseJsBotConfig({ token: 't', webSocketSources: [rawSource] }));
    const onDisk = await readFile(path.join(dir, 'bot1.json'), 'utf8');
    expect(onDisk).not.toContain('top-secret-value');
    const loaded = await store.load('bot1');
    expect((loaded!.config.webSocketSources![0] as { secrets: Record<string, string> }).secrets.KEY).toBe('top-secret-value');
  });

  test('absent key means no sources', () => {
    expect(parseJsBotConfig({ token: 't' }).webSocketSources).toBeUndefined();
  });
});
