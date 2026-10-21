import {
  MAX_PREFIX_ENTRIES,
  normalizePrefixEntry,
  type JsBotConfig,
} from '../config/js-bot-config.js';
import { normalizeScopedStorageKey, toScopedReferenceKey } from '../runtime/variable-keys.js';
import type { VariableDatabase } from '../runtime/variable-database.js';

// Logique miroir de bot-creator-shared `message_invocation.dart` : les vecteurs
// `test/fixtures/invocation-vectors.json` sont communs aux deux implémentations.

/** D'où vient l'invocation : un préfixe, la mention du bot placée en tête, ou le nom de la commande seul. */
export type InvocationSource = 'prefix' | 'mention' | 'noPrefix';

export interface MessageInvocation {
  source: InvocationSource;
  /** Préfixe réellement utilisé ; `null` pour la mention et le sans-préfixe. */
  prefix: string | null;
  /** Premier mot après le préfixe ou la mention, en minuscules. */
  name: string;
  args: string[];
  /** Tout ce qui suit le nom, rogné aux extrémités (l'intérieur est conservé tel quel). */
  rawArgs: string;
}

export interface ParseInvocationOptions {
  /** Identifiant du bot : la route mention n'existe que s'il est numérique. */
  botId?: string | null;
  /** Préfixes effectifs ; le plus long qui correspond l'emporte, quel que soit l'ordre. */
  prefixes?: readonly string[];
  /** Réglage du bot `mentionAsPrefix`. */
  mentionEnabled?: boolean;
  /** Double opt-in `allowNoPrefixCommands` + intent Message Content disponible + salon de serveur. */
  noPrefixEnabled?: boolean;
}

const BOT_ID_PATTERN = /^\d{1,25}$/;
/** `<@id>` ou `<@!id>` en tête, suivi d'une espace ou de la fin ; `<@&role>` ne correspond pas. */
const LEADING_MENTION_PATTERN = /^<@!?(\d+)>(?=\s|$)/;
const FIRST_WORD_PATTERN = /^\s*(\S+)([\s\S]*)$/;

function codePointLength(value: string): number {
  return Array.from(value).length;
}

/** Tri stable, plus longs d'abord (à longueur égale l'ordre d'origine est conservé). */
function sortLongestFirst(entries: string[]): string[] {
  return entries.sort((left, right) => codePointLength(right) - codePointLength(left));
}

function buildInvocation(
  source: InvocationSource,
  prefix: string | null,
  body: string,
): MessageInvocation | null {
  const match = FIRST_WORD_PATTERN.exec(body);
  if (!match) {
    return null;
  }
  const rawArgs = (match[2] ?? '').trim();
  return {
    source,
    prefix,
    name: (match[1] ?? '').toLowerCase(),
    args: rawArgs ? rawArgs.split(/\s+/) : [],
    rawArgs,
  };
}

/**
 * Analyse pure du contenu d'un message. Les gardes (auteur bot, webhook, message système) sont à la charge
 * de l'appelant. Ordre : préfixe (le plus long d'abord, sans repli sur un plus court), puis mention du bot,
 * puis sans-préfixe. Aucune connaissance des commandes : seul le premier mot est extrait.
 */
export function parseInvocation(
  content: unknown,
  options: ParseInvocationOptions,
): MessageInvocation | null {
  if (typeof content !== 'string') {
    return null;
  }
  const text = content.trimStart();
  if (!text) {
    return null;
  }

  let best: string | null = null;
  for (const prefix of options.prefixes ?? []) {
    if (typeof prefix !== 'string' || !prefix || !text.startsWith(prefix)) continue;
    if (best === null || prefix.length > best.length) best = prefix;
  }
  if (best !== null) {
    return buildInvocation('prefix', best, text.slice(best.length));
  }

  if (options.mentionEnabled && typeof options.botId === 'string' && BOT_ID_PATTERN.test(options.botId)) {
    const mention = LEADING_MENTION_PATTERN.exec(text);
    if (mention && mention[1] === options.botId) {
      return buildInvocation('mention', null, text.slice(mention[0].length));
    }
  }

  if (options.noPrefixEnabled) {
    return buildInvocation('noPrefix', null, text);
  }
  return null;
}

