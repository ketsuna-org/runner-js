import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FILE_MAX_BYTES } from '../src/files/files-gateway.js';
import { LocalFilesGateway } from '../src/files/local-files-gateway.js';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (data: Uint8Array): string => new TextDecoder().decode(data);

let dir: string;
let gw: LocalFilesGateway;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bcfiles-'));
  gw = new LocalFilesGateway(dir);
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('LocalFilesGateway', () => {
  test('écrit, remplace, liste, supprime et nettoie les dossiers vides', async () => {
    await gw.put('b1', 'a/b/c.txt', bytes('one'), '');
    await gw.put('b1', 'a/b/c.txt', bytes('two'), '');
    await gw.put('b1', 'a/d.png', bytes('x'), '');
    expect(text((await gw.get('b1', 'a/b/c.txt')).data)).toBe('two');
    expect((await gw.list('b1', 'a/', 100, '')).map((f) => f.path)).toEqual(['a/b/c.txt', 'a/d.png']);
    expect((await gw.list('b1', '', 100, 'a/b/c.txt')).map((f) => f.path)).toEqual(['a/d.png']);
    expect((await gw.get('b1', 'a/d.png')).contentType).toBe('image/png');
    expect(await gw.delete('b1', 'a/b/c.txt')).toBe(true);
    expect(await gw.delete('b1', 'a/b/c.txt')).toBe(false);
    await expect(stat(join(dir, 'b1', 'a', 'b'))).rejects.toBeDefined();
    expect(await gw.exists('b1', 'a/d.png')).toBe(true);
  });

  test('les noms interdits sous Windows font l’aller-retour et ne sortent pas du dossier', async () => {
    const names = ['what?.txt', 'a:b*c.txt', 'CON', 'end.', 'es pace', 'été/ça.txt', '100%.txt', '%2F'];
    for (const n of names) await gw.put('b1', n, bytes(n), '');
    expect(new Set((await gw.list('b1', '', 100, '')).map((f) => f.path))).toEqual(new Set(names));
    for (const n of names) expect(text((await gw.get('b1', n)).data)).toBe(n);
    await expect(gw.put('b1', '../escape', bytes('x'), '')).rejects.toMatchObject({ code: 'file_invalid_path' });
    await expect(gw.put('..', 'a', bytes('x'), '')).rejects.toMatchObject({ code: 'file_invalid_path' });
    await expect(gw.put('b1/../b2', 'a', bytes('x'), '')).rejects.toMatchObject({ code: 'file_invalid_path' });
  });

  test('limites, absent, lien indisponible, bots isolés', async () => {
    await expect(gw.put('b1', 'big', new Uint8Array(FILE_MAX_BYTES + 1), '')).rejects.toMatchObject({ code: 'file_too_large' });
    await expect(gw.get('b1', 'nope')).rejects.toMatchObject({ code: 'file_not_found' });
    await expect(gw.url()).rejects.toMatchObject({ code: 'file_url_unavailable' });
    await gw.put('b1', 'a.txt', bytes('x'), '');
    expect(await gw.exists('b2', 'a.txt')).toBe(false);
    expect(await gw.list('b2', '', 100, '')).toEqual([]);
  });

  test('install lit BOT_CREATOR_LOCAL_FILES_DIR', () => {
    expect(LocalFilesGateway.install({ localFilesDir: '' })).toBe(false);
    expect(LocalFilesGateway.install({ localFilesDir: dir })).toBe(true);
  });
});
