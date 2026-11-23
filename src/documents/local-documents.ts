/**
 * Base de données d'un runner SANS Manager (self-host, ou une page de test) : `bc.db` / `$db*` stockés dans SQLite.
 *
 * C'est un PORT du moteur Dart `MemoryBotDocumentService` + `LocalBotDocumentService` (packages/shared de bot-creator) :
 * mêmes opérations, mêmes formes de résultat, mêmes codes d'erreur, même schéma de fichier SQLite. Les cas de
 * conformance (`test/fixtures/document-conformance.json`, copie de `document_conformance.json` côté Dart) sont rejoués
 * des deux côtés : ne changer une règle qu'aux deux endroits.
 *
 * Les documents d'un bot sont chargés en mémoire à la première utilisation et écrits dans SQLite à chaque écriture
 * (seuls les documents touchés). Pas de quota : c'est le disque de la personne.
 */
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  DocumentsGatewayError,
  type DocSpace,
  type DocumentRecord,
  type DocumentsGateway,
} from './documents-gateway.js';

type Json = Record<string, unknown>;

interface Doc {
  id: string;
  data: Json;
  rev: number;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date | null;
}

type Collection = Map<string, Doc>;
type SpaceData = Map<string, Collection>;

const COLLECTION_RE = /^[a-z0-9_][a-z0-9_.-]{0,63}$/;
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*){0,3}$/;
const SPACE_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const MAX_SAFE = 9007199254740991;

export interface LocalDocumentsOptions {
  dir: string;
  maxDocBytes?: number;
  maxTxnOps?: number;
  maxPage?: number;
  now?: () => Date;
}

function fail(code: string, message: string): never {
  throw new DocumentsGatewayError(code, message);
}

function utf8Length(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cmp(a: string | number, b: string | number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareKeys(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') {
    return cmp(a, b);
  }
  return cmp(String(a), String(b));
}

function docJson(collection: string, d: Doc): DocumentRecord {
  return {
    collection,
    id: d.id,
    data: clone(d.data),
    rev: d.rev,
    created_at: d.createdAt.toISOString(),
    updated_at: d.updatedAt.toISOString(),
    ...(d.expiresAt ? { expires_at: d.expiresAt.toISOString() } : {}),
  };
}

function checkCollection(c: string): void {
  if (!COLLECTION_RE.test(c)) {
    fail('invalid', 'collection must match [a-z0-9_][a-z0-9_.-]{0,63}');
  }
}

function checkId(id: string): void {
  if (id.length === 0 || utf8Length(id) > 128) {
    fail('invalid', 'document id must be 1 to 128 bytes');
  }
}

function checkKeys(v: unknown, depth: number): void {
  if (depth > 16) {
    fail('invalid', 'document nested deeper than 16');
  }
  if (Array.isArray(v)) {
    for (const x of v) {
      checkKeys(x, depth + 1);
    }
  } else if (isObject(v)) {
    for (const [k, x] of Object.entries(v)) {
      if (k === '' || k === '__proto__' || k.startsWith('$')) {
        fail('invalid', `key "${k}" is not allowed`);
      }
      checkKeys(x, depth + 1);
    }
  }
}

function toObject(raw: unknown): Json {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      fail('invalid', 'invalid json');
    }
  }
  if (!isObject(value)) {
    fail('invalid', 'document must be a json object');
  }
  const m = clone(value);
  checkKeys(m, 0);
  return m;
}

function mergePatch(target: Json, patch: Json): Json {
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined) {
      delete target[k];
    } else if (isObject(v)) {
      const t = target[k];
      target[k] = mergePatch(isObject(t) ? { ...t } : {}, { ...v });
    } else {
      target[k] = v;
    }
  }
  return target;
}

function parsePath(p: string): string[] {
  if (p === '') {
    fail('invalid', 'a path is required');
  }
  const parts = p.split('.');
  if (parts.length > 8) {
    fail('invalid', 'path too deep');
  }
  for (const s of parts) {
    if (s === '' || s === '__proto__' || s.startsWith('$')) {
      fail('invalid', `path segment "${s}" is not allowed`);
    }
  }
  return parts;
}

function getPath(doc: Json, path: string[]): unknown {
  let cur: unknown = doc;
  for (const k of path) {
    if (!isObject(cur) || !Object.prototype.hasOwnProperty.call(cur, k)) {
      return null;
    }
    cur = cur[k];
  }
  return cur;
}

