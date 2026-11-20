import { mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';

import { FILE_MAX_BYTES, FilesGatewayError, type BotFileInfo, type FilesGateway, setFilesGateway } from './files-gateway.js';

/**
 * Fichiers d'un bot local (desktop) : un dossier du PC, `<racine>/<bot>/<chemin>`. Mêmes règles de chemin, de taille et
 * d'encodage des noms que le moteur Dart (`LocalBotFilesGateway`), pour qu'un bot garde ses fichiers quel que soit
 * le moteur qui l'exécute. Pas de quota (c'est le disque de la personne) et pas de lien public.
 */

const SAFE = /[A-Za-z0-9._ -]/;
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
/** Marque des écritures en cours : `%00` n'apparaît jamais dans un nom encodé. */
const PART_MARKER = '%00part.';

const hex = (byte: number): string => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;

export function normalizeFilePath(raw: string): string {
  const path = raw.trim();
  if (
    path === '' ||
    Buffer.byteLength(path) > 255 ||
    path.startsWith('/') ||
    path.endsWith('/') ||
    path.includes('\\') ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/.test(path)
  ) {
    throw new FilesGatewayError('file_invalid_path');
  }
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new FilesGatewayError('file_invalid_path');
    }
  }
  return path;
}

export function encodeSegment(segment: string): string {
  let out = '';
  for (const byte of Buffer.from(segment, 'utf8')) {
    out += byte < 0x80 && SAFE.test(String.fromCharCode(byte)) ? String.fromCharCode(byte) : hex(byte);
  }
  if (out.endsWith('.') || out.endsWith(' ')) {
    out = out.slice(0, -1) + hex(out.charCodeAt(out.length - 1));
  }
  if (RESERVED.test(out)) {
    out = hex(out.charCodeAt(0)) + out.slice(1);
  }
  return out;
}

export function decodeSegment(segment: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < segment.length; i++) {
    const c = segment.charCodeAt(i);
    if (c === 0x25 && i + 3 <= segment.length) {
      const value = Number.parseInt(segment.slice(i + 1, i + 3), 16);
      if (/^[0-9a-fA-F]{2}$/.test(segment.slice(i + 1, i + 3)) && !Number.isNaN(value)) {
        bytes.push(value);
        i += 2;
        continue;
      }
    }
    bytes.push(c);
  }
  return Buffer.from(bytes).toString('utf8');
}

const TYPES: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/plain',
  json: 'application/json',
  csv: 'text/csv',
  html: 'text/html',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
};

const contentTypeFor = (path: string): string => TYPES[path.slice(path.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream';

export class LocalFilesGateway implements FilesGateway {
  constructor(readonly root: string) {}

  /** Installe la passerelle locale si `BOT_CREATOR_LOCAL_FILES_DIR` est posé. */
  static install(env: { localFilesDir?: string }): boolean {
    const root = (env.localFilesDir ?? '').trim();
    if (!root) {
      return false;
    }
    setFilesGateway(new LocalFilesGateway(root));
    return true;
  }

  #botDir(botId: string): string {
    const id = botId.trim();
    if (id === '' || /[/\\:*?"<>|]/.test(id) || id === '.' || id === '..') {
      throw new FilesGatewayError('file_invalid_path');
    }
    return join(this.root, id);
  }

  #file(botId: string, path: string): string {
    const parts = normalizeFilePath(path).split('/').map(encodeSegment);
    return join(this.#botDir(botId), ...parts);
  }

  async put(botId: string, path: string, data: Uint8Array, contentType: string): Promise<BotFileInfo> {
    const normalized = normalizeFilePath(path);
    if (data.byteLength > FILE_MAX_BYTES) {
      throw new FilesGatewayError('file_too_large');
    }
    const file = this.#file(botId, normalized);
    try {
      await mkdir(join(file, '..'), { recursive: true });
      const temp = `${file}${PART_MARKER}${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
      await writeFile(temp, data);
      await rename(temp, file);
    } catch (error) {
      if (error instanceof FilesGatewayError) {
        throw error;
      }
      throw new FilesGatewayError('files_unavailable');
    }
    return { path: normalized, size: data.byteLength, contentType: contentType || contentTypeFor(normalized), updatedAt: new Date().toISOString() };
  }

  async get(botId: string, path: string): Promise<{ data: Uint8Array; contentType: string }> {
    try {
      return { data: new Uint8Array(await readFile(this.#file(botId, path))), contentType: contentTypeFor(path) };
    } catch (error) {
      throw error instanceof FilesGatewayError ? error : new FilesGatewayError('file_not_found');
    }
  }

  async list(botId: string, prefix: string, limit: number, after: string): Promise<BotFileInfo[]> {
    const dir = this.#botDir(botId);
    const out: BotFileInfo[] = [];
    const walk = async (current: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = join(current, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile() && !full.includes(PART_MARKER)) {
          const logical = full
            .slice(dir.length + 1)
            .split(sep)
            .map(decodeSegment)
            .join('/');
          if (logical.startsWith(prefix) && logical > after) {
            const info = await stat(full);
            out.push({ path: logical, size: info.size, contentType: contentTypeFor(logical), updatedAt: info.mtime.toISOString() });
          }
        }
      }
    };
    await walk(dir);
    out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return out.slice(0, limit);
  }

  async delete(botId: string, path: string): Promise<boolean> {
    const file = this.#file(botId, path);
    if (!(await this.exists(botId, path))) {
      return false;
    }
    try {
      await rm(file);
    } catch {
      throw new FilesGatewayError('files_unavailable');
    }
    // Retire les dossiers vides laissés derrière, sans jamais sortir du dossier du bot.
    const stop = this.#botDir(botId);
    let dir = join(file, '..');
    while (dir !== stop && dir.startsWith(stop)) {
      try {
        if ((await readdir(dir)).length > 0) {
          break;
        }
        await rmdir(dir);
      } catch {
        break;
      }
      dir = join(dir, '..');
    }
    return true;
  }

  async exists(botId: string, path: string): Promise<boolean> {
    try {
      return (await stat(this.#file(botId, path))).isFile();
    } catch (error) {
      if (error instanceof FilesGatewayError) {
        throw error;
      }
      return false;
    }
  }

  async url(): Promise<string> {
    throw new FilesGatewayError('file_url_unavailable');
  }
}
