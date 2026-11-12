import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

import { AttachmentBuilder } from 'discord.js';

import { countChannelMessages } from '../runtime/channel-activity.js';

/**
 * Parité JS des fonctions du moteur BDFD (`$floorDiv`, `$mod`, `$hash`, `$seededRandom`,
 * `$increment`, `$compareAndSetVar`, `$tryLock`/`$unlock`, `$createForumPost`, `$forumTags`,
 * `$setThreadTags`) : global `bc.math`, `bc.vars`, `bc.lock` et `bc.forum`.
 */

function toBig(value: unknown, what: string): bigint {
  try {
    if (typeof value === 'number') {
      if (!Number.isInteger(value)) throw new Error('not an integer');
      return BigInt(value);
    }
    return BigInt(String(value ?? '').trim());
  } catch {
    throw new Error(`${what} must be an integer.`);
  }
}

function flooredDivMod(a: bigint, b: bigint): [bigint, bigint] {
  if (b === 0n) throw new Error('Cannot divide by zero.');
  let q = a / b;
  let r = a - q * b;
  if (r !== 0n && r < 0n !== b < 0n) {
    q -= 1n;
    r += b;
  }
  return [q, r];
}

function numberResult(value: bigint): number | string {
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : value.toString();
}

export type HashAlgorithm = 'fnv1a' | 'crc32' | 'sha256';

function digestNumber(algorithm: HashAlgorithm, bytes: Buffer): bigint {
  if (algorithm === 'fnv1a') {
    let h = 0x811c9dc5;
    for (const b of bytes) {
      h ^= b;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return BigInt(h >>> 0);
  }
  if (algorithm === 'crc32') {
    let c = 0xffffffff;
    for (const b of bytes) {
      c ^= b;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
      }
    }
    return BigInt((c ^ 0xffffffff) >>> 0);
  }
  const d = createHash('sha256').update(bytes).digest();
  let n = 0n;
  for (let i = 0; i < 6; i++) n = (n << 8n) | BigInt(d[i]);
  return n;
}

export interface BcMath {
  /** Division entière « plancher » (`$floorDiv`) : floorDiv(-3, 8) = -1. */
  floorDiv(a: number | string | bigint, b: number | string | bigint): number | string;
  /** Reste toujours positif pour un diviseur positif (`$mod`) : mod(-3, 8) = 5. */
  mod(a: number | string | bigint, b: number | string | bigint): number | string;
  /** Empreinte déterministe (`$hash`) : fnv1a (défaut), crc32, ou sha256 (hex sans modulo). */
  hash(text: string, algorithm?: HashAlgorithm, modulo?: number | string | bigint): number | string;
  /** Entier reproductible dans [min, max] pour une même graine (`$seededRandom`). */
  seededRandom(seed: string, min: number | string | bigint, max: number | string | bigint): number | string;
}

export function createBcMath(): BcMath {
  return {
    floorDiv: (a, b) => numberResult(flooredDivMod(toBig(a, 'Each value'), toBig(b, 'Each value'))[0]),
    mod: (a, b) => numberResult(flooredDivMod(toBig(a, 'Each value'), toBig(b, 'Each value'))[1]),
    hash(text, algorithm = 'fnv1a', modulo) {
      const algo = String(algorithm || 'fnv1a').toLowerCase() as HashAlgorithm;
      if (!['fnv1a', 'crc32', 'sha256'].includes(algo)) {
        throw new Error('The algorithm must be fnv1a, crc32 or sha256.');
      }
      const bytes = Buffer.from(String(text), 'utf8');
      if (modulo === undefined || modulo === null || modulo === '') {
        return algo === 'sha256'
          ? createHash('sha256').update(bytes).digest('hex')
          : numberResult(digestNumber(algo, bytes));
      }
      const m = toBig(modulo, 'The modulo');
      if (m <= 0n) throw new Error('The modulo must be positive.');
      return numberResult(digestNumber(algo, bytes) % m);
    },
    seededRandom(seed, min, max) {
      const low = toBig(min, 'Each value');
      const high = toBig(max, 'Each value');
      if (high < low) throw new Error('The maximum is below the minimum.');
      const n = digestNumber('sha256', Buffer.from(String(seed), 'utf8'));
      return numberResult(low + (n % (high - low + 1n)));
    },
  };
}