function setPath(doc: Json, path: string[], v: unknown): void {
  let cur = doc;
  for (const k of path.slice(0, -1)) {
    const next = cur[k];
    if (next === undefined || next === null) {
      const m: Json = {};
      cur[k] = m;
      cur = m;
    } else if (isObject(next)) {
      cur = next;
    } else {
      fail('invalid', 'path crosses a value that is not an object');
    }
  }
  cur[path[path.length - 1]!] = v;
}

function add(a: number, b: number): number {
  if (Number.isInteger(a) && Number.isInteger(b)) {
    const s = a + b;
    if (s > MAX_SAFE || s < -MAX_SAFE) {
      fail('conflict', 'integer overflow (limit 2^53-1)');
    }
    return s;
  }
  return a + b;
}

interface Pred {
  field: string;
  op: string;
  value: unknown;
}

const OPERATORS: Record<string, string> = {
  $eq: 'eq',
  $ne: 'ne',
  $lt: 'lt',
  $lte: 'lte',
  $gt: 'gt',
  $gte: 'gte',
  $in: 'in',
  $prefix: 'prefix',
};

function makePred(field: string, op: string, value: unknown): Pred {
  if (op === 'in') {
    if (!Array.isArray(value) || value.length === 0) {
      fail('invalid', '$in needs a list of 1 to 100 values');
    }
  } else if (typeof value !== 'number' && typeof value !== 'string' && typeof value !== 'boolean') {
    fail('invalid', 'filter values must be string, number or boolean');
  }
  if (op === 'prefix' && typeof value !== 'string') {
    fail('invalid', '$prefix needs a string');
  }
  return { field, op, value };
}

function compileWhere(where: unknown): Pred[] {
  if (where === null || where === undefined) {
    return [];
  }
  if (!isObject(where)) {
    fail('invalid', 'where must be an object');
  }
  const preds: Pred[] = [];
  for (const key of Object.keys(where).sort()) {
    if (key.startsWith('$')) {
      fail('invalid', `${key} is not supported yet`);
    }
    if (!FIELD_RE.test(key)) {
      fail('invalid', `field "${key}" invalid`);
    }
    const cond = where[key];
    if (isObject(cond)) {
      for (const op of Object.keys(cond).sort()) {
        const name = OPERATORS[op];
        if (!name) {
          fail('invalid', `operator "${op}" is not supported`);
        }
        preds.push(makePred(key, name, cond[op]));
      }
    } else {
      preds.push(makePred(key, 'eq', cond));
    }
  }
  if (preds.length > 8) {
    fail('invalid', 'too many predicates (max 8)');
  }
  return preds;
}

function testPred(p: Pred, data: Json): boolean {
  let cur: unknown = data;
  for (const k of p.field.split('.')) {
    if (!isObject(cur) || !Object.prototype.hasOwnProperty.call(cur, k)) {
      return false;
    }
    cur = cur[k];
  }
  if (cur === null || cur === undefined) {
    return false;
  }
  const same = (v: unknown): boolean => typeof v === typeof cur && ['boolean', 'number', 'string'].includes(typeof v);
  const one = (v: unknown): boolean => same(v) && v === cur;
  switch (p.op) {
    case 'eq':
      return one(p.value);
    case 'ne':
      return same(p.value) && !one(p.value);
    case 'in':
      return (p.value as unknown[]).some(one);
    case 'prefix':
      return typeof cur === 'string' && cur.startsWith(p.value as string);
    default: {
      let c: number;
      if (typeof p.value === 'number' && typeof cur === 'number') {
        c = cmp(cur, p.value);
      } else if (typeof p.value === 'string' && typeof cur === 'string') {
        c = cmp(cur, p.value);
      } else {
        return false;
      }
      return p.op === 'lt' ? c < 0 : p.op === 'lte' ? c <= 0 : p.op === 'gt' ? c > 0 : c >= 0;
    }
  }
}

function encodeCursor(value: unknown, id: string): string {
  return Buffer.from(JSON.stringify({ v: value ?? null, id }), 'utf8').toString('base64url');
}

function decodeCursor(s: string): { value: unknown; id: string } {
  try {
    const m = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as unknown;
    if (isObject(m) && typeof m.id === 'string' && m.id !== '') {
      return { value: m.v, id: m.id };
    }
  } catch {
    // retombe sur l'erreur typée
  }
  fail('invalid', 'invalid cursor');
}

