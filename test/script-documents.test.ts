import { describe, expect, test } from 'bun:test';

import {
  DocumentsGatewayError,
  ManagedDocumentsGateway,
  type DocSpace,
  type DocumentsGateway,
} from '../src/documents/documents-gateway.js';
import { BcDbError, createBcDb } from '../src/scripts/script-documents.js';

interface Call {
  route: string;
  space: DocSpace;
  collection?: string;
  payload: unknown;
}

function stub(replies: Record<string, unknown>, fail?: string): { gw: DocumentsGateway; calls: Call[] } {
  const calls: Call[] = [];
  const check = (): void => {
    if (fail) throw new DocumentsGatewayError(fail);
  };
  const gw: DocumentsGateway = {
    async apply(_b, space, ops) {
      calls.push({ route: 'apply', space, payload: ops });
      check();
      return replies.apply as never;
    },
    async get(_b, space, collection, id) {
      calls.push({ route: 'get', space, collection, payload: id });
      check();
      return (replies.get ?? null) as never;
    },
    async find(_b, space, collection, query) {
      calls.push({ route: 'find', space, collection, payload: query });
      check();
      return replies.find as never;
    },
    async aggregate(_b, space, collection, request) {
      calls.push({ route: 'aggregate', space, collection, payload: request });
      check();
      return replies.aggregate as never;
    },
  };
  return { gw, calls };
}

const host = (gw: DocumentsGateway | null, guildId: string | undefined = 'g1') => ({
  gateway: () => gw,
  botId: () => 'bot1',
  guildId: () => guildId,
  userId: () => 'u1',
});

describe('bc.db', () => {
  test('space(guild, id) names a server where the bot is present, without a current server', async () => {
    const { gw, calls } = stub({ get: null });
    const db = createBcDb({ ...host(gw, undefined), hasGuild: (id: string) => id === '222' });
    db.space('guild', '222');
    await db.exists('c', 'a');
    db.space('guild');
    expect(() => db.space('guild', '333')).toThrow('The bot is not in this server.');
    expect(() => db.space('user', '222')).toThrow('Only the guild space takes a server ID.');
    expect(() => db.space('guild', 'abc')).toThrow('Invalid guild ID.');
    expect(calls.map((c) => c.space)).toEqual([{ kind: 'guild', id: '222' }]);
  });

  test('uses the current server, then user and bot spaces on request', async () => {
    const { gw, calls } = stub({ get: { id: 'a', data: { n: 5 }, rev: 1 } });
    const db = createBcDb(host(gw));
    expect(await db.get('c', 'a', 'n')).toBe(5);
    expect(await db.get('c', 'a')).toEqual({ n: 5 });
    db.space('user');
    await db.exists('c', 'a');
    db.space('bot');
    await db.exists('c', 'a');
    expect(calls.map((c) => c.space)).toEqual([
      { kind: 'guild', id: 'g1' },
      { kind: 'guild', id: 'g1' },
      { kind: 'user', id: 'u1' },
      { kind: 'bot', id: '_' },
    ]);
  });

  test('a private message falls back to the author space', async () => {
    const { gw, calls } = stub({ get: null });
    await createBcDb(host(gw, '')).get('c', 'a');
    expect(calls[0]?.space).toEqual({ kind: 'user', id: 'u1' });
  });

  test('get returns the fallback for a missing document or field', async () => {
    const { gw } = stub({ get: null });
    expect(await createBcDb(host(gw)).get('c', 'a', 'n', 'none')).toBe('none');
    const { gw: gw2 } = stub({ get: { id: 'a', data: {}, rev: 1 } });
    expect(await createBcDb(host(gw2)).get('c', 'a', 'n.m', 0)).toBe(0);
  });

  test('writes send the Manager operations and return revisions or values', async () => {
    const { gw, calls } = stub({ apply: [{ doc: { rev: 3, data: { n: 8, p: { q: 1 } } } }] });
    const db = createBcDb(host(gw));
    expect(await db.set('c', 'a', { n: 1 })).toBe(3);
    expect(await db.update('c', 'a', 'p.q', 7)).toBe(3);
    expect(await db.increment('c', 'a', 'n', 3, 0, 100)).toBe(8);
    expect(await db.push('c', 'a', 't', 1, 10)).toBe(3);
    const ops = calls.map((c) => (c.payload as Array<Record<string, unknown>>)[0]);
    expect(ops[0]).toEqual({ op: 'set', collection: 'c', id: 'a', value: { n: 1 } });
    expect(ops[1]).toEqual({ op: 'merge', collection: 'c', id: 'a', value: { p: { q: 7 } } });
    expect(ops[2]).toEqual({ op: 'incr', collection: 'c', id: 'a', path: 'n', delta: 3, min: 0, max: 100 });
    expect(ops[3]).toEqual({ op: 'push', collection: 'c', id: 'a', path: 't', value: 1, max_len: 10 });
  });

  test('delete, transfer, batch', async () => {
    const { gw, calls } = stub({ apply: [{ deleted: true }] });
    const db = createBcDb(host(gw));
    expect(await db.delete('c', 'a')).toBe(true);
    expect(await db.transfer('c', 'a', 'b', 'p', 4)).toBe(true);
    expect(calls[1]?.payload).toEqual([{ op: 'transfer', collection: 'c', id: 'a', to_id: 'b', path: 'p', delta: 4 }]);
    expect(await db.batch([{ op: 'delete', collection: 'c', id: 'a' }])).toEqual([{ deleted: true }]);
    await expect(db.batch('x' as never)).rejects.toBeInstanceOf(BcDbError);
  });

  test('find, count, top and rank build the Manager queries', async () => {
    const { gw, calls } = stub({
      find: { docs: [{ id: 'b' }], next: 'cur' },
      aggregate: { count: 2, docs: [{ id: 'b' }], rank: 1 },
    });
    const db = createBcDb(host(gw));
    expect(await db.find('c', 'n', '>', 1, { sort: '-n', limit: 5, after: 'x' })).toEqual({ docs: [{ id: 'b' }], next: 'cur' });
    expect(calls[0]?.payload).toEqual({ where: { n: { $gt: 1 } }, sort: [['n', 'desc']], limit: 5, after: 'x' });
    await db.find('c', { where: { n: { $eq: 1 } } });
    expect(calls[1]?.payload).toEqual({ where: { n: { $eq: 1 } } });
    expect(await db.count('c')).toBe(2);
    expect(calls[2]?.payload).toEqual({ op: 'count', where: {} });
    expect(await db.count('c', 'n', '>=', 3)).toBe(2);
    expect(await db.top('c', 'n', 3, 'asc')).toEqual([{ id: 'b' }]);
    expect(calls[4]?.payload).toEqual({ op: 'top', field: 'n', n: 3, desc: false });
    expect(await db.rank('c', 'n', 'b')).toBe(1);
    expect(calls[5]?.payload).toEqual({ op: 'rank', field: 'n', id: 'b', desc: true });
  });

  test('a data error does not throw: null and lastError', async () => {
    for (const code of ['conflict', 'quota', 'needs_index', 'timeout']) {
      const { gw } = stub({}, code);
      const db = createBcDb(host(gw));
      expect(await db.create('c', 'a', {})).toBeNull();
      expect(db.lastError()).toBe(code);
    }
    const { gw } = stub({ apply: [{ doc: { rev: 1, data: {} } }] });
    const db = createBcDb(host(gw));
    await db.set('c', 'a', {});
    expect(db.lastError()).toBe('');
  });

  test('invalid or unavailable throws', async () => {
    const { gw } = stub({}, 'invalid');
    await expect(createBcDb(host(gw)).set('c', 'a', {})).rejects.toMatchObject({ code: 'invalid' });
    await expect(createBcDb(host(null)).get('c', 'a')).rejects.toMatchObject({ code: 'unavailable' });
    const ok = stub({}).gw;
    const db = createBcDb(host(ok));
    await expect(db.set('c', 'a', 'x' as never)).rejects.toBeInstanceOf(BcDbError);
    await expect(db.increment('c', 'a', 'n', 'abc' as never)).rejects.toBeInstanceOf(BcDbError);
    await expect(db.find('c', 'n', '~' as never, 1)).rejects.toBeInstanceOf(BcDbError);
    expect(() => db.space('nope' as never)).toThrow(BcDbError);
  });

  test('cooldown: 0 when started, seconds left when running', async () => {
    let created = false;
    const exp = new Date(Date.now() + 30_000).toISOString();
    const gw: DocumentsGateway = {
      async apply() {
        if (created) throw new DocumentsGatewayError('conflict');
        created = true;
        return [{ doc: { rev: 1, data: {} } }];
      },
      async get() {
        return { id: 'a', data: {}, rev: 1, expires_at: exp };
      },
      async find() {
        return {};
      },
      async aggregate() {
        return {};
      },
    };
    const db = createBcDb(host(gw));
    expect(await db.cooldown('c', 'a', 60)).toBe(0);
    const left = await db.cooldown('c', 'a', 60);
    expect(left).toBeGreaterThan(25);
    expect(left).toBeLessThanOrEqual(30);
    expect(db.lastError()).toBe('');
    await expect(db.cooldown('c', 'a', 0)).rejects.toBeInstanceOf(BcDbError);
  });
});