// ---------------------------------------------------------------------------
// Variables atomiques et verrous nommés
// ---------------------------------------------------------------------------

type DbScope = 'user' | 'guild' | 'channel' | 'message' | 'guildMember' | 'global';

interface ScopedDb {
  get(key: string, id?: string): Promise<unknown>;
  set(key: string, value: unknown, id?: string): Promise<void>;
}

const variableLocks = new Map<string, Promise<void>>();

async function withVariableLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = variableLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => done);
  variableLocks.set(key, tail);
  try {
    await previous;
    return await action();
  } finally {
    release();
    if (variableLocks.get(key) === tail) variableLocks.delete(key);
  }
}

const namedLocks = new Map<string, number>();
const DEFAULT_LOCK_TTL_MS = 30_000;
const MAX_LOCK_TTL_MS = 10 * 60_000;

export interface BcVars {
  /** Ajoute `amount` (1 par défaut) de façon atomique (`$increment`) ; renvoie la nouvelle valeur. */
  increment(scope: DbScope, key: string, amount?: number, id?: string): Promise<number>;
  /** Idem en retranchant (`$decrement`). */
  decrement(scope: DbScope, key: string, amount?: number, id?: string): Promise<number>;
  /** Écrit `next` seulement si la valeur actuelle vaut `expected` (`$compareAndSetVar`). */
  compareAndSet(scope: DbScope, key: string, expected: unknown, next: unknown, id?: string): Promise<boolean>;
  /** Ajoute `item` à la liste `,a,b,` seulement s'il n'y est pas déjà (atomique). */
  listAddUnique(scope: DbScope, key: string, item: string, id?: string): Promise<boolean>;
  /** Noms des variables globales qui commencent par `prefix`, triés (`$listVars`), 100 par défaut, 1000 au plus. */
  list(prefix: string, limit?: number): Promise<string[]>;
}

export interface TileRect {
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
}

export interface BcGrid {
  /**
   * Rectangles d'une grille de tuiles carrées (`$canvasTileGrid`) : une couleur par tuile, ligne par ligne,
   * une couleur vide laisse la tuile non peinte. À dessiner avec la bibliothèque canvas de votre choix.
   */
  tiles(options: { x?: number; y?: number; columns: number; rows: number; size: number; gap?: number; colors: string[] }): TileRect[];
}

export interface BcCanvas {
  /** Crée un canvas (`$canvasCreate`) : largeur et hauteur de 1 à 4096, fond optionnel (nom CSS ou hex). Renvoie un canvas node-canvas ; `getContext('2d')` pour dessiner. */
  create(width: number, height: number, background?: string): unknown;
  /** Dessine des rectangles de `bc.grid.tiles` sur un contexte 2D. */
  drawTiles(ctx: unknown, tiles: TileRect[]): void;
  /** Pièce jointe PNG (`$attachImage`) d'un canvas ou d'un Buffer : à mettre dans `files: [...]`. */
  attach(source: unknown, name?: string): AttachmentBuilder;
}

export interface BcActivity {
  /** Messages envoyés dans le salon pendant les N dernières minutes (`$channelMessageCount`), sans lire le texte. */
  messageCount(channelId: string, minutes?: number, humansOnly?: boolean): number;
}

export interface BcLock {
  /** Prend le verrou nommé (`$tryLock`) ; faux s'il est déjà pris. Expire seul (30 s par défaut, 10 min au plus). */
  tryLock(name: string, ttlSeconds?: number): boolean;
  unlock(name: string): void;
}

