import { DocumentsGatewayError, type DocSpace, type DocSpaceKind, type DocumentsGateway } from '../documents/documents-gateway.js';

/** Erreur d'un appel `bc.db` qui est une faute du script (`invalid`) ou une base absente (`unavailable`). */
export class BcDbError extends Error {
  constructor(readonly code: string, message?: string) {
    super(message ?? code);
    this.name = 'BcDbError';
  }
}

type Op = '=' | '==' | '!=' | '<' | '<=' | '>' | '>=' | 'in' | 'prefix';
const OPERATORS: Record<string, string> = {
  '=': '$eq',
  '==': '$eq',
  '!=': '$ne',
  '<': '$lt',
  '<=': '$lte',
  '>': '$gt',
  '>=': '$gte',
  in: '$in',
  prefix: '$prefix',
};

export interface BcDbFindOptions {
  /** `'points'`, `'-points'` (décroissant) ou `'points:desc'`. */
  sort?: string;
  limit?: number;
  after?: string;
}

export interface BcDb {
  /**
   * Change d'espace pour la suite du script : `'guild'` (défaut), `'user'` (l'auteur) ou `'bot'`.
   * `space('guild', id)` nomme un serveur où le bot est présent (utile dans une tâche planifiée, qui n'a pas de serveur courant).
   */
  space(kind: DocSpaceKind, guildId?: string): void;
  /** Document (ou le champ `path`) ; `fallback` s'il n'existe pas ou en cas d'erreur de donnée. */
  get(collection: string, id: string, path?: string, fallback?: unknown): Promise<unknown>;
  exists(collection: string, id: string): Promise<boolean>;
  /** Écrit le document ; rend sa révision, ou `null` si une erreur de donnée (voir `lastError`). */
  set(collection: string, id: string, value: Record<string, unknown>): Promise<number | null>;
  create(collection: string, id: string, value: Record<string, unknown>): Promise<number | null>;
  /** Fixe le champ `path` (pointé : `a.b`). */
  update(collection: string, id: string, path: string, value: unknown): Promise<number | null>;
  /** Ajoute `delta` au champ numérique ; rend la nouvelle valeur. `min` et `max` bornent le résultat. */
  increment(collection: string, id: string, path: string, delta: number, min?: number, max?: number): Promise<number | null>;
  push(collection: string, id: string, path: string, value: unknown, maxLen?: number): Promise<number | null>;
  pull(collection: string, id: string, path: string, value: unknown): Promise<number | null>;
  addToSet(collection: string, id: string, path: string, value: unknown, maxLen?: number): Promise<number | null>;
  delete(collection: string, id: string): Promise<boolean | null>;
  /** Retire `amount` du champ de `id` et l'ajoute à `toId`, atomiquement. */
  transfer(collection: string, id: string, toId: string, path: string, amount: number): Promise<boolean>;
  /** Opérations atomiques (tout ou rien) ; rend un résultat par opération, ou `null`. */
  batch(ops: Array<Record<string, unknown>>): Promise<Array<Record<string, unknown>> | null>;
  find(collection: string, field: string, op: Op, value: unknown, options?: BcDbFindOptions): Promise<{ docs: unknown[]; next?: string } | null>;
  find(collection: string, query: Record<string, unknown>): Promise<{ docs: unknown[]; next?: string } | null>;
  count(collection: string, field?: string, op?: Op, value?: unknown): Promise<number | null>;
  top(collection: string, field: string, n: number, order?: 'asc' | 'desc'): Promise<unknown[] | null>;
  rank(collection: string, field: string, id: string, order?: 'asc' | 'desc'): Promise<number | null>;
  /** Démarre un délai de `seconds` s sur `id` : rend 0 s'il vient de démarrer, sinon les secondes restantes. */
  cooldown(collection: string, id: string, seconds: number): Promise<number | null>;
  /** Code de la dernière erreur de donnée (`conflict`, `quota`, `needs_index`, `timeout`), vide si l'appel a réussi. */
  lastError(): string;
}

export interface BcDbHost {
  gateway: () => DocumentsGateway | null;
  botId: () => string;
  guildId: () => string | undefined;
  userId: () => string | undefined;
  /** Le bot est-il présent sur ce serveur ? Sans cela, seul le serveur courant peut être nommé. */
  hasGuild?: (guildId: string) => boolean;
}

