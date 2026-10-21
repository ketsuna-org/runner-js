import { describe, expect, it, vi } from 'bun:test';

import type { ScriptExecutionContext } from '../src/scripts/script-context.js';
import { SCOPE_PARAM_NAMES } from '../src/scripts/script-direct-runtime.js';
import { ScriptExecutor } from '../src/scripts/script-executor.js';
import {
  FUNCTION_CACHE_MAX,
  functionCompiledCacheSize,
  getFunctionLibrary,
  loadFunctionLibrary,
} from '../src/scripts/script-functions.js';

type FnDef = { id?: string; name: string; params?: string[]; script: string; enabled?: boolean; description?: string };

function createLogger() {
  return { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

/** Exécute `script` avec un vrai ScriptExecutor sur un bot dont la configuration porte `jsFunctions`. */
async function run(
  script: string,
  jsFunctions: FnDef[] | undefined,
  options: { timeoutMs?: number; context?: Partial<ScriptExecutionContext>; logger?: ReturnType<typeof createLogger> } = {},
): Promise<unknown> {
  const executor = new ScriptExecutor(options.timeoutMs ?? 5000);
  try {
    return await executor.execute(
      script,
      {
        client: {} as never,
        config: { token: 'x', jsFunctions } as never,
        variables: {},
        ...options.context,
      },
      options.logger ?? createLogger(),
    );
  } finally {
    executor.dispose();
  }
}

/** f1 appelle f2 ... fN-1 appelle fN, qui renvoie 'ok'. */
function chain(length: number): FnDef[] {
  return Array.from({ length }, (_, index) => ({
    name: `f${index + 1}`,
    script: index === length - 1 ? "return 'ok';" : `return await fn.f${index + 2}();`,
  }));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('fn : appel d une fonction du bot', () => {
  it('renvoie la valeur de la fonction', async () => {
    const add = { name: 'add', params: ['a', 'b'], script: 'return a + b;' };
    expect(await run('return await fn.add(2, 3);', [add])).toBe(5);
  });

  it('lie les arguments aux paramètres nommés, dans l ordre', async () => {
    const greet = { name: 'greet', params: ['first', 'last'], script: 'return `${last}, ${first}`;' };
    expect(await run("return await fn.greet('Ada', 'Lovelace');", [greet])).toBe('Lovelace, Ada');
  });

  it('un argument manquant vaut undefined et un argument en trop est ignoré', async () => {
    const probe = { name: 'probe', params: ['a', 'b'], script: 'return [a, typeof b];' };
    expect(await run('return await fn.probe(1);', [probe])).toEqual([1, 'undefined']);
    expect(await run('return await fn.probe(1, 2, 3);', [probe])).toEqual([1, 'number']);
  });

  it('une fonction en appelle une autre', async () => {
    const defs = [
      { name: 'add', params: ['a', 'b'], script: 'return a + b;' },
      { name: 'double', params: ['n'], script: 'return await fn.add(n, n);' },
    ];
    expect(await run('return await fn.double(21);', defs)).toBe(42);
  });

  it('est toujours asynchrone, même pour un corps sans await', async () => {
    const defs = [{ name: 'one', script: 'return 1;' }];
    expect(await run('const p = fn.one(); return [p instanceof Promise, await p];', defs)).toEqual([true, 1]);
  });

  it('plusieurs appels simultanés ne se mélangent pas', async () => {
    const slow = { name: 'slow', params: ['ms', 'value'], script: 'await new Promise((r) => setTimeout(r, ms)); return value;' };
    expect(await run('return await Promise.all([fn.slow(30, "a"), fn.slow(1, "b"), fn.slow(10, "c")]);', [slow])).toEqual(['a', 'b', 'c']);
  });
});

describe('fn : portée ambiante partagée avec l appelant', () => {
  it('le corps appelle interaction.reply et lit les variables du contexte appelant', async () => {
    const reply = vi.fn(async () => undefined);
    const say = {
      name: 'say',
      params: ['text'],
      script: 'await interaction.reply({ content: `${text}:${variables.who}` }); return typeof guild + "/" + typeof member;',
    };
    const result = await run("return await fn.say('hi');", [say], {
      context: { interaction: { reply } as never, variables: { who: 'bob' }, guild: { id: 'g1' } as never, member: {} as never },
    });
    expect(reply).toHaveBeenCalledWith({ content: 'hi:bob' });
    expect(result).toBe('object/object');
  });

  it('une écriture dans variables depuis la fonction est vue par l appelant', async () => {
    const bump = { name: 'bump', script: 'variables.count = (variables.count ?? 0) + 1;' };
    const variables: Record<string, unknown> = {};
    await run('await fn.bump(); await fn.bump(); return variables.count;', [bump], { context: { variables } });
    expect(variables.count).toBe(2);
  });

  it('console de la fonction passe par le journal du bot', async () => {
    const logger = createLogger();
    await run("await fn.talk();", [{ name: 'talk', script: "console.warn('depuis fn');" }], { logger });
    expect(logger.warn).toHaveBeenCalledWith('depuis fn');
  });

  it('dans un webhook entrant, interaction et message sont undefined dans la fonction aussi', async () => {
    const probe = { name: 'probe', script: 'return [typeof interaction, typeof message, webhook?.path];' };
    const result = await run('return await fn.probe();', [probe], {
      context: { webhook: { path: '/hook', payload: {}, headers: {} } },
    });
    expect(result).toEqual(['undefined', 'undefined', '/hook']);
  });
});

describe('fn : profondeur d appel', () => {
  it('une récursion infinie échoue avec une erreur de profondeur nommée, sans RangeError', async () => {
    const rec = { name: 'rec', script: 'return await fn.rec();' };
    const script = `
      try { await fn.rec(); return null; } catch (error) {
        const chain = [];
        for (let e = error; e; e = e.cause) chain.push(e.constructor.name);
        return { message: error.message, chain };
      }`;
    const outcome = (await run(script, [rec])) as { message: string; chain: string[] };
    expect(outcome.message).toContain('Function rec failed');
    expect(outcome.message).toMatch(/depth/i);
    expect(outcome.chain.every((name) => name === 'Error')).toBe(true);
  });

  it('10 niveaux d appel passent', async () => {
    expect(await run('return await fn.f1();', chain(10))).toBe('ok');
  });

  it('le 11e niveau échoue', async () => {
    await expect(run('return await fn.f1();', chain(11))).rejects.toThrow(/depth/i);
  });

  it('la profondeur est exacte avec Promise.all : un appel profond n affecte pas ses voisins', async () => {
    const deep = { name: 'deep', params: ['n'], script: 'if (n <= 0) return 0; return 1 + await fn.deep(n - 1);' };
    const script = `
      const results = await Promise.allSettled([fn.deep(9), fn.deep(10), fn.deep(9), fn.deep(5)]);
      return results.map((r) => (r.status === 'fulfilled' ? r.value : 'ERR'));`;
    expect(await run(script, [deep])).toEqual([9, 'ERR', 9, 5]);
  });

  it('la profondeur redescend après un appel : 10 appels successifs de 10 niveaux passent', async () => {
    const script = 'const out = []; for (let i = 0; i < 10; i += 1) out.push(await fn.f1()); return out.length;';
    expect(await run(script, chain(10))).toBe(10);
  });
});

describe('fn : plafond d appels par exécution', () => {
  it('rejette au-delà du plafond, nommant la fonction', async () => {
    const noop = { name: 'noop', script: 'return 1;' };
    const script = `
      let done = 0;
      try { for (let i = 0; i < 100000; i += 1) { await fn.noop(); done += 1; } return { done, message: null }; }
      catch (error) { return { done, message: error.message }; }`;
    const outcome = (await run(script, [noop])) as { done: number; message: string | null };
    expect(outcome.message).toMatch(/Function noop failed/);
    expect(outcome.message).toMatch(/too many/i);
    expect(outcome.done).toBeGreaterThan(100);
    expect(outcome.done).toBeLessThan(100000);
  });

  it('le compteur repart à zéro à chaque exécution', async () => {
    const noop = { name: 'noop', script: 'return 1;' };
    const executor = new ScriptExecutor(5000);
    const context = { client: {} as never, config: { token: 'x', jsFunctions: [noop] } as never, variables: {} };
    const script = 'for (let i = 0; i < 1000; i += 1) await fn.noop(); return true;';
    for (let i = 0; i < 12; i += 1) {
      expect(await executor.execute(script, context, createLogger())).toBe(true);
    }
    executor.dispose();
  });
});

describe('fn : objet fn', () => {
  const defs: FnDef[] = [
    { name: 'add', params: ['a', 'b'], script: 'return a + b;' },
    { name: 'greet', script: "return 'hi';" },
    { name: 'off', script: "return 'off';", enabled: false },
  ];

  it('une fonction inconnue lève une erreur qui liste les fonctions disponibles', async () => {
    const outcome = await run("try { await fn.nope(1); } catch (e) { return e.message; }", defs);
    expect(outcome).toBe('Unknown function nope (disponibles : add, greet)');
  });

  it('sans aucune fonction définie, l erreur le dit', async () => {
    const outcome = await run("try { await fn.nope(); } catch (e) { return e.message; }", undefined);
    expect(outcome).toBe('Unknown function nope (disponibles : aucune)');
  });

  it('une fonction désactivée est absente', async () => {
    const outcome = await run("try { await fn.off(); } catch (e) { return e.message; }", defs);
    expect(outcome).toBe('Unknown function off (disponibles : add, greet)');
  });

  it('await fn ne se bloque pas (then est undefined)', async () => {
    const outcome = await run('const same = await fn; return [same === fn, typeof fn.then];', defs, { timeoutMs: 1000 });
    expect(outcome).toEqual([true, 'undefined']);
  });

  it('fn.__proto__ et fn.constructor n exposent pas Function', async () => {
    const script = `
      return [
        typeof fn.__proto__,
        typeof fn.constructor,
        Object.getPrototypeOf(fn),
        typeof fn.hasOwnProperty,
        typeof fn.toString,
        typeof fn.valueOf,
        typeof fn.prototype,
        typeof fn.toJSON,
      ];`;
    expect(await run(script, defs)).toEqual(['undefined', 'undefined', null, 'undefined', 'undefined', 'undefined', 'undefined', 'undefined']);
  });

  it('les symboles ne déclenchent pas d erreur de fonction inconnue', async () => {
    expect(await run('return [typeof fn[Symbol.toPrimitive], typeof fn[Symbol.iterator], Object.prototype.toString.call(fn)];', defs)).toEqual([
      'undefined',
      'undefined',
      '[object Object]',
    ]);
  });

  it('Object.keys, in et JSON.stringify ne voient que les fonctions actives', async () => {
    const outcome = await run("return [Object.keys(fn), 'add' in fn, 'off' in fn, 'nope' in fn, JSON.stringify(fn)];", defs);
    expect(outcome).toEqual([['add', 'greet'], true, false, false, '{}']);
  });

  it('fn n est pas modifiable : écriture et suppression ignorées en mode non strict', async () => {
    const script = 'fn.add = () => "hijacked"; delete fn.greet; fn.extra = 1; return [await fn.add(1, 2), await fn.greet(), "extra" in fn];';
    expect(await run(script, defs)).toEqual([3, 'hi', false]);
  });

  it('fn n est pas modifiable : le mode strict et defineProperty lèvent', async () => {
    const outcome = await run(
      `'use strict';
       const errors = [];
       try { fn.add = 1; } catch (e) { errors.push(e.constructor.name); }
       try { Object.defineProperty(fn, 'evil', { value: 1 }); } catch (e) { errors.push(e.constructor.name); }
       try { Object.setPrototypeOf(fn, {}); } catch (e) { errors.push(e.constructor.name); }
       return errors;`,
      defs,
    );
    expect(outcome).toEqual(['TypeError', 'TypeError', 'TypeError']);
  });

  it('config sans jsFunctions : fn est un objet vide, sans erreur', async () => {
    for (const jsFunctions of [undefined, [] as FnDef[]]) {
      expect(await run('return [typeof fn, Object.keys(fn).length];', jsFunctions)).toEqual(['object', 0]);
    }
  });

  it('une même fonction renvoie la même référence à chaque lecture', async () => {
    expect(await run('return fn.add === fn.add;', defs)).toBe(true);
  });
});

describe('fn : erreurs', () => {
  it('une fonction à SyntaxError n empêche pas les autres ; l erreur n apparaît qu à l appel et nomme la fonction', async () => {
    const defs = [
      { name: 'good', script: "return 'fine';" },
      { name: 'broken', script: 'return (;' },
    ];
    const logger = createLogger();
    expect(await run("return await fn.good();", defs, { logger })).toBe('fine');
    const outcome = (await run(
      "try { await fn.broken(); } catch (e) { return { message: e.message, cause: e.cause?.constructor?.name }; }",
      defs,
    )) as { message: string; cause: string };
    expect(outcome.message).toContain('Function broken failed');
    expect(outcome.cause).toBe('SyntaxError');
  });

  it('une erreur dans le corps est rattrapable avec son message et sa cause', async () => {
    const defs = [{ name: 'boom', script: "throw new TypeError('bad input');" }];
    const script = `
      try { await fn.boom(); return null; }
      catch (e) { return { message: e.message, causeMessage: e.cause.message, causeType: e.cause.constructor.name }; }`;
    expect(await run(script, defs)).toEqual({
      message: 'Function boom failed: bad input',
      causeMessage: 'bad input',
      causeType: 'TypeError',
    });
  });

  it('une valeur levée qui n est pas une Error est enveloppée', async () => {
    const defs = [{ name: 'weird', script: "throw 'texte brut';" }];
    const outcome = await run("try { await fn.weird(); } catch (e) { return [e.message, e.cause]; }", defs);
    expect(outcome).toEqual(['Function weird failed: texte brut', 'texte brut']);
  });

  it('une erreur non rattrapée traverse jusqu au script appelant', async () => {
    const defs = [{ name: 'boom', script: "throw new Error('kaput');" }];
    await expect(run('await fn.boom();', defs)).rejects.toThrow('Function boom failed: kaput');
  });

  it('les erreurs imbriquées gardent la chaîne d appels', async () => {
    const defs = [
      { name: 'outer', script: 'return await fn.inner();' },
      { name: 'inner', script: "throw new Error('deep failure');" },
    ];
    await expect(run('await fn.outer();', defs)).rejects.toThrow('Function outer failed: Function inner failed: deep failure');
  });
});

describe('fn : script qui déclare déjà fn', () => {
  it('un script contenant const fn s exécute encore (repli sans fn) et un avertissement est émis', async () => {
    const logger = createLogger();
    const result = await run('/* repli-script-1 */ const fn = 40; return fn + 2;', [{ name: 'add', script: 'return 1;' }], { logger });
    expect(result).toBe(42);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0]?.[0])).toContain('fn');
  });

  it('let fn et class fn se replient aussi', async () => {
    expect(await run('/* repli-script-2 */ let fn = 1; fn += 1; return fn;', undefined)).toBe(2);
    expect(await run('/* repli-script-3 */ class fn { static v() { return 7; } } return fn.v();', undefined)).toBe(7);
  });

  it('var fn et function fn ne posent pas de problème', async () => {
    expect(await run('/* repli-script-4 */ var fn = 5; return fn;', undefined)).toBe(5);
    expect(await run('/* repli-script-5 */ function fn() { return 9; } return fn();', undefined)).toBe(9);
  });

  it('une vraie erreur de syntaxe n est pas masquée par le repli', async () => {
    await expect(run('/* repli-script-6 */ const fn = ;', undefined)).rejects.toBeInstanceOf(SyntaxError);
  });

  it('un corps de fonction qui déclare const fn marche aussi, sans accès à la bibliothèque', async () => {
    const defs = [
      { name: 'twice', params: ['x'], script: 'const fn = (v) => v * 2; return fn(x);' },
      { name: 'plain', script: "return 'p';" },
    ];
    const logger = createLogger();
    expect(await run('return await fn.twice(4);', defs, { logger })).toBe(8);
    expect(logger.warn).toHaveBeenCalled();
    // Le script appelant, lui, garde fn.
    expect(await run("return await fn.plain();", defs)).toBe('p');
  });
});