export function createBcVars(botId: string, getDb: () => unknown): BcVars {
  function scoped(scope: DbScope): { get: ScopedDb['get']; set: ScopedDb['set'] } {
    const db = getDb() as Record<string, unknown> | undefined;
    if (!db) throw new Error('The bot has no storage available.');
    if (scope === 'global') {
      const g = db.global as { get(k: string): Promise<unknown>; set(k: string, v: unknown): Promise<void> };
      return { get: (k) => g.get(k), set: (k, v) => g.set(k, v) };
    }
    const target = db[scope] as ScopedDb | undefined;
    if (!target) throw new Error(`Unknown scope: ${scope}.`);
    return target;
  }
  const lockKey = (scope: string, key: string, id?: string): string => `${botId}|${scope}|${key}|${id ?? ''}`;
  async function add(scope: DbScope, key: string, amount: number, id?: string): Promise<number> {
    if (!Number.isFinite(amount)) throw new Error('The amount must be a number.');
    return withVariableLock(lockKey(scope, key, id), async () => {
      const store = scoped(scope);
      const raw = await store.get(key, id);
      const current = raw === undefined || raw === null || raw === '' ? 0 : Number(raw);
      if (!Number.isFinite(current)) throw new Error(`Variable ${key} is not a number.`);
      const next = current + amount;
      await store.set(key, next, id);
      return next;
    });
  }
  return {
    increment: (scope, key, amount = 1, id) => add(scope, key, amount, id),
    decrement: (scope, key, amount = 1, id) => add(scope, key, -amount, id),
    compareAndSet: (scope, key, expected, next, id) =>
      withVariableLock(lockKey(scope, key, id), async () => {
        const store = scoped(scope);
        const current = await store.get(key, id);
        if (String(current ?? '') !== String(expected ?? '')) return false;
        await store.set(key, next, id);
        return true;
      }),
    async list(prefix, limit = 100) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('The limit must be between 1 and 1000.');
      const db = getDb() as { global?: { keys?: () => Promise<string[]> } } | undefined;
      const keys = (await db?.global?.keys?.()) ?? [];
      return keys.filter((k) => k.startsWith(prefix)).sort().slice(0, limit);
    },
    listAddUnique: (scope, key, item, id) =>
      withVariableLock(lockKey(scope, key, id), async () => {
        const store = scoped(scope);
        const current = String((await store.get(key, id)) ?? '');
        const token = `,${item},`;
        if (current.includes(token)) return false;
        await store.set(key, current === '' ? token : `${current}${item},`, id);
        return true;
      }),
  };
}

export function createBcGrid(): BcGrid {
  return {
    tiles({ x = 0, y = 0, columns, rows, size, gap = 0, colors }) {
      if (![columns, rows, size, gap, x, y].every(Number.isInteger)) throw new Error('The grid values must be integers.');
      if (columns < 1 || rows < 1 || columns * rows > 1024) throw new Error('A tile grid has 1 to 1024 tiles.');
      if (size < 1 || gap < 0) throw new Error('The tile size must be positive and the gap not negative.');
      const out: TileRect[] = [];
      for (let i = 0; i < columns * rows && i < colors.length; i++) {
        const color = String(colors[i] ?? '').trim();
        if (!color) continue;
        out.push({
          x: x + (i % columns) * (size + gap),
          y: y + Math.floor(i / columns) * (size + gap),
          width: size,
          height: size,
          color,
        });
      }
      return out;
    },
  };
}

const MAX_CANVAS_SIDE = 4096;

export function createBcCanvas(): BcCanvas {
  const load = (): { createCanvas(w: number, h: number): any } => {
    try {
      return createRequire(import.meta.url)('canvas');
    } catch {
      throw new Error('The canvas library is not available in this runner.');
    }
  };
  return {
    create(width, height, background) {
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > MAX_CANVAS_SIDE || height > MAX_CANVAS_SIDE) {
        throw new Error(`The canvas size must be integers between 1 and ${MAX_CANVAS_SIDE}.`);
      }
      const canvas = load().createCanvas(width, height);
      if (background) {
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, width, height);
      }
      return canvas;
    },
    drawTiles(ctx, tiles) {
      const c = ctx as { fillStyle: string; fillRect(x: number, y: number, w: number, h: number): void };
      for (const t of tiles) {
        c.fillStyle = t.color;
        c.fillRect(t.x, t.y, t.width, t.height);
      }
    },
    attach(source, name = 'canvas.png') {
      const buffer = Buffer.isBuffer(source)
        ? source
        : typeof (source as { toBuffer?: unknown })?.toBuffer === 'function'
          ? (source as { toBuffer(type: string): Buffer }).toBuffer('image/png')
          : null;
      if (!buffer) throw new Error('attach expects a canvas or a Buffer.');
      return new AttachmentBuilder(buffer, { name: /\.[a-z0-9]+$/i.test(name) ? name : `${name}.png` });
    },
  };
}

export function createBcActivity(botId: string): BcActivity {
  return {
    messageCount: (channelId, minutes = 60, humansOnly = false) =>
      countChannelMessages(botId, String(channelId).trim(), minutes, humansOnly),
  };
}

