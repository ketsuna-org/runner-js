/**
 * Bibliothèque de fonctions JavaScript par bot, exposée aux scripts par le global `fn`
 * (`await fn.nom(a, b)`).
 *
 * - Une fonction est une entrée `jsFunctions` de la configuration : `{id, name, params[], script, enabled}`.
 *   Son corps est celui d'une fonction ASYNCHRONE : `params` sont ses paramètres nommés, `return` donne la valeur.
 * - Elle s'exécute dans la MÊME portée ambiante que le script appelant (interaction, message, guild, member,
 *   channel, webhook, db, variables, client sans jeton, config assainie, console, fetch, require, setTimeout) :
 *   dans une tâche planifiée ou un webhook entrant, `interaction` et `message` sont donc `undefined`.
 * - Les appels sont toujours asynchrones. Profondeur maximale 10 (portée par l'objet `fn` de chaque corps,
 *   donc exacte avec `Promise.all`), nombre d'appels plafonné par exécution, drapeau « expiré » posé par le
 *   timeout du script : tout nouvel appel rejette ensuite. Une erreur du corps est enveloppée :
 *   `Function x failed: <message>`, la cause d'origine est dans `error.cause`.
 * - Une entrée invalide est IGNORÉE avec un avertissement : jamais d'exception, jamais de rejet de la configuration.
 * - Compilation paresseuse (au premier appel), avec un cache borné.
 *
 * Ce n'est pas un bac à sable : une fonction a les mêmes droits que le script qui l'appelle.
 */

const AsyncFunction = Object.getPrototypeOf(async function () {
  /* noop */
}).constructor as new (
  ...args: string[]
) => (...values: unknown[]) => Promise<unknown>;

/** Nom du paramètre de portée qui porte la bibliothèque. */
export const FN_SCOPE_NAME = 'fn';
/** Nombre maximal de fonctions actives par bot (l'excédent est ignoré avec un avertissement). */
export const MAX_JS_FUNCTIONS = 100;
/** Taille maximale du corps d'une fonction, en caractères. */
export const MAX_JS_FUNCTION_BODY_CHARS = 65_536;
/** Taille cumulée maximale des corps d'un bot (100 x 64 Ko serait copié, persisté et rechargé à chaque synchro). */
export const MAX_JS_FUNCTIONS_TOTAL_CHARS = 512 * 1024;
/** Nombre maximal de paramètres nommés d'une fonction. */
export const MAX_JS_FUNCTION_PARAMS = 20;
/** Profondeur maximale d'appels imbriqués (le script appelant est à 0, la fonction qu'il appelle à 1). */
export const MAX_FN_CALL_DEPTH = 10;
/**
 * Nombre maximal d'appels `fn.x()` par exécution de script : la profondeur seule laisse une arborescence
 * d'appels exploser (3 appels par niveau sur 10 niveaux = des dizaines de milliers d'appels).
 */
export const MAX_FN_CALLS_PER_EXECUTION = 5_000;
/** Taille maximale du cache des corps compilés (éviction du plus ancien, comme le cache des scripts). */
export const FUNCTION_CACHE_MAX = 500;
/** Nombre maximal d'avertissements émis pour une même bibliothèque (le reste est résumé en une ligne). */
const MAX_LIBRARY_WARNINGS = 10;

const IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;

/** Mots réservés d'ECMAScript (strict compris) : ni nom de fonction ni nom de paramètre. */
const RESERVED_WORDS = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else',
  'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'implements', 'import', 'in',
  'instanceof', 'interface', 'let', 'new', 'null', 'package', 'private', 'protected', 'public', 'return', 'static',
  'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
]);
/** Noms qui ne peuvent pas désigner une fonction : ils casseraient l'objet `fn` ou la résolution de promesse. */
const FORBIDDEN_FUNCTION_NAMES = new Set([
  '__proto__', 'constructor', 'prototype', 'then', 'toString', 'valueOf', 'hasOwnProperty',
]);
/** Liaisons qu'un paramètre ne doit pas masquer ou qui ne se lient pas (mode strict). */
const FORBIDDEN_PARAM_NAMES = new Set([...RESERVED_WORDS, 'arguments', 'eval', 'undefined', 'NaN', 'Infinity']);
/**
 * Clés lues par le moteur ou les outils d'inspection (`await fn`, `JSON.stringify(fn)`, `fn.toString()`…) :
 * elles valent `undefined` au lieu de lever « Unknown function ».
 */
