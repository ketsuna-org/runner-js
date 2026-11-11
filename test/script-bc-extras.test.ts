import { describe, expect, test } from 'bun:test';

import { createBcForum, createBcLock, createBcMath, createBcVars } from '../src/scripts/script-bc-extras.js';

describe('bc.math', () => {
  const m = createBcMath();
  test('floorDiv and mod floor towards negative infinity', () => {
    expect(m.floorDiv(-3, 8)).toBe(-1);
    expect(m.floorDiv(17, 8)).toBe(2);
    expect(m.mod(-3, 8)).toBe(5);
    expect(m.mod(-8, 8)).toBe(0);
    expect(m.mod(19, 8)).toBe(3);
    expect(() => m.mod(1, 0)).toThrow();
  });
  test('hash matches the BDFD engine', () => {
    expect(m.hash('abc', 'fnv1a')).toBe(440920331);
    expect(m.hash('abc', 'crc32')).toBe(891568578);
    expect(m.hash('abc', 'sha256')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(m.hash('abc', 'fnv1a', 10)).toBe(1);
  });
  test('seededRandom is reproducible and bounded', () => {
    expect(m.seededRandom('x', 5, 5)).toBe(5);
    const a = m.seededRandom('world:1:2', 0, 99);
    expect(m.seededRandom('world:1:2', 0, 99)).toBe(a);
    expect(Number(a)).toBeGreaterThanOrEqual(0);
    expect(Number(a)).toBeLessThanOrEqual(99);
  });
});

describe('bc.vars and bc.lock', () => {
  function fakeDb() {
    const data = new Map<string, unknown>();
    return {
      global: { get: async (k: string) => data.get(k), set: async (k: string, v: unknown) => void data.set(k, v) },
    };
  }
  test('parallel increments never lose a write', async () => {
    const vars = createBcVars('bot', () => fakeDb2());
    const db = fakeDb();
    const v = createBcVars('bot', () => db);
    await Promise.all(Array.from({ length: 50 }, () => v.increment('global', 'hp', 2)));
    expect(await db.global.get('hp')).toBe(100);
    expect(vars).toBeDefined();
  });
  test('compareAndSet and listAddUnique', async () => {
    const db = fakeDb();
    const v = createBcVars('bot', () => db);
    expect(await v.compareAndSet('global', 'k', '', 'a')).toBe(true);
    expect(await v.compareAndSet('global', 'k', '', 'b')).toBe(false);
    expect(await v.listAddUnique('global', 'l', '1')).toBe(true);
    expect(await v.listAddUnique('global', 'l', '1')).toBe(false);
    expect(await db.global.get('l')).toBe(',1,');
  });
  test('tryLock is exclusive until unlocked', () => {
    const l = createBcLock('b');
    expect(l.tryLock('x')).toBe(true);
    expect(l.tryLock('x')).toBe(false);
    l.unlock('x');
    expect(l.tryLock('x')).toBe(true);
  });
  function fakeDb2() {
    return fakeDb();
  }
});

describe('bc.forum', () => {
  test('creates a post resolving tag names', async () => {
    let created: Record<string, unknown> | undefined;
    const forum = {
      availableTags: [{ id: '5', name: 'City' }],
      threads: { create: async (o: Record<string, unknown>) => ((created = o), { id: '90' }) },
    };
    const f = createBcForum(() => ({ channels: { fetch: async () => forum } }));
    expect(await f.createPost('1', 'Town', 'Founded', { tags: ['city'] })).toBe('90');
    expect(created?.appliedTags).toEqual(['5']);
    await expect(f.createPost('1', 'Town', 'x', { tags: ['nope'] })).rejects.toThrow();
  });
});

import { clearChannelActivity, countChannelMessages, recordChannelMessage } from '../src/runtime/channel-activity.js';

describe('channel activity and list', () => {
  test('counts by window and by human author', () => {
    clearChannelActivity();
    const now = Date.now();
    recordChannelMessage('b', 'c', true, now - 90 * 60_000);
    recordChannelMessage('b', 'c', true, now - 10 * 60_000);
    recordChannelMessage('b', 'c', false, now - 5 * 60_000);
    expect(countChannelMessages('b', 'c', 60, false, now)).toBe(2);
    expect(countChannelMessages('b', 'c', 60, true, now)).toBe(1);
    expect(countChannelMessages('b', 'c', 300, false, now)).toBe(3);
    expect(countChannelMessages('b', 'x', 300, false, now)).toBe(0);
  });
  test('vars.list filters by prefix', async () => {
    const db = { global: { keys: async () => ['chunk_1_0', 'chunk_0_0', 'other'] } };
    const v = createBcVars('bot', () => db);
    expect(await v.list('chunk_')).toEqual(['chunk_0_0', 'chunk_1_0']);
    expect(await v.list('chunk_', 1)).toEqual(['chunk_0_0']);
  });
});

import { createBcGrid } from '../src/scripts/script-bc-extras.js';
describe('bc.grid', () => {
  test('tiles matches $canvasTileGrid', () => {
    const t = createBcGrid().tiles({ columns: 2, rows: 2, size: 2, gap: 1, colors: ['red', '', 'blue', 'green'] });
    expect(t).toEqual([
      { x: 0, y: 0, width: 2, height: 2, color: 'red' },
      { x: 0, y: 3, width: 2, height: 2, color: 'blue' },
      { x: 3, y: 3, width: 2, height: 2, color: 'green' },
    ]);
  });
});