export function createBcLock(botId: string): BcLock {
  return {
    tryLock(name, ttlSeconds) {
      const key = `${botId}|${name}`;
      const ttl = Math.min(
        MAX_LOCK_TTL_MS,
        ttlSeconds && ttlSeconds > 0 ? ttlSeconds * 1000 : DEFAULT_LOCK_TTL_MS,
      );
      const now = Date.now();
      const until = namedLocks.get(key);
      if (until !== undefined && until > now) return false;
      namedLocks.set(key, now + ttl);
      return true;
    },
    unlock(name) {
      namedLocks.delete(`${botId}|${name}`);
    },
  };
}

// ---------------------------------------------------------------------------
// Forum
// ---------------------------------------------------------------------------

interface ForumTag {
  id: string;
  name: string;
}
interface ForumLike {
  availableTags?: ForumTag[];
  threads?: { create(options: Record<string, unknown>): Promise<{ id: string }> };
}
interface ThreadLike {
  id: string;
  parent?: ForumLike | null;
  setAppliedTags?(tags: string[]): Promise<unknown>;
}

export interface BcForumPostOptions {
  /** Étiquettes : identifiants ou noms. 5 au plus. */
  tags?: string[];
  /** Archivage automatique en minutes : 60, 1440, 4320 ou 10080 (1440 par défaut). */
  archiveMinutes?: number;
  /** Fichiers joints au premier message (pièces d'un message discord.js). */
  files?: unknown[];
}

export interface BcForum {
  /** Crée un post dans un forum (`$createForumPost`) ; renvoie l'identifiant du fil. */
  createPost(forumId: string, title: string, message: string, options?: BcForumPostOptions): Promise<string>;
  /** Liste les étiquettes (`$forumTags`). */
  tags(forumId: string): Promise<ForumTag[]>;
  /** Remplace les étiquettes d'un post (`$setThreadTags`). */
  setTags(threadId: string, tags: string[]): Promise<void>;
}

function resolveTags(available: ForumTag[], wanted: string[]): string[] {
  if (wanted.length > 5) throw new Error('A forum post takes at most 5 tags.');
  const out: string[] = [];
  for (const raw of wanted) {
    const key = String(raw).trim();
    if (!key) continue;
    const hit =
      available.find((t) => String(t.id) === key) ??
      available.find((t) => t.name.toLowerCase() === key.toLowerCase());
    if (!hit) throw new Error(`Unknown forum tag: ${key}.`);
    if (!out.includes(String(hit.id))) out.push(String(hit.id));
  }
  return out;
}

export function createBcForum(getClient: () => unknown): BcForum {
  type ClientLike = { channels: { fetch(id: string): Promise<unknown> } };
  const channels = (): ClientLike['channels'] => (getClient() as ClientLike).channels;
  async function forumOf(id: string): Promise<ForumLike> {
    const channel = (await channels().fetch(String(id).trim())) as ForumLike | null;
    if (!channel || !Array.isArray(channel.availableTags) || !channel.threads) {
      throw new Error('The channel is not a forum or media channel.');
    }
    return channel;
  }
  return {
    async createPost(forumId, title, message, options = {}) {
      if (!title.trim() || title.length > 100) throw new Error('Thread name must contain 1 to 100 characters.');
      if (message.length > 2000) throw new Error('The first message exceeds 2000 characters.');
      const archive = options.archiveMinutes ?? 1440;
      if (![60, 1440, 4320, 10080].includes(archive)) throw new Error('Invalid thread archive duration.');
      const forum = await forumOf(forumId);
      const tags = resolveTags(forum.availableTags ?? [], options.tags ?? []);
      const thread = await forum.threads!.create({
        name: title,
        autoArchiveDuration: archive,
        message: { ...(message.trim() ? { content: message } : {}), ...(options.files ? { files: options.files } : {}) },
        ...(tags.length ? { appliedTags: tags } : {}),
      });
      return String(thread.id);
    },
    async tags(forumId) {
      const forum = await forumOf(forumId);
      return (forum.availableTags ?? []).map((t) => ({ id: String(t.id), name: t.name }));
    },
    async setTags(threadId, tags) {
      const thread = (await channels().fetch(String(threadId).trim())) as ThreadLike | null;
      if (!thread?.parent || !thread.setAppliedTags) throw new Error('The channel is not a forum post.');
      await thread.setAppliedTags(resolveTags(thread.parent.availableTags ?? [], tags));
    },
  };
}