describe('fn : délai d exécution du script', () => {
  it('après le timeout du script, un fn.x() tardif est rejeté et le corps ne s exécute pas', async () => {
    const variables: Record<string, unknown> = {};
    const defs = [{ name: 'touch', script: 'variables.touched = true;' }];
    const script = `
      await new Promise((resolve) => setTimeout(resolve, 150));
      variables.late = await fn.touch().then(() => 'ran', (e) => e.message);`;
    await expect(run(script, defs, { timeoutMs: 50, context: { variables } })).rejects.toThrow(/timed out/i);
    await sleep(300);
    expect(String(variables.late)).toMatch(/Function touch failed.*timed out/i);
    expect(variables.touched).toBeUndefined();
  });

  it('un script qui finit à temps garde fn disponible jusqu au bout', async () => {
    const defs = [{ name: 'one', script: 'return 1;' }];
    expect(await run('await new Promise((r) => setTimeout(r, 20)); return await fn.one();', defs, { timeoutMs: 500 })).toBe(1);
  });
});

describe('fn : sécurité', () => {
  it('client.token, config.token, db.config et le secret d un webhook restent undefined dans une fonction', async () => {
    const { ScriptDb } = await import('../src/scripts/script-db.js');
    const store = {
      token: 'managed-bearer-secret',
      getGlobalVariables: async () => ({}),
      setGlobalVariable: async () => undefined,
      removeGlobalVariable: async () => undefined,
      getScopedVariable: async () => undefined,
      setScopedVariable: async () => undefined,
      removeScopedVariable: async () => undefined,
      listContextIds: async () => [],
      removeAllScopedValuesForKey: async () => undefined,
    };
    const config = {
      token: 'super-secret-token',
      globalVariables: {},
      scopedVariableDefinitions: [],
      inboundWebhooks: [{ id: '1', path: '/hook', secret: 'webhook-secret', script: '', enabled: true }],
      jsFunctions: [
        {
          name: 'leak',
          script: `return {
            configToken: config.token,
            clientToken: client.token,
            dbConfig: db.config,
            dbToken: db.config?.token,
            webhookSecret: config.inboundWebhooks?.[0]?.secret,
          };`,
        },
      ],
    } as never;
    const db = new ScriptDb('bot-1', config, store as never, {}, {});
    const executor = new ScriptExecutor(5000);
    const result = (await executor.execute(
      'return await fn.leak();',
      { client: { token: 'super-secret-token', uptime: 1 } as never, config, variables: {}, db },
      createLogger(),
    )) as Record<string, unknown>;
    executor.dispose();
    expect(result.configToken).toBeUndefined();
    expect(result.clientToken).toBeUndefined();
    expect(result.dbConfig).toBeUndefined();
    expect(result.dbToken).toBeUndefined();
    expect(result.webhookSecret).toBeUndefined();
  });
});