/** Au-delà, la valeur d'une variable de préfixe est ignorée (5 entrées de 5 caractères tiennent en moins de 40). */
export const MAX_PREFIX_VALUE_LENGTH = 256;

/**
 * Valeur d'une variable de préfixe : préfixes séparés par des espaces ou des virgules. Entrées invalides
 * écartées (vides, plus de 5 points de code), doublons retirés, 5 entrées au plus, les plus longues d'abord.
 * Tout ce qui n'est pas un texte raisonnable donne une liste vide (= liste statique de l'appelant).
 */
export function sanitizePrefixValue(value: unknown): string[] {
  if (typeof value !== 'string' || value.length > MAX_PREFIX_VALUE_LENGTH) {
    return [];
  }
  const entries: string[] = [];
  const seen = new Set<string>();
  for (const part of value.split(/[\s,]+/u)) {
    const entry = normalizePrefixEntry(part);
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    entries.push(entry);
    if (entries.length >= MAX_PREFIX_ENTRIES) break;
  }
  return sortLongestFirst(entries);
}

// ---------------------------------------------------------------------------
// Variable de préfixe
// ---------------------------------------------------------------------------

/** Durée de vie d'une lecture ; l'écriture de la variable par un script invalide le cache tout de suite. */
export const PREFIX_VARIABLE_CACHE_TTL_MS = 30_000;
/** Une lecture en échec n'est retentée qu'après ce délai (liste statique entre-temps). */
export const PREFIX_VARIABLE_ERROR_TTL_MS = 5_000;
/**
 * Délai maximal d'une lecture de la variable de préfixe. Elle est sur le chemin de CHAQUE message : sans borne,
 * un store qui ne répond pas (Manager injoignable après avoir accepté la requête) suspendrait toutes les
 * commandes préfixées du serveur, alors que l'échec de lecture promet le repli sur la liste statique.
 */
export const PREFIX_VARIABLE_READ_TIMEOUT_MS = 2_000;
/**
 * Serveurs gardés en cache (éviction du moins récemment utilisé). Au-dessous du nombre de serveurs d'un gros
 * bot, chaque entrée serait évincée avant sa réutilisation et presque chaque message ferait une requête.
 */
export const MAX_CACHED_GUILDS = 10_000;

type PrefixResolverConfig = Pick<
  JsBotConfig,
  'prefixVariable' | 'prefixVariableScope' | 'globalVariables' | 'scopedVariableDefinitions'
>;

export interface PrefixResolverOptions {
  botId: string;
  store: Pick<VariableDatabase, 'getScopedVariable' | 'getGlobalVariables'>;
  /** Configuration courante (relue à chaque appel : le registre la remplace à chaque reload). */
  getConfig: () => PrefixResolverConfig;
  now?: () => number;
  ttlMs?: number;
  /** Délai maximal d'une lecture (voir `PREFIX_VARIABLE_READ_TIMEOUT_MS`). */
  readTimeoutMs?: number;
  /** Nombre maximal de serveurs en cache (voir `MAX_CACHED_GUILDS`). */
  maxEntries?: number;
  /** Reçoit une description de l'échec de lecture (jamais la valeur de la variable). */
  onError?: (message: string) => void;
}

interface CacheEntry {
  value: string[];
  expiresAt: number;
}

/** Nom de la variable de préfixe sans `bc_` (clé de stockage), ou `null` si elle n'est pas configurée. */
export function prefixVariableStorageKey(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const key = normalizeScopedStorageKey(name.trim());
  return key || null;
}

/**
 * Lit la variable de préfixe d'un serveur (portée `guild`, ou `global`) et en tire la liste de préfixes qui
 * REMPLACE la liste statique. Liste statique en cas de DM, de valeur vide ou invalide, d'erreur de lecture.
 * Lectures mises en cache par serveur (TTL), partagées entre messages simultanés, invalidées au reload et à
 * l'écriture de la variable (voir `observePrefixVariableWrites`).
 */