const NON_FUNCTION_KEYS = new Set([...Object.getOwnPropertyNames(Object.prototype), 'then', 'toJSON', 'prototype']);

// ---------------------------------------------------------------------------
// Compilation d'un corps asynchrone (script ou fonction), avec repli sans `fn`
// ---------------------------------------------------------------------------

export interface CompiledBody {
  /** Vrai quand le corps déclare lui-même `fn` (const/let/class) : il a été compilé SANS le global `fn`. */
  readonly shadowsFn: boolean;
  run(scopeValues: readonly unknown[], fnObject: unknown, args: readonly unknown[]): Promise<unknown>;
}

/**
 * Compile `body` comme corps de fonction asynchrone dont les paramètres sont `scopeNames` (qui se termine
 * par `fn`) puis `params`. Un script qui déclare déjà `const fn` / `let fn` / `class fn` provoque une
 * SyntaxError avec le paramètre `fn` : on le recompile SANS ce paramètre (il garde sa propre liaison, il
 * n'a simplement pas accès à la bibliothèque). Une vraie erreur de syntaxe échoue aussi au second essai, et
 * c'est celle-ci qui est levée.
 */
export function compileAsyncBody(
  scopeNames: readonly string[],
  params: readonly string[],
  body: string,
): CompiledBody {
  try {
    const compiled = new AsyncFunction(...scopeNames, ...params, body);
    return {
      shadowsFn: false,
      run: (scopeValues, fnObject, args) => compiled(...scopeValues, fnObject, ...args),
    };
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    const withoutFn = scopeNames.filter((name) => name !== FN_SCOPE_NAME);
    if (withoutFn.length === scopeNames.length) {
      throw error;
    }
    const compiled = new AsyncFunction(...withoutFn, ...params, body);
    return {
      shadowsFn: true,
      run: (scopeValues, _fnObject, args) => compiled(...scopeValues, ...args),
    };
  }
}

// ---------------------------------------------------------------------------
// Validation de la bibliothèque
// ---------------------------------------------------------------------------

type CompileOutcome = { body: CompiledBody } | { error: unknown };

export interface JsFunctionDefinition {
  readonly id: string | undefined;
  readonly name: string;
  readonly params: readonly string[];
  readonly script: string;
  /** Clé du cache de compilation : nom + paramètres + corps. */
  readonly cacheKey: string;
  /** Résultat de la compilation, mémorisé à la première utilisation (le cache global survit aux rechargements). */
  compiled?: CompileOutcome;
}

export interface FunctionLibrary {
  /** Fonctions actives et valides, par nom exact, dans l'ordre déclaré. */
  readonly functions: ReadonlyMap<string, JsFunctionDefinition>;
  names(): string[];
}

function createLibrary(functions: Map<string, JsFunctionDefinition>): FunctionLibrary {
  return { functions, names: () => [...functions.keys()] };
}

const EMPTY_LIBRARY: FunctionLibrary = createLibrary(new Map());

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Texte sûr à afficher dans un avertissement : tronqué, caractères de contrôle échappés, jamais un corps. */
function quote(value: unknown): string {
  return JSON.stringify(String(value).slice(0, 40));
}

function describeEntry(entry: Record<string, unknown>, index: number): string {
  const parts = [`JS function #${index}`];
  if (typeof entry.id === 'string') parts.push(`(id ${quote(entry.id)})`);
  if (typeof entry.name === 'string') parts.push(quote(entry.name));
  return parts.join(' ');
}