describe('fn : cache et rechargement', () => {
  it('un corps modifié entre deux exécutions est pris en compte', async () => {
    const executor = new ScriptExecutor(5000);
    const execute = (jsFunctions: FnDef[]) =>
      executor.execute('return await fn.value();', { client: {} as never, config: { token: 'x', jsFunctions } as never, variables: {} }, createLogger());
    expect(await execute([{ name: 'value', script: 'return 1;' }])).toBe(1);
    expect(await execute([{ name: 'value', script: 'return 2;' }])).toBe(2);
    expect(await execute([{ name: 'value', params: ['x'], script: 'return typeof x;' }])).toBe('undefined');
    executor.dispose();
  });

  it('une même configuration exécutée plusieurs fois renvoie le même résultat', async () => {
    const executor = new ScriptExecutor(5000);
    const config = { token: 'x', jsFunctions: [{ name: 'sq', params: ['n'], script: 'return n * n;' }] } as never;
    for (const n of [2, 3, 4]) {
      expect(await executor.execute(`return await fn.sq(${n});`, { client: {} as never, config, variables: {} }, createLogger())).toBe(n * n);
    }
    executor.dispose();
  });

  it('une fonction ajoutée par un rechargement devient appelable, une supprimée disparaît', async () => {
    const executor = new ScriptExecutor(5000);
    const execute = (jsFunctions: FnDef[]) =>
      executor.execute(
        "try { return await fn.a(); } catch (e) { return e.message; }",
        { client: {} as never, config: { token: 'x', jsFunctions } as never, variables: {} },
        createLogger(),
      );
    expect(await execute([])).toBe('Unknown function a (disponibles : aucune)');
    expect(await execute([{ name: 'a', script: "return 'now';" }])).toBe('now');
    expect(await execute([])).toBe('Unknown function a (disponibles : aucune)');
    executor.dispose();
  });
});