function pathValue(data: Record<string, unknown>, path: string): unknown {
  let cur: unknown = data;
  for (const key of path.split('.')) {
    if (!cur || typeof cur !== 'object' || !(key in (cur as Record<string, unknown>))) {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function num(value: unknown, what: string): number {
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n) || String(value).trim() === '') {
    throw new BcDbError('invalid', `${what} must be a number.`);
  }
  return n;
}

function object(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new BcDbError('invalid', 'A JSON object is required.');
}

function sortOf(sort: string): [string, string] {
  const s = sort.trim();
  if (s.startsWith('-')) return [s.slice(1), 'desc'];
  if (s.includes(':')) {
    const [field = '', dir = 'asc'] = s.split(':');
    return [field, dir];
  }
  return [s, 'asc'];
}

/**
 * `bc.db` : mêmes opérations, mêmes espaces et mêmes erreurs que les fonctions `$db*` de BDFD. Une erreur de donnée
 * (`conflict`, `quota`, `needs_index`, `timeout`) ne rejette pas : l'appel rend `null` (ou `fallback`) et `lastError()`
 * dit pourquoi. Une faute du script (`invalid`) ou une base absente (`unavailable`, runner self-hosted) rejette un `BcDbError`.
 * Un script ne nomme jamais un autre serveur ou utilisateur : l'espace est celui du serveur courant (celui de
 * l'auteur en message privé), que `space()` change pour la suite du script.
 */
export function createBcDb(host: BcDbHost): BcDb {
  let last = '';
  let choice: DocSpaceKind | null = null;
  let named: string | null = null;

  function spaceOf(): DocSpace {
    if (choice === 'bot') return { kind: 'bot', id: '_' };
    if (choice === 'guild' && named) return { kind: 'guild', id: named };
    const guild = (host.guildId() ?? '').trim();
    const user = (host.userId() ?? '').trim();
    if (choice === 'user' || guild === '') {
      if (user === '') throw new BcDbError('invalid', 'No user to store data for.');
      return { kind: 'user', id: user };
    }
    return { kind: 'guild', id: guild };
  }

  async function run<T>(action: (gw: DocumentsGateway, id: string, space: DocSpace) => Promise<T>): Promise<T | undefined> {
    last = '';
    const gw = host.gateway();
    const id = host.botId();
    if (!gw || !id) {
      throw new BcDbError('unavailable', 'This runner has no database yet.');
    }
    const space = spaceOf();
    try {
      return await action(gw, id, space);
    } catch (error) {
      const code = error instanceof DocumentsGatewayError ? error.code : 'unavailable';
      if (code === 'invalid' || code === 'unavailable') {
        throw new BcDbError(code, error instanceof Error ? error.message : undefined);
      }
      last = code;
      return undefined;
    }
  }

  const op = (kind: string, collection: string, id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    op: kind,
    collection: String(collection).trim(),
    id: String(id).trim(),
    ...extra,
  });

  async function write(operation: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const results = await run((gw, id, space) => gw.apply(id, space, [operation]));
    return results?.[0] ?? null;
  }

  const rev = (r: Record<string, unknown> | null): number | null => {
    const doc = r?.doc as { rev?: unknown } | undefined;
    return typeof doc?.rev === 'number' ? doc.rev : null;
  };

  const orderOf = (order?: string): boolean => String(order ?? 'desc').trim().toLowerCase() !== 'asc';

  return {
    space(kind, guildId) {
      if (kind !== 'guild' && kind !== 'user' && kind !== 'bot') {
        throw new BcDbError('invalid', 'Space must be guild, user or bot.');
      }
      let target: string | null = null;
      const raw = guildId === undefined || guildId === null ? '' : String(guildId).trim();
      if (raw !== '') {
        if (kind !== 'guild') throw new BcDbError('invalid', 'Only the guild space takes a server ID.');
        if (!/^[0-9]{1,20}$/.test(raw) || /^0+$/.test(raw)) throw new BcDbError('invalid', 'Invalid guild ID.');
        const current = (host.guildId() ?? '').trim();
        if (raw !== current && !(host.hasGuild?.(raw) ?? false)) {
          throw new BcDbError('invalid', 'The bot is not in this server.');
        }
        target = raw;
      }
      choice = kind;
      named = target;
    },
    async get(collection, id, path = '', fallback = null) {
      const doc = await run((gw, bot, space) => gw.get(bot, space, String(collection).trim(), String(id).trim()));
      if (!doc) return fallback;
      const p = String(path).trim();
      if (p === '') return doc.data;
      const v = pathValue(doc.data, p);
      return v === undefined || v === null ? fallback : v;
    },
    async exists(collection, id) {
      const doc = await run((gw, bot, space) => gw.get(bot, space, String(collection).trim(), String(id).trim()));
      return Boolean(doc);
    },
    async set(collection, id, value) {
      return rev(await write(op('set', collection, id, { value: object(value) })));
    },
    async create(collection, id, value) {
      return rev(await write(op('create', collection, id, { value: object(value) })));
    },
    async update(collection, id, path, value) {
      const p = String(path).trim();
      if (p === '') throw new BcDbError('invalid', 'A path is required.');
      let patch: unknown = value;
      for (const key of p.split('.').reverse()) patch = { [key]: patch };
      return rev(await write(op('merge', collection, id, { value: patch })));
    },
    async increment(collection, id, path, delta, min, max) {
      const p = String(path).trim();
      const r = await write(
        op('incr', collection, id, {
          path: p,
          delta: num(delta, 'Delta'),
          ...(min === undefined || min === null ? {} : { min: num(min, 'Min') }),
          ...(max === undefined || max === null ? {} : { max: num(max, 'Max') }),
        }),
      );
      if (!r) return null;
      const v = pathValue(((r.doc as { data?: Record<string, unknown> })?.data ?? {}) as Record<string, unknown>, p);
      return typeof v === 'number' ? v : null;
    },
    async push(collection, id, path, value, maxLen) {
      return rev(
        await write(
          op('push', collection, id, {
            path: String(path).trim(),
            value,
            ...(maxLen === undefined ? {} : { max_len: Math.trunc(num(maxLen, 'Max length')) }),
          }),
        ),
      );
    },
    async pull(collection, id, path, value) {
      return rev(await write(op('pull', collection, id, { path: String(path).trim(), value })));
    },
    async addToSet(collection, id, path, value, maxLen) {
      return rev(
        await write(
          op('addToSet', collection, id, {
            path: String(path).trim(),
            value,
            ...(maxLen === undefined ? {} : { max_len: Math.trunc(num(maxLen, 'Max length')) }),
          }),
        ),
      );
    },
    async delete(collection, id) {
      const r = await write(op('delete', collection, id));
      return r ? r.deleted === true : null;
    },
    async transfer(collection, id, toId, path, amount) {
      const r = await write({
        op: 'transfer',
        collection: String(collection).trim(),
        id: String(id).trim(),
        to_id: String(toId).trim(),
        path: String(path).trim(),
        delta: num(amount, 'Amount'),
      });
      return r !== null;
    },
    async batch(ops) {
      if (!Array.isArray(ops) || ops.some((o) => !o || typeof o !== 'object' || Array.isArray(o))) {
        throw new BcDbError('invalid', 'A list of operations is required.');
      }
      return (await run((gw, bot, space) => gw.apply(bot, space, ops))) ?? null;
    },
    async find(collection: string, a: unknown, b?: unknown, c?: unknown, d?: BcDbFindOptions) {
      let query: Record<string, unknown>;
      if (typeof a === 'string') {
        const key = OPERATORS[String(b ?? '').trim().toLowerCase()];
        if (!key) throw new BcDbError('invalid', 'Operator must be =, !=, <, <=, >, >=, in or prefix.');
        const value = key === '$in' && !Array.isArray(c) ? String(c).split(',').map((s) => s.trim()) : c;
        const options = d ?? {};
        query = {
          where: { [a.trim()]: { [key]: value } },
          ...(options.sort ? { sort: [sortOf(options.sort)] } : {}),
          ...(options.limit === undefined ? {} : { limit: Math.trunc(num(options.limit, 'Limit')) }),
          ...(options.after ? { after: options.after } : {}),
        };
      } else {
        query = object(a);
      }
      const page = await run((gw, bot, space) => gw.find(bot, space, String(collection).trim(), query));
      return page ? { docs: (page.docs as unknown[]) ?? [], ...(page.next ? { next: String(page.next) } : {}) } : null;
    },
    async count(collection, field = '', operator = '=', value) {
      let where: Record<string, unknown> = {};
      if (String(field).trim() !== '') {
        const key = OPERATORS[String(operator).trim().toLowerCase()];
        if (!key || key === '$in') throw new BcDbError('invalid', 'Unknown operator.');
        where = { [String(field).trim()]: { [key]: value } };
      }
      const r = await run((gw, bot, space) => gw.aggregate(bot, space, String(collection).trim(), { op: 'count', where }));
      return r ? Number(r.count) : null;
    },
    async top(collection, field, n, order = 'desc') {
      const r = await run((gw, bot, space) =>
        gw.aggregate(bot, space, String(collection).trim(), {
          op: 'top',
          field: String(field).trim(),
          n: Math.trunc(num(n, 'N')),
          desc: orderOf(order),
        }),
      );
      return r ? ((r.docs as unknown[]) ?? []) : null;
    },
    async rank(collection, field, id, order = 'desc') {
      const r = await run((gw, bot, space) =>
        gw.aggregate(bot, space, String(collection).trim(), {
          op: 'rank',
          field: String(field).trim(),
          id: String(id).trim(),
          desc: orderOf(order),
        }),
      );
      return r ? Number(r.rank) : null;
    },
    async cooldown(collection, id, seconds) {
      const secs = Math.trunc(num(seconds, 'Seconds'));
      if (secs < 1) throw new BcDbError('invalid', 'Seconds must be at least 1.');
      const cid = String(id).trim();
      const coll = String(collection).trim();
      const started = await run((gw, bot, space) =>
        gw.apply(bot, space, [op('create', coll, cid, { value: {}, ttl_seconds: secs })]),
      );
      if (started) return 0;
      if (last !== 'conflict') return null;
      last = '';
      const doc = await run((gw, bot, space) => gw.get(bot, space, coll, cid));
      const exp = doc?.expires_at;
      if (typeof exp !== 'string') return 0;
      const left = Date.parse(exp) - Date.now();
      return left <= 0 ? 0 : Math.ceil(left / 1000);
    },
    lastError: () => last,
  };
}