/** Raison du refus d'une entrée (null si elle est valide) ; renseigne `params`. */
function checkParams(raw: unknown, forbidden: ReadonlySet<string>, out: string[]): string | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (!Array.isArray(raw)) {
    return 'params must be an array of identifiers';
  }
  if (raw.length > MAX_JS_FUNCTION_PARAMS) {
    return `too many params (max ${MAX_JS_FUNCTION_PARAMS})`;
  }
  const seen = new Set<string>();
  for (const param of raw) {
    if (typeof param !== 'string' || !IDENTIFIER_PATTERN.test(param)) {
      return `invalid param ${quote(param)}`;
    }
    if (FORBIDDEN_PARAM_NAMES.has(param)) {
      return `param ${quote(param)} is a reserved word`;
    }
    if (forbidden.has(param)) {
      return `param ${quote(param)} hides a script scope variable`;
    }
    if (seen.has(param)) {
      return `duplicate param ${quote(param)}`;
    }
    seen.add(param);
    out.push(param);
  }
  return null;
}

/**
 * Construit la bibliothèque à partir de `jsFunctions` : pure, sans cache. Toute entrée invalide est écartée et
 * signalée par `warn` (au plus {@link MAX_LIBRARY_WARNINGS} messages, puis un résumé) ; ne lève jamais.
 * `scopeNames` est la liste des paramètres de portée du moteur : aucun ne peut servir de nom de paramètre.
 */
export function loadFunctionLibrary(
  raw: unknown,
  scopeNames: readonly string[],
  warn: (message: string) => void,
): FunctionLibrary {
  if (!Array.isArray(raw) || raw.length === 0) {
    return EMPTY_LIBRARY;
  }

  const functions = new Map<string, JsFunctionDefinition>();
  const namesByLowerCase = new Map<string, string>();
  const scopeParamNames = new Set(scopeNames);
  let warned = 0;
  let suppressed = 0;
  let overFunctionLimit = 0;
  let totalChars = 0;

  const report = (message: string) => {
    if (warned < MAX_LIBRARY_WARNINGS) {
      warned += 1;
      warn(message);
    } else {
      suppressed += 1;
    }
  };

  raw.forEach((entry, index) => {
    if (!isRecord(entry)) {
      report(`JS function #${index} ignored: not an object`);
      return;
    }
    if (entry.enabled === false) {
      return;
    }
    const label = describeEntry(entry, index);
    const reject = (reason: string) => report(`${label} ignored: ${reason}`);

    const name = entry.name;
    if (typeof name !== 'string' || !IDENTIFIER_PATTERN.test(name)) {
      reject('invalid name (expected /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/)');
      return;
    }
    if (RESERVED_WORDS.has(name) || FORBIDDEN_FUNCTION_NAMES.has(name)) {
      reject('reserved name');
      return;
    }
    const sameName = namesByLowerCase.get(name.toLowerCase());
    if (sameName !== undefined) {
      reject(`name already used by ${quote(sameName)} (names are case-insensitively unique)`);
      return;
    }

    const params: string[] = [];
    const paramsProblem = checkParams(entry.params, scopeParamNames, params);
    if (paramsProblem) {
      reject(paramsProblem);
      return;
    }

    const script = entry.script;
    if (typeof script !== 'string' || script.trim() === '') {
      reject('script must be a non-empty string');
      return;
    }
    if (script.length > MAX_JS_FUNCTION_BODY_CHARS) {
      reject(`script too long (max ${MAX_JS_FUNCTION_BODY_CHARS} characters)`);
      return;
    }

    if (functions.size >= MAX_JS_FUNCTIONS) {
      overFunctionLimit += 1;
      return;
    }
    if (totalChars + script.length > MAX_JS_FUNCTIONS_TOTAL_CHARS) {
      reject(`total size of function bodies would exceed ${MAX_JS_FUNCTIONS_TOTAL_CHARS} characters`);
      return;
    }

    totalChars += script.length;
    namesByLowerCase.set(name.toLowerCase(), name);
    functions.set(name, {
      id: typeof entry.id === 'string' ? entry.id : undefined,
      name,
      params,
      script,
      cacheKey: `${name}\u0000${params.join(',')}\u0000${script}`,
    });
  });

  if (overFunctionLimit > 0) {
    warn(`${overFunctionLimit} JS function(s) ignored: a bot can have at most ${MAX_JS_FUNCTIONS} functions`);
  }
  if (suppressed > 0) {
    warn(`${suppressed} more JS function entries ignored (warnings limited to ${MAX_LIBRARY_WARNINGS})`);
  }
  return functions.size === 0 ? EMPTY_LIBRARY : createLibrary(functions);
}