describe('ManagedDocumentsGateway', () => {
  const make = (status: number, body: unknown): { gw: ManagedDocumentsGateway; seen: Array<{ url: string; init: RequestInit }> } => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    return { gw: new ManagedDocumentsGateway({ baseUrl: 'http://m/internal/runners/o/', token: 't', fetchImpl }), seen };
  };

  test('posts the Manager JSON with the runner token', async () => {
    const { gw, seen } = make(200, { results: [{ deleted: true }], doc: { id: 'a', data: {}, rev: 1 } });
    const space: DocSpace = { kind: 'guild', id: 'g1' };
    expect(await gw.apply('bot 1', space, [{ op: 'delete' }])).toEqual([{ deleted: true }]);
    expect((await gw.get('bot 1', space, 'c', 'a'))?.rev).toBe(1);
    expect(seen[0]?.url).toBe('http://m/internal/runners/o/bots/bot%201/data/apply');
    expect((seen[0]?.init.headers as Record<string, string>).Authorization).toBe('Bearer t');
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual({ space, ops: [{ op: 'delete' }] });
    expect(JSON.parse(String(seen[1]?.init.body))).toEqual({ space, collection: 'c', id: 'a' });
  });

  test('typed codes survive, others become unavailable', async () => {
    await expect(make(409, { code: 'conflict', message: 'x' }).gw.get('b', { kind: 'bot', id: '_' }, 'c', 'a')).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(make(500, { code: 'data_error' }).gw.get('b', { kind: 'bot', id: '_' }, 'c', 'a')).rejects.toMatchObject({
      code: 'unavailable',
    });
  });

  test('installs only with a managed runner configuration', () => {
    expect(ManagedDocumentsGateway.install({ managedRunnerApi: '', managedRunnerToken: '' })).toBe(false);
    expect(ManagedDocumentsGateway.install({ managedRunnerApi: 'http://m', managedRunnerToken: 't' })).toBe(true);
  });
});
