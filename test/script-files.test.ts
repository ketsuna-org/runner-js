import { describe, expect, test } from 'bun:test';

import { FilesGatewayError, ManagedFilesGateway, type FilesGateway } from '../src/files/files-gateway.js';
import { createBcFiles } from '../src/scripts/script-files.js';

function memoryGateway(): FilesGateway {
  const store = new Map<string, { data: Uint8Array; contentType: string }>();
  const key = (bot: string, path: string): string => `${bot}\0${path}`;
  return {
    async put(bot, path, data, contentType) {
      store.set(key(bot, path), { data, contentType });
      return { path, size: data.byteLength, contentType, updatedAt: '' };
    },
    async get(bot, path) {
      const found = store.get(key(bot, path));
      if (!found) throw new FilesGatewayError('file_not_found');
      return found;
    },
    async list(bot, prefix) {
      return [...store.entries()]
        .filter(([k]) => k.startsWith(`${bot}\0${prefix}`))
        .map(([k, v]) => ({ path: k.split('\0')[1] ?? '', size: v.data.byteLength, contentType: v.contentType, updatedAt: '' }));
    },
    async delete(bot, path) {
      return store.delete(key(bot, path));
    },
    async exists(bot, path) {
      return store.has(key(bot, path));
    },
    async url(_bot, path, ttl) {
      return `https://x/${path}?ttl=${ttl}`;
    },
  };
}

describe('bc.files', () => {
  test('écrit, lit, liste, teste, supprime', async () => {
    const files = createBcFiles(((gw) => () => gw)(memoryGateway()), () => 'bot1');
    await files.put('a/b.txt', 'héllo');
    expect(await files.getText('a/b.txt')).toBe('héllo');
    expect(await files.exists('a/b.txt')).toBe(true);
    expect((await files.list('a/')).map((f) => f.path)).toEqual(['a/b.txt']);
    expect(await files.delete('a/b.txt')).toBe(true);
    expect(await files.exists('a/b.txt')).toBe(false);
  });

  test('base64 et octets', async () => {
    const files = createBcFiles(((gw) => () => gw)(memoryGateway()), () => 'bot1');
    await files.put('x.bin', 'AAEC', { encoding: 'base64' });
    expect([...(await files.get('x.bin'))]).toEqual([0, 1, 2]);
    expect(await files.getText('x.bin', { encoding: 'base64' })).toBe('AAEC');
  });

  test('un fichier absent rejette file_not_found et lastError le garde', async () => {
    const files = createBcFiles(((gw) => () => gw)(memoryGateway()), () => 'bot1');
    await expect(files.get('nope')).rejects.toMatchObject({ code: 'file_not_found' });
    expect(files.lastError()).toBe('file_not_found');
    await files.exists('nope');
    expect(files.lastError()).toBe('');
  });

  test('sans passerelle : files_unavailable', async () => {
    const files = createBcFiles(() => null, () => 'bot1');
    await expect(files.put('a', 'b')).rejects.toMatchObject({ code: 'files_unavailable' });
  });

  test('attach rend une pièce jointe nommée, limitée à 10 Mo', async () => {
    const files = createBcFiles(((gw) => () => gw)(memoryGateway()), () => 'bot1');
    await files.put('exports/rapport.csv', 'a,b');
    await files.put('exports/notes', 'texte');
    const a = await files.attach('exports/rapport.csv');
    expect(a.name).toBe('rapport.csv');
    expect(Buffer.from(a.attachment as Buffer).toString()).toBe('a,b');
    expect((await files.attach('exports/notes', 'mémo')).name).toBe('mémo.bin');
    expect((await files.attach('exports/rapport.csv', 'classement.csv')).name).toBe('classement.csv');
    await files.put('big.bin', new Uint8Array(11 * 1024 * 1024));
    await expect(files.attach('big.bin')).rejects.toMatchObject({ code: 'file_too_large' });
    await expect(files.attach('absent')).rejects.toMatchObject({ code: 'file_not_found' });
  });

  test('le lien est borné à 7 jours', async () => {
    const files = createBcFiles(((gw) => () => gw)(memoryGateway()), () => 'bot1');
    expect(await files.url('a', { minutes: 999999 })).toBe(`https://x/a?ttl=${7 * 24 * 3600}`);
    expect(await files.url('a')).toBe('https://x/a?ttl=3600');
  });
});

describe('ManagedFilesGateway', () => {
  test('appelle les routes du Manager avec le jeton et rend les codes', async () => {
    const calls: Array<{ url: string; method: string; auth: string }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, method: String(init.method ?? 'GET'), auth: String((init.headers as Record<string, string>).Authorization) });
      if (url.includes('/files/put')) {
        return new Response(JSON.stringify({ path: 'a.txt', size: 2, content_type: 'text/plain', updated_at: 't' }));
      }
      return new Response(JSON.stringify({ code: 'file_quota_exceeded' }), { status: 403 });
    }) as unknown as typeof fetch;
    const gw = new ManagedFilesGateway({ baseUrl: 'https://m/internal/runners/o/', token: 'tok', fetchImpl });
    const info = await gw.put('b 1', 'a.txt', new Uint8Array([1, 2]), 'text/plain');
    expect(info).toEqual({ path: 'a.txt', size: 2, contentType: 'text/plain', updatedAt: 't' });
    expect(calls[0]).toEqual({ url: 'https://m/internal/runners/o/bots/b%201/files/put?path=a.txt', method: 'POST', auth: 'Bearer tok' });
    await expect(gw.get('b', 'a.txt')).rejects.toMatchObject({ code: 'file_quota_exceeded' });
  });
});