const libraryCache = new WeakMap<object, FunctionLibrary>();

/**
 * Bibliothèque de `jsFunctions`, validée UNE fois par tableau (un rechargement de configuration produit un
 * nouveau tableau, donc une nouvelle validation, et les avertissements ne sont pas répétés à chaque exécution).
 */
export function getFunctionLibrary(
  raw: unknown,
  scopeNames: readonly string[],
  warn: (message: string) => void,
): FunctionLibrary {
  if (!Array.isArray(raw) || raw.length === 0) {
    return EMPTY_LIBRARY;
  }
  let library = libraryCache.get(raw);
  if (!library) {
    library = loadFunctionLibrary(raw, scopeNames, warn);
    libraryCache.set(raw, library);
  }
  return library;
}

// ---------------------------------------------------------------------------
// Cache des corps compilés
// ---------------------------------------------------------------------------

const compiledFunctionCache = new Map<string, CompileOutcome>();

/** Nombre de corps de fonction en cache (tests). */
export function functionCompiledCacheSize(): number {
  return compiledFunctionCache.size;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compileFunction(definition: JsFunctionDefinition, state: ExecutionState): CompileOutcome {
  if (definition.compiled) {
    return definition.compiled;
  }
  let outcome = compiledFunctionCache.get(definition.cacheKey);
  if (!outcome) {
    try {
      const body = compileAsyncBody(state.scopeNames, definition.params, definition.script);
      outcome = { body };
      if (body.shadowsFn) {
        state.warn(
          `Function ${definition.name} declares its own "fn" binding: it cannot call other functions through fn.`,
        );
      }
    } catch (error) {
      outcome = { error };
      state.warn(`Function ${definition.name} does not compile: ${errorMessage(error)}`);
    }
    if (compiledFunctionCache.size >= FUNCTION_CACHE_MAX) {
      const oldest = compiledFunctionCache.keys().next().value;
      if (oldest !== undefined) {
        compiledFunctionCache.delete(oldest);
      }
    }
    compiledFunctionCache.set(definition.cacheKey, outcome);
  }
  definition.compiled = outcome;
  return outcome;
}

// ---------------------------------------------------------------------------
// Exécution : objet `fn`
// ---------------------------------------------------------------------------

interface ExecutionState {
  readonly library: FunctionLibrary;
  readonly scopeNames: readonly string[];
  readonly scopeValues: readonly unknown[];
  readonly warn: (message: string) => void;
  /** Posé par le timeout du script : tout nouvel appel rejette ensuite. */
  expired: boolean;
  calls: number;
  /** Objet `fn` par profondeur (chaque corps reçoit celui de sa propre profondeur). */
  readonly objects: object[];
}

function wrapFailure(name: string, error: unknown): Error {
  return new Error(`Function ${name} failed: ${errorMessage(error)}`, { cause: error });
}

async function invokeFunction(
  state: ExecutionState,
  definition: JsFunctionDefinition,
  callerDepth: number,
  args: unknown[],
): Promise<unknown> {
  const { name } = definition;
  if (state.expired) {
    throw new Error(`Function ${name} failed: the script execution timed out`);
  }
  const depth = callerDepth + 1;
  if (depth > MAX_FN_CALL_DEPTH) {
    throw new Error(`Function ${name} failed: maximum call depth (${MAX_FN_CALL_DEPTH}) exceeded`);
  }
  state.calls += 1;
  if (state.calls > MAX_FN_CALLS_PER_EXECUTION) {
    throw new Error(
      `Function ${name} failed: too many function calls in one execution (max ${MAX_FN_CALLS_PER_EXECUTION})`,
    );
  }
  const outcome = compileFunction(definition, state);
  if ('error' in outcome) {
    throw wrapFailure(name, outcome.error);
  }
  try {
    return await outcome.body.run(state.scopeValues, fnObjectAt(state, depth), args);
  } catch (error) {
    throw wrapFailure(name, error);
  }
}

function fnObjectAt(state: ExecutionState, depth: number): object {
  return (state.objects[depth] ??= createFnObject(state, depth));
}

/**
 * Objet `fn` d'une profondeur donnée : un Proxy sans prototype, en lecture seule, dont les propriétés sont les
 * fonctions actives. `fn.inconnue` lève « Unknown function ». Les symboles et les clés d'`Object.prototype`
 * (`then`, `constructor`, `__proto__`, `toString`…) valent `undefined` : `await fn` ne se bloque pas et
 * `fn.constructor` n'expose pas `Function`.
 */
function createFnObject(state: ExecutionState, depth: number): object {
  const callables = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const callableFor = (definition: JsFunctionDefinition) => {
    let callable = callables.get(definition.name);
    if (!callable) {
      callable = (...args: unknown[]) => invokeFunction(state, definition, depth, args);
      callables.set(definition.name, callable);
    }
    return callable;
  };

  return new Proxy(Object.create(null) as object, {
    get(_target, key) {
      if (typeof key === 'symbol') {
        return undefined;
      }
      const definition = state.library.functions.get(key);
      if (definition) {
        return callableFor(definition);
      }
      if (NON_FUNCTION_KEYS.has(key)) {
        return undefined;
      }
      const available = state.library.names().join(', ') || 'aucune';
      throw new Error(`Unknown function ${key} (disponibles : ${available})`);
    },
    has: (_target, key) => typeof key === 'string' && state.library.functions.has(key),
    ownKeys: () => state.library.names(),
    getOwnPropertyDescriptor(_target, key) {
      const definition = typeof key === 'string' ? state.library.functions.get(key) : undefined;
      return definition
        ? { value: callableFor(definition), enumerable: true, configurable: true, writable: false }
        : undefined;
    },
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
    setPrototypeOf: () => false,
    preventExtensions: () => false,
  });
}

export interface ScriptFunctions {
  /** Valeur du paramètre de portée `fn` du script appelant. */
  readonly fn: object;
  /** Appelé par le timeout du script : les appels `fn.x()` suivants rejettent. */
  expire(): void;
}

const NO_FUNCTIONS: ScriptFunctions = {
  fn: createFnObject(
    { library: EMPTY_LIBRARY, scopeNames: [], scopeValues: [], warn: () => undefined, expired: false, calls: 0, objects: [] },
    0,
  ),
  expire: () => undefined,
};

/**
 * Prépare `fn` pour UNE exécution de script. `scopeValues` (dans l'ordre de `scopeNames` sans `fn`) est
 * partagé tel quel avec toutes les fonctions appelées : même interaction, mêmes variables, même client.
 * Sans fonction active, l'objet `fn` est vide et partagé (aucune allocation par exécution).
 */
export function createScriptFunctions(options: {
  jsFunctions: unknown;
  scopeNames: readonly string[];
  scopeValues: readonly unknown[];
  warn: (message: string) => void;
}): ScriptFunctions {
  const library = getFunctionLibrary(options.jsFunctions, options.scopeNames, options.warn);
  if (library.functions.size === 0) {
    return NO_FUNCTIONS;
  }
  const state: ExecutionState = {
    library,
    scopeNames: options.scopeNames,
    scopeValues: options.scopeValues,
    warn: options.warn,
    expired: false,
    calls: 0,
    objects: [],
  };
  return {
    fn: fnObjectAt(state, 0),
    expire: () => {
      state.expired = true;
    },
  };
}