export class PrefixResolver {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly pending = new Map<string, Promise<string[]>>();
  private generation = 0;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly readTimeoutMs: number;
  private readonly maxEntries: number;

  constructor(private readonly options: PrefixResolverOptions) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? PREFIX_VARIABLE_CACHE_TTL_MS;
    this.readTimeoutMs = options.readTimeoutMs ?? PREFIX_VARIABLE_READ_TIMEOUT_MS;
    this.maxEntries = Math.max(1, options.maxEntries ?? MAX_CACHED_GUILDS);
  }

  /** Vrai si une variable de préfixe est configurée. */
  isConfigured(): boolean {
    return prefixVariableStorageKey(this.options.getConfig().prefixVariable) !== null;
  }

  async resolve(
    guildId: string | null | undefined,
    staticPrefixes: string[],
  ): Promise<string[]> {
    const config = this.options.getConfig();
    const key = prefixVariableStorageKey(config.prefixVariable);
    if (!key || !guildId) {
      return staticPrefixes;
    }
    const scope = config.prefixVariableScope === 'global' ? 'global' : 'guild';
    const cacheKey = scope === 'global' ? 'global' : `guild:${guildId}`;

    const cached = this.cache.get(cacheKey);
    let fromVariable: string[];
    if (cached && cached.expiresAt > this.now()) {
      fromVariable = cached.value;
      // Le plus récemment utilisé passe en dernier de la table : c'est le premier de la table qui est évincé.
      this.cache.delete(cacheKey);
      this.cache.set(cacheKey, cached);
    } else {
      const inflight = this.pending.get(cacheKey);
      fromVariable = await (inflight ?? this.load(cacheKey, config, scope, key, guildId));
    }
    return fromVariable.length > 0 ? fromVariable : staticPrefixes;
  }

  /** Oublie toutes les lectures, y compris celles en cours (leur résultat ne sera pas mémorisé). */
  invalidate(): void {
    this.generation += 1;
    this.cache.clear();
    this.pending.clear();
  }

  private load(
    cacheKey: string,
    config: PrefixResolverConfig,
    scope: 'guild' | 'global',
    key: string,
    guildId: string,
  ): Promise<string[]> {
    const generation = this.generation;
    const task = (async () => {
      let value: string[] = [];
      let ttl = this.ttlMs;
      try {
        value = sanitizePrefixValue(await this.readWithTimeout(config, scope, key, guildId));
      } catch (error) {
        ttl = PREFIX_VARIABLE_ERROR_TTL_MS;
        const reason = error instanceof Error ? error.message : String(error);
        this.options.onError?.(`Prefix variable "${key}" could not be read, using the static prefixes: ${reason}`);
      }
      if (generation === this.generation) {
        this.remember(cacheKey, value, ttl);
      }
      return value;
    })();
    this.pending.set(cacheKey, task);
    void task.finally(() => {
      if (this.pending.get(cacheKey) === task) {
        this.pending.delete(cacheKey);
      }
    });
    return task;
  }

  private remember(cacheKey: string, value: string[], ttl: number): void {
    // Supprimer avant d'insérer : une entrée relue (expirée) redevient la plus récente de la table.
    this.cache.delete(cacheKey);
    while (this.cache.size >= this.maxEntries) {
      const leastRecent = this.cache.keys().next().value;
      if (leastRecent === undefined) break;
      this.cache.delete(leastRecent);
    }
    this.cache.set(cacheKey, { value, expiresAt: this.now() + ttl });
  }

  /** `read` borné : au-delà du délai la lecture est abandonnée comme une erreur (liste statique). */
  private async readWithTimeout(
    config: PrefixResolverConfig,
    scope: 'guild' | 'global',
    key: string,
    guildId: string,
  ): Promise<unknown> {
    const reading = this.read(config, scope, key, guildId);
    // Si le délai gagne, un rejet tardif de la lecture ne doit pas devenir un rejet non géré.
    reading.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        reading,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`read timed out after ${this.readTimeoutMs}ms`)), this.readTimeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async read(
    config: PrefixResolverConfig,
    scope: 'guild' | 'global',
    key: string,
    guildId: string,
  ): Promise<unknown> {
    const referenceKey = toScopedReferenceKey(key);
    if (scope === 'global') {
      const merged: Record<string, unknown> = {
        ...config.globalVariables,
        ...(await this.options.store.getGlobalVariables(this.options.botId)),
      };
      return merged[key] ?? merged[referenceKey];
    }

    const { botId, store } = this.options;
    let value = await store.getScopedVariable(botId, 'guild', guildId, key);
    if (value == null && referenceKey !== key) {
      value = await store.getScopedVariable(botId, 'guild', guildId, referenceKey);
    }
    if (value == null) {
      const definition = (config.scopedVariableDefinitions ?? []).find(
        (entry) =>
          String(entry.scope ?? '').trim() === 'guild' &&
          normalizeScopedStorageKey(String(entry.key ?? '').trim()) === key,
      );
      value = definition?.['defaultValue'];
    }
    return value;
  }
}