/** La base d'UN bot : en mémoire, écrite dans `<dir>/<bot>.sqlite`. */
class BotDocuments {
  readonly #spaces = new Map<string, SpaceData>();
  readonly #db: Database;

  constructor(
    path: string,
    readonly limits: { maxDocBytes: number; maxTxnOps: number; maxPage: number },
    readonly now: () => Date,
  ) {
    this.#db = new Database(path, { create: true });
    this.#db.run('PRAGMA journal_mode = WAL');
    this.#db.run(`CREATE TABLE IF NOT EXISTS documents (
      space_kind TEXT NOT NULL, space_id TEXT NOT NULL, collection TEXT NOT NULL, id TEXT NOT NULL, doc TEXT NOT NULL,
      PRIMARY KEY (space_kind, space_id, collection, id))`);
    this.#db.run(`CREATE TABLE IF NOT EXISTS collections (
      space_kind TEXT NOT NULL, name TEXT NOT NULL, config TEXT NOT NULL, PRIMARY KEY (space_kind, name))`);
    this.#db.run('CREATE TABLE IF NOT EXISTS trash (trash_id INTEGER PRIMARY KEY AUTOINCREMENT, entry TEXT NOT NULL)');
    const rows = this.#db
      .query('SELECT space_kind, space_id, collection, doc FROM documents')
      .all() as Array<{ space_kind: string; space_id: string; collection: string; doc: string }>;
    for (const r of rows) {
      const j = JSON.parse(r.doc) as Json;
      const doc: Doc = {
        id: String(j.id),
        data: (j.data as Json) ?? {},
        rev: typeof j.rev === 'number' ? j.rev : 1,
        createdAt: new Date(String(j.created_at)),
        updatedAt: new Date(String(j.updated_at ?? j.created_at)),
        expiresAt: j.expires_at ? new Date(String(j.expires_at)) : null,
      };
      this.#collection(this.#space({ kind: r.space_kind as DocSpace['kind'], id: r.space_id }), r.collection).set(doc.id, doc);
    }
  }

  close(): void {
    this.#db.close();
  }

  #space(space: DocSpace): SpaceData {
    switch (space.kind) {
      case 'bot':
        break;
      case 'guild':
      case 'user':
        if (!SPACE_ID_RE.test(space.id)) {
          fail('invalid', 'invalid space id');
        }
        break;
      default:
        fail('invalid', 'space kind must be guild, bot or user');
    }
    const key = space.kind === 'bot' ? 'bot:_' : `${space.kind}:${space.id}`;
    let data = this.#spaces.get(key);
    if (!data) {
      data = new Map();
      this.#spaces.set(key, data);
    }
    return data;
  }

  #collection(space: SpaceData, name: string): Collection {
    let c = space.get(name);
    if (!c) {
      c = new Map();
      space.set(name, c);
    }
    return c;
  }

  #live(coll: Collection | undefined, id: string): Doc | null {
    const d = coll?.get(id);
    if (!d) {
      return null;
    }
    if (d.expiresAt && d.expiresAt.getTime() <= this.now().getTime()) {
      return null;
    }
    return d;
  }

  // ---- writes ----

  apply(space: DocSpace, ops: Json[]): Array<Record<string, unknown>> {
    if (ops.length === 0) {
      fail('invalid', 'no operation');
    }
    if (ops.length > this.limits.maxTxnOps) {
      fail('invalid', `a batch holds at most ${this.limits.maxTxnOps} operations`);
    }
    const spaceData = this.#space(space);
    // Tout ou rien : on garde une copie des tables touchées et on la remet si une opération échoue.
    const touched = new Set<string>();
    for (const op of ops) {
      const c = String(op.collection ?? '');
      checkCollection(c);
      touched.add(c);
    }
    const snapshot = new Map<string, Collection | undefined>();
    for (const c of touched) {
      const coll = spaceData.get(c);
      snapshot.set(
        c,
        coll ? new Map([...coll].map(([k, d]) => [k, { ...d, data: clone(d.data) }])) : undefined,
      );
    }
    try {
      const results: Array<Record<string, unknown>> = [];
      for (const op of ops) {
        const kind = String(op.op);
        const collection = String(op.collection);
        if (kind === 'transfer') {
          results.push(...this.#transfer(spaceData, op, collection));
        } else {
          results.push(this.#mutate(spaceData, op, kind, collection));
        }
      }
      this.#persist(space, spaceData, ops);
      return results;
    } catch (error) {
      for (const [c, coll] of snapshot) {
        if (coll) {
          spaceData.set(c, coll);
        } else {
          spaceData.delete(c);
        }
      }
      throw error;
    }
  }

  #persist(space: DocSpace, spaceData: SpaceData, ops: Json[]): void {
    const keys = new Set<string>();
    for (const op of ops) {
      const c = String(op.collection ?? '');
      if (op.id !== undefined && op.id !== null) {
        keys.add(`${c}\u0000${String(op.id)}`);
      }
      if (op.to_id !== undefined && op.to_id !== null) {
        keys.add(`${c}\u0000${String(op.to_id)}`);
      }
    }
    for (const key of keys) {
      const [c, id] = key.split('\u0000') as [string, string];
      const doc = spaceData.get(c)?.get(id);
      if (doc) {
        this.#db.run('INSERT OR REPLACE INTO documents (space_kind, space_id, collection, id, doc) VALUES (?, ?, ?, ?, ?)', [
          space.kind,
          space.id,
          c,
          id,
          JSON.stringify(docJson(c, doc)),
        ]);
      } else {
        this.#db.run('DELETE FROM documents WHERE space_kind = ? AND space_id = ? AND collection = ? AND id = ?', [
          space.kind,
          space.id,
          c,
          id,
        ]);
      }
    }
  }

  #transfer(spaceData: SpaceData, op: Json, collection: string): Array<Record<string, unknown>> {
    const from = String(op.id ?? '');
    const to = String(op.to_id ?? '');
    const path = String(op.path ?? '');
    const amount = op.delta;
    if (from === '' || to === '' || from === to || path === '') {
      fail('invalid', 'transfer needs two different ids and a path');
    }
    if (typeof amount !== 'number' || amount <= 0) {
      fail('invalid', 'transfer amount must be positive');
    }
    const debit = { op: 'incr', collection, id: from, path, delta: -amount, min: op.min ?? 0 };
    const credit: Json = { op: 'incr', collection, id: to, path, delta: amount, ...(op.max != null ? { max: op.max } : {}) };
    const debitFirst = from < to;
    const first = this.#mutate(spaceData, debitFirst ? debit : credit, 'incr', collection);
    const second = this.#mutate(spaceData, debitFirst ? credit : debit, 'incr', collection);
    return debitFirst ? [first, second] : [second, first];
  }

  #mutate(spaceData: SpaceData, op: Json, kind: string, collection: string): Record<string, unknown> {
    const id = String(op.id ?? '');
    checkId(id);
    const coll = spaceData.get(collection);
    const existing = this.#live(coll, id);
    const rev = op.rev;
    if (rev !== undefined && rev !== null && (!existing || existing.rev !== rev)) {
      fail('conflict', 'revision mismatch');
    }
    if (kind === 'delete') {
      const had = coll?.delete(id) ?? false;
      return { deleted: had && existing !== null };
    }
    let next: Json;
    switch (kind) {
      case 'set':
        next = toObject(op.value);
        break;
      case 'create':
        if (existing) {
          fail('conflict', 'document already exists');
        }
        next = toObject(op.value);
        break;
      case 'merge':
        next = mergePatch(clone(existing?.data ?? {}), toObject(op.value));
        break;
      case 'incr':
      case 'push':
      case 'pull':
      case 'addToSet':
        next = this.#mutatePath(existing?.data, op, kind);
        break;
      default:
        fail('invalid', `unknown operation "${kind}"`);
    }
    const size = utf8Length(JSON.stringify(next));
    if (size > this.limits.maxDocBytes) {
      fail('quota', `document is ${size} bytes, limit ${this.limits.maxDocBytes}`);
    }
    const ttl = op.ttl_seconds;
    if (ttl !== undefined && ttl !== null && (!Number.isInteger(ttl) || (ttl as number) < 1)) {
      fail('invalid', 'ttl must be at least 1 second');
    }
    const target = this.#collection(spaceData, collection);
    const at = this.now();
    let doc: Doc;
    if (existing) {
      doc = existing;
      doc.data = next;
      doc.rev += 1;
    } else {
      doc = { id, data: next, rev: 1, createdAt: at, updatedAt: at, expiresAt: null };
      target.set(id, doc);
    }
    if (typeof ttl === 'number') {
      doc.expiresAt = new Date(at.getTime() + ttl * 1000);
    }
    doc.updatedAt = at;
    return { doc: docJson(collection, doc) };
  }

  #mutatePath(base: Json | undefined, op: Json, kind: string): Json {
    const path = parsePath(String(op.path ?? ''));
    const doc = clone(base ?? {});
    const cur = getPath(doc, path);
    if (kind === 'incr') {
      const delta = op.delta;
      if (typeof delta !== 'number') {
        fail('invalid', 'incr needs a delta');
      }
      if (cur !== null && typeof cur !== 'number') {
        fail('invalid', 'target is not a number');
      }
      const sum = add(typeof cur === 'number' ? cur : 0, delta);
      const { min, max } = op;
      if (typeof min === 'number' && sum < min) {
        fail('conflict', `value would go below minimum ${min}`);
      }
      if (typeof max === 'number' && sum > max) {
        fail('conflict', `value would exceed maximum ${max}`);
      }
      setPath(doc, path, sum);
      return doc;
    }
    if (cur !== null && !Array.isArray(cur)) {
      fail('invalid', 'target is not a list');
    }
    let list: unknown[] = Array.isArray(cur) ? [...cur] : [];
    const value = op.value;
    const maxLen = op.max_len;
    const same = (x: unknown): boolean => JSON.stringify(x) === JSON.stringify(value);
    if (kind === 'push') {
      list.push(value);
    } else if (kind === 'addToSet') {
      if (!list.some(same)) {
        list.push(value);
      }
    } else if (kind === 'pull') {
      list = list.filter((x) => !same(x));
    }
    if (kind !== 'pull' && typeof maxLen === 'number' && Number.isInteger(maxLen) && maxLen > 0 && list.length > maxLen) {
      list = list.slice(list.length - maxLen);
    }
    setPath(doc, path, list);
    return doc;
  }

  // ---- reads ----

  get(space: DocSpace, collection: string, id: string): DocumentRecord | null {
    checkCollection(collection);
    checkId(id);
    const d = this.#live(this.#space(space).get(collection), id);
    return d ? docJson(collection, d) : null;
  }

  #matching(space: DocSpace, collection: string, preds: Pred[]): Doc[] {
    const coll = this.#space(space).get(collection);
    if (!coll) {
      return [];
    }
    const out: Doc[] = [];
    for (const d of coll.values()) {
      if (this.#live(coll, d.id) && preds.every((p) => testPred(p, d.data))) {
        out.push(d);
      }
    }
    return out;
  }

  find(space: DocSpace, collection: string, query: Json): Record<string, unknown> {
    checkCollection(collection);
    const preds = compileWhere(query.where);
    let limit = Number.isInteger(query.limit) ? (query.limit as number) : this.limits.maxPage;
    if (limit <= 0 || limit > this.limits.maxPage) {
      limit = this.limits.maxPage;
    }
    const sort = query.sort;
    let field: string | null = null;
    let desc = false;
    if (Array.isArray(sort) && sort.length > 0) {
      if (sort.length > 1) {
        fail('invalid', 'a single sort field is supported');
      }
      const s = sort[0] as unknown[];
      field = String(s[0]);
      if (!FIELD_RE.test(field)) {
        fail('invalid', 'sort field invalid');
      }
      const dir = s.length > 1 ? String(s[1]) : 'asc';
      if (dir !== 'asc' && dir !== 'desc') {
        fail('invalid', 'sort order must be asc or desc');
      }
      desc = dir === 'desc';
    }
    let docs = this.#matching(space, collection, preds);
    const after = query.after;
    const cursor = typeof after === 'string' && after !== '' ? decodeCursor(after) : null;
    const keyOf = (d: Doc): unknown => (field === null ? null : getPath(d.data, field.split('.')));
    if (field !== null) {
      docs = docs.filter((d) => {
        const k = keyOf(d);
        return typeof k === 'number' || typeof k === 'string';
      });
    }
    docs.sort((a, b) => {
      let c = 0;
      if (field !== null) {
        c = compareKeys(keyOf(a), keyOf(b));
      }
      if (c === 0) {
        c = cmp(a.id, b.id);
      }
      return desc ? -c : c;
    });
    if (cursor) {
      docs = docs.filter((d) => {
        let c = 0;
        if (field !== null) {
          c = compareKeys(keyOf(d), cursor.value);
        }
        if (c === 0) {
          c = cmp(d.id, cursor.id);
        }
        return desc ? c < 0 : c > 0;
      });
    }
    const page = docs.slice(0, limit);
    const more = docs.length > limit;
    const last = page[page.length - 1];
    return {
      docs: page.map((d) => docJson(collection, d)),
      ...(more && last ? { next: encodeCursor(field === null ? null : keyOf(last), last.id) } : {}),
    };
  }

  aggregate(space: DocSpace, collection: string, request: Json): Record<string, unknown> {
    checkCollection(collection);
    const op = String(request.op);
    const desc = request.desc !== false;
    switch (op) {
      case 'count':
        return { count: this.#matching(space, collection, compileWhere(request.where)).length };
      case 'sum': {
        const field = String(request.field ?? '');
        if (!FIELD_RE.test(field)) {
          fail('invalid', 'field invalid');
        }
        let total = 0;
        for (const d of this.#matching(space, collection, compileWhere(request.where))) {
          const v = getPath(d.data, field.split('.'));
          if (typeof v === 'number') {
            total += v;
          }
        }
        return { sum: total };
      }
      case 'top': {
        const n = Number.isInteger(request.n) && (request.n as number) > 0 ? (request.n as number) : 10;
        const field = String(request.field ?? '');
        const page = this.find(space, collection, { sort: [[field, desc ? 'desc' : 'asc']], limit: n });
        return { docs: page.docs };
      }
      case 'rank': {
        const field = String(request.field ?? '');
        if (!FIELD_RE.test(field)) {
          fail('invalid', 'field invalid');
        }
        const doc = this.#live(this.#space(space).get(collection), String(request.id));
        const v = doc ? getPath(doc.data, field.split('.')) : null;
        if (typeof v !== 'number') {
          return { rank: 0 };
        }
        const ahead = this.#matching(space, collection, []).filter((d) => {
          const x = getPath(d.data, field.split('.'));
          return typeof x === 'number' && (desc ? x > v : x < v);
        }).length;
        return { rank: ahead + 1 };
      }
    }
    fail('invalid', 'op must be count, sum, top or rank');
  }
}

/** Passerelle `bc.db` d'un runner sans Manager : une base SQLite par bot dans `dir`. */
export class LocalDocumentsGateway implements DocumentsGateway {
  readonly #dir: string;
  readonly #limits: { maxDocBytes: number; maxTxnOps: number; maxPage: number };
  readonly #now: () => Date;
  readonly #bots = new Map<string, BotDocuments>();

  constructor(options: LocalDocumentsOptions) {
    this.#dir = options.dir;
    this.#limits = {
      maxDocBytes: options.maxDocBytes ?? 16 * 1024,
      maxTxnOps: options.maxTxnOps ?? 20,
      maxPage: options.maxPage ?? 100,
    };
    this.#now = options.now ?? (() => new Date());
  }

  #bot(botId: string): BotDocuments {
    const id = botId.trim();
    if (id === '' || /[/\\:*?"<>|]/.test(id) || id === '.' || id === '..') {
      fail('unavailable', 'No local database for this bot.');
    }
    let bot = this.#bots.get(id);
    if (!bot) {
      mkdirSync(this.#dir, { recursive: true });
      bot = new BotDocuments(join(this.#dir, `${id}.sqlite`), this.#limits, this.#now);
      this.#bots.set(id, bot);
    }
    return bot;
  }

  close(): void {
    for (const bot of this.#bots.values()) {
      bot.close();
    }
    this.#bots.clear();
  }

  async apply(botId: string, space: DocSpace, ops: Array<Record<string, unknown>>): Promise<Array<Record<string, unknown>>> {
    return this.#bot(botId).apply(space, ops);
  }

  async get(botId: string, space: DocSpace, collection: string, id: string): Promise<DocumentRecord | null> {
    return this.#bot(botId).get(space, collection, id);
  }

  async find(botId: string, space: DocSpace, collection: string, query: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.#bot(botId).find(space, collection, query);
  }

  async aggregate(botId: string, space: DocSpace, collection: string, request: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.#bot(botId).aggregate(space, collection, request);
  }
}