// ---------------------------------------------------------------------------
// Validation de la bibliothèque (entrée invalide ignorée avec warn, jamais d exception)
// ---------------------------------------------------------------------------

const EXPECTED_SCOPE_NAMES = [
  'client',
  'config',
  'variables',
  'interaction',
  'message',
  'member',
  'guild',
  'channel',
  'webhook',
  'db',
  'sql',
  'pgsql',
  'mongo',
  'console',
  'fetch',
  'require',
  'setTimeout',
  'clearTimeout',
  'fn',
];

function load(raw: unknown) {
  const warnings: string[] = [];
  const library = loadFunctionLibrary(raw, SCOPE_PARAM_NAMES, (message) => warnings.push(message));
  return { library, warnings, names: library.names() };
}

describe('paramètres de portée', () => {
  it('fn est ajouté EN FIN de la liste, sans autre nouveau paramètre', () => {
    expect([...SCOPE_PARAM_NAMES]).toEqual(EXPECTED_SCOPE_NAMES);
  });
});

describe('validation des fonctions JS', () => {
  it('accepte une fonction valide et conserve l ordre déclaré', () => {
    const { library, warnings, names } = load([
      { id: 'b', name: 'beta', params: ['x'], script: 'return x;' },
      { id: 'a', name: 'alpha', script: 'return 1;' },
    ]);
    expect(names).toEqual(['beta', 'alpha']);
    expect(warnings).toEqual([]);
    expect(library.functions.get('beta')).toMatchObject({ id: 'b', name: 'beta', params: ['x'], script: 'return x;' });
    expect(library.functions.get('alpha')?.params).toEqual([]);
  });

  it('absent, null ou autre chose qu un tableau = aucune fonction, sans erreur', () => {
    for (const raw of [undefined, null, 'oops', 42, { f: { script: 'x' } }, []]) {
      const { names } = load(raw);
      expect(names).toEqual([]);
    }
  });

  it('une entrée qui n est pas un objet est ignorée avec un warn', () => {
    const { names, warnings } = load([1, null, 'x', [1], { name: 'ok', script: 'return 1;' }]);
    expect(names).toEqual(['ok']);
    expect(warnings.length).toBeGreaterThanOrEqual(1);
  });

  it('accepte les noms valides', () => {
    const valid = ['a', 'Z', '_', '$', '$a', '_a1', 'a$1', 'then2', 'toStringify', 'b'.repeat(64)];
    const { names, warnings } = load(valid.map((name) => ({ name, script: 'return 1;' })));
    expect(names).toEqual(valid);
    expect(warnings).toEqual([]);
  });

  it('refuse les noms qui ne suivent pas la regex', () => {
    const invalid = ['', '1abc', 'a-b', 'a b', 'a.b', 'é', 'a'.repeat(65), 'x\n', ' x'];
    const { names, warnings } = load([
      ...invalid.map((name) => ({ name, script: 'return 1;' })),
      { name: 42, script: 'return 1;' },
      { script: 'return 1;' },
    ]);
    expect(names).toEqual([]);
    expect(warnings.length).toBeGreaterThanOrEqual(1);
  });

  it('refuse les mots réservés et les noms dangereux', () => {
    const reserved = [
      'delete', 'class', 'await', 'new', 'null', 'true', 'false', 'function', 'yield', 'let', 'static', 'enum',
      'return', 'this', 'typeof', 'void', 'import', 'export', 'super', 'var', 'const', 'if', 'else', 'for', 'while',
      '__proto__', 'constructor', 'prototype', 'then', 'toString', 'valueOf', 'hasOwnProperty',
    ];
    const { names } = load(reserved.map((name) => ({ name, script: 'return 1;' })));
    expect(names).toEqual([]);
  });

  it('refuse un doublon de casse et garde la première occurrence', () => {
    const { names, warnings } = load([
      { name: 'Add', script: 'return 1;' },
      { name: 'add', script: 'return 2;' },
      { name: 'ADD', script: 'return 3;' },
      { name: 'other', script: 'return 4;' },
    ]);
    expect(names).toEqual(['Add', 'other']);
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings.join('\n')).toContain('add');
  });

  it('une fonction désactivée est ignorée sans warn et ne bloque pas le nom', () => {
    const { names, warnings } = load([
      { name: 'dup', script: 'return 1;', enabled: false },
      { name: 'dup', script: 'return 2;' },
    ]);
    expect(names).toEqual(['dup']);
    expect(warnings).toEqual([]);
  });

  it('params : 0 à 20 identifiants uniques', () => {
    const twenty = Array.from({ length: 20 }, (_, index) => `p${index}`);
    const twentyOne = [...twenty, 'p20'];
    expect(load([{ name: 'ok', params: twenty, script: 'return 1;' }]).names).toEqual(['ok']);
    expect(load([{ name: 'ko', params: twentyOne, script: 'return 1;' }]).names).toEqual([]);
    expect(load([{ name: 'dup', params: ['a', 'a'], script: 'return 1;' }]).names).toEqual([]);
    expect(load([{ name: 'nul', params: null, script: 'return 1;' }]).names).toEqual(['nul']);
  });

  it('params : refuse les valeurs qui ne sont pas des identifiants', () => {
    for (const params of ['a', [1], [''], ['a b'], ['1a'], ['a-b'], [null], ['class'], ['await'], ['arguments'], ['eval'], ['undefined']]) {
      expect(load([{ name: 'bad', params, script: 'return 1;' }]).names).toEqual([]);
    }
  });

  it('params : refuse chaque nom de portée de script, fn compris', () => {
    for (const scopeName of EXPECTED_SCOPE_NAMES) {
      const { names, warnings } = load([{ name: 'bad', params: [scopeName], script: 'return 1;' }]);
      expect(names).toEqual([]);
      expect(warnings.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('script : non vide, au plus 65536 caractères', () => {
    expect(load([{ name: 'a', script: '' }]).names).toEqual([]);
    expect(load([{ name: 'a', script: '   \n ' }]).names).toEqual([]);
    expect(load([{ name: 'a', script: 12 }]).names).toEqual([]);
    expect(load([{ name: 'a' }]).names).toEqual([]);
    expect(load([{ name: 'a', script: 'x'.repeat(65_536) }]).names).toEqual(['a']);
    expect(load([{ name: 'a', script: 'x'.repeat(65_537) }]).names).toEqual([]);
  });

  it('au plus 100 fonctions, l excédent est ignoré avec un seul avertissement de dépassement', () => {
    const entries = Array.from({ length: 105 }, (_, index) => ({ name: `f${index}`, script: 'return 1;' }));
    const { names, warnings } = load(entries);
    expect(names).toHaveLength(100);
    expect(names[99]).toBe('f99');
    expect(warnings.filter((warning) => /100/.test(warning))).toHaveLength(1);
  });

  it('plafond agrégé de 512 Ko : les fonctions qui le dépassent sont ignorées', () => {
    const entries = Array.from({ length: 10 }, (_, index) => ({ name: `big${index}`, script: 'x'.repeat(60_000) }));
    const { names, warnings } = load(entries);
    expect(names).toHaveLength(8);
    expect(warnings.length).toBeGreaterThanOrEqual(1);
  });

  it('les avertissements ne contiennent jamais le corps de la fonction', () => {
    const { warnings } = load([
      { name: '1bad', script: 'const SECRET_BODY_MARKER = 1;' },
      { name: 'ok', params: ['class'], script: 'const SECRET_BODY_MARKER = 2;' },
    ]);
    expect(warnings.length).toBeGreaterThanOrEqual(2);
    expect(warnings.join('\n')).not.toContain('SECRET_BODY_MARKER');
  });

  it('les avertissements sont plafonnés même avec des centaines d entrées invalides', () => {
    const { warnings } = load(Array.from({ length: 500 }, () => ({ name: '!', script: 'return 1;' })));
    expect(warnings.length).toBeLessThanOrEqual(15);
  });

  it('getFunctionLibrary met en cache par tableau et n avertit qu une fois', () => {
    const entries = [
      { name: '1bad', script: 'return 1;' },
      { name: 'good', script: 'return 1;' },
    ];
    const warnings: string[] = [];
    const first = getFunctionLibrary(entries, SCOPE_PARAM_NAMES, (message) => warnings.push(message));
    const second = getFunctionLibrary(entries, SCOPE_PARAM_NAMES, (message) => warnings.push(message));
    expect(second).toBe(first);
    expect(warnings).toHaveLength(1);
    const reloaded = getFunctionLibrary([...entries], SCOPE_PARAM_NAMES, (message) => warnings.push(message));
    expect(reloaded).not.toBe(first);
    expect(warnings).toHaveLength(2);
  });
});

describe('fn : cache de compilation borné', () => {
  it('ne dépasse pas FUNCTION_CACHE_MAX entrées', async () => {
    const executor = new ScriptExecutor(5000);
    for (let index = 0; index < FUNCTION_CACHE_MAX + 40; index += 1) {
      await executor.execute(
        'return await fn.unique();',
        {
          client: {} as never,
          config: { token: 'x', jsFunctions: [{ name: 'unique', script: `return ${index};` }] } as never,
          variables: {},
        },
        createLogger(),
      );
    }
    executor.dispose();
    expect(functionCompiledCacheSize()).toBeLessThanOrEqual(FUNCTION_CACHE_MAX);
    expect(functionCompiledCacheSize()).toBeGreaterThan(0);
  });
});

describe('fn : avertissements de la bibliothèque dans le journal du bot', () => {
  it('une fonction rejetée est journalisée (warn) sans empêcher le script de tourner', async () => {
    const logger = createLogger();
    const defs = [
      { name: '1bad', script: 'return 1;' },
      { name: 'good', script: "return 'ok';" },
    ];
    expect(await run('return await fn.good();', defs, { logger })).toBe('ok');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0]?.[0])).toContain('1bad');
  });

  it('une fonction à SyntaxError est journalisée une fois à sa première compilation', async () => {
    const logger = createLogger();
    const defs = [{ name: 'broken2', script: 'return (;' }];
    const script = 'try { await fn.broken2(); } catch {} try { await fn.broken2(); } catch {} return 1;';
    await run(script, defs, { logger });
    const warnings = logger.warn.mock.calls.map((call) => String(call[0])).filter((text) => text.includes('broken2'));
    expect(warnings).toHaveLength(1);
  });
});