/** Index de l'argument « clé » des écritures de la base de variables. */
const WRITE_KEY_ARGUMENTS: Record<string, number[]> = {
  setScopedVariable: [3],
  removeScopedVariable: [3],
  removeAllScopedValuesForKey: [2],
  setGlobalVariable: [1],
  removeGlobalVariable: [1],
  renameGlobalVariable: [1, 2],
};

/**
 * Enveloppe la base de variables donnée aux scripts : après toute écriture de la variable de préfixe
 * (`db.guild.set`, `db.global.set`, suppression, renommage), `onChange` est appelé pour que le nouveau
 * préfixe serve tout de suite, sans attendre l'expiration du cache. Les lectures passent telles quelles.
 */
export function observePrefixVariableWrites(
  store: VariableDatabase,
  getVariableKey: () => string | null,
  onChange: () => void,
): VariableDatabase {
  return new Proxy(store, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') {
        return value;
      }
      const keyArguments = typeof property === 'string' ? WRITE_KEY_ARGUMENTS[property] : undefined;
      if (!keyArguments) {
        return value.bind(target);
      }
      return async (...args: unknown[]) => {
        const result = await value.apply(target, args);
        const watched = getVariableKey();
        if (
          watched &&
          keyArguments.some((index) => {
            const argument = args[index];
            return typeof argument === 'string' && normalizeScopedStorageKey(argument.trim()) === watched;
          })
        ) {
          onChange();
        }
        return result;
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Mentions exposées aux scripts sur la route mention
// ---------------------------------------------------------------------------

type FilterableCollection = { filter(predicate: (value: unknown, key: string) => boolean): unknown };

/**
 * Vue de `message.mentions` sans l'utilisateur donné (le bot) : sur la route mention, la mention d'en-tête
 * n'est qu'un déclencheur, `mentions.users.first()` doit rester le premier utilisateur réellement visé.
 * Seuls `users` et `members` sont filtrés ; le reste est délégué à l'objet d'origine.
 */
export function mentionsWithoutUser<T extends object>(mentions: T, userId: string): T {
  const filtered = new Map<string | symbol, unknown>();
  return new Proxy(mentions, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === 'users' || property === 'members') {
        if (typeof (value as FilterableCollection | null)?.filter !== 'function') {
          return value;
        }
        if (!filtered.has(property)) {
          filtered.set(property, (value as FilterableCollection).filter((_entry, key) => key !== userId));
        }
        return filtered.get(property);
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

// ---------------------------------------------------------------------------
// Garde-fous de la route sans préfixe
// ---------------------------------------------------------------------------

/** Délai minimal entre deux exécutions de la même commande sans préfixe par le même utilisateur. */
export const NO_PREFIX_USER_COOLDOWN_MS = 2_000;
/** Plafond d'exécutions sans préfixe par bot et par fenêtre ; l'excédent est ignoré. */
export const NO_PREFIX_MAX_PER_WINDOW = 50;
export const NO_PREFIX_WINDOW_MS = 10_000;
