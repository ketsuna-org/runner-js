import { describe, expect, it } from 'bun:test';
import { Collection } from 'discord.js';

import {
  PREFIX_VARIABLE_CACHE_TTL_MS,
  PrefixResolver,
  mentionsWithoutUser,
  observePrefixVariableWrites,
  parseInvocation,
  sanitizePrefixValue,
} from '../src/discord/message-invocation.js';
import { parseJsBotConfig } from '../src/config/js-bot-config.js';
import type { VariableDatabase } from '../src/runtime/variable-database.js';
import vectors from './fixtures/invocation-vectors.json';

type ParseVector = {
  name: string;
  content: string;
  botId?: string | null;
  prefixes?: string[];
  mentionEnabled?: boolean;
  noPrefixEnabled?: boolean;
  expected: unknown;
};

describe('parseInvocation (vecteurs partagés avec le runner Dart)', () => {
  it.each(vectors.parse as ParseVector[])('$name', (vector) => {
    const botId = 'botId' in vector ? vector.botId : vectors.botId;
    expect(
      parseInvocation(vector.content, {
        botId,
        prefixes: vector.prefixes ?? [],
        mentionEnabled: vector.mentionEnabled ?? false,
        noPrefixEnabled: vector.noPrefixEnabled ?? false,
      }),
    ).toEqual(vector.expected as never);
  });

  it('ne plante pas sur un contenu qui n est pas du texte', () => {
    for (const content of [undefined, null, 42, {}]) {
      expect(
        parseInvocation(content as never, {
          botId: vectors.botId,
          prefixes: ['!'],
          mentionEnabled: true,
          noPrefixEnabled: true,
        }),
      ).toBeNull();
    }
  });
});

describe('sanitizePrefixValue (vecteurs partagés avec le runner Dart)', () => {
  it.each(vectors.sanitize as Array<{ name: string; value: unknown; expected: string[] }>)(
    '$name',
    ({ value, expected }) => {
      expect(sanitizePrefixValue(value)).toEqual(expected);
    },
  );
});

type StoreCalls = { scoped: number; globals: number };

function fakeStore(initial: {
  scoped?: Record<string, unknown>;
  globals?: Record<string, unknown>;
  failScoped?: boolean;
}) {
  const calls: StoreCalls = { scoped: 0, globals: 0 };
  const scoped = new Map<string, unknown>(Object.entries(initial.scoped ?? {}));
  const globals = { ...(initial.globals ?? {}) };
  const store = {
    getScopedVariable: async (botId: string, scope: string, contextId: string, key: string) => {
      calls.scoped += 1;
      if (initial.failScoped) throw new Error('database is locked');
      return scoped.get(`${scope}:${contextId}:${key}`);
    },
    getGlobalVariables: async () => {
      calls.globals += 1;
      return { ...globals };
    },
    setScopedVariable: async (_b: string, scope: string, contextId: string, key: string, value: unknown) => {
      scoped.set(`${scope}:${contextId}:${key}`, value);
    },
    removeScopedVariable: async (_b: string, scope: string, contextId: string, key: string) => {
      scoped.delete(`${scope}:${contextId}:${key}`);
    },
    removeAllScopedValuesForKey: async () => undefined,
    setGlobalVariable: async (_b: string, key: string, value: unknown) => {
      globals[key] = value;
    },
    removeGlobalVariable: async (_b: string, key: string) => {
      delete globals[key];
    },
    renameGlobalVariable: async () => undefined,
  } as unknown as VariableDatabase;
  return { store, calls, scoped, globals };
}

function resolverFor(
  rawConfig: Record<string, unknown>,
  storeInit: Parameters<typeof fakeStore>[0],
  clock = { now: 1_000 },
) {
  const config = parseJsBotConfig(rawConfig);
  const { store, calls, scoped, globals } = fakeStore(storeInit);
  const errors: string[] = [];
  const resolver = new PrefixResolver({
    botId: 'bot',
    store,
    getConfig: () => config,
    now: () => clock.now,
    onError: (message) => errors.push(message),
  });
  return { resolver, calls, scoped, globals, clock, errors, config, store };
}

describe('PrefixResolver', () => {
  const STATIC = ['!'];

  it('sans variable configurée : liste statique, aucune lecture', async () => {
    const { resolver, calls } = resolverFor({ prefix: '!' }, {});
    expect(await resolver.resolve('g1', STATIC)).toBe(STATIC);
    expect(calls).toEqual({ scoped: 0, globals: 0 });
  });

  it('la valeur de la variable REMPLACE la liste statique pour le serveur', async () => {
    const { resolver } = resolverFor(
      { prefix: '!', prefixVariable: 'prefix' },
      { scoped: { 'guild:g1:prefix': '?? $' } },
    );
    expect(await resolver.resolve('g1', STATIC)).toEqual(['??', '$']);
    // Autre serveur sans valeur : liste statique.
    expect(await resolver.resolve('g2', STATIC)).toBe(STATIC);
  });

  it('DM (pas de serveur) : liste statique, aucune lecture', async () => {
    const { resolver, calls } = resolverFor(
      { prefixVariable: 'prefix' },
      { scoped: { 'guild:g1:prefix': '?' } },
    );
    expect(await resolver.resolve(null, STATIC)).toBe(STATIC);
    expect(await resolver.resolve(undefined, STATIC)).toBe(STATIC);
    expect(calls.scoped).toBe(0);
  });

  it('accepte le nom avec ou sans bc_ et retombe sur la clé historique bc_', async () => {
    const withPrefix = resolverFor(
      { prefixVariable: 'bc_prefix' },
      { scoped: { 'guild:g1:prefix': '?' } },
    );
    expect(await withPrefix.resolver.resolve('g1', STATIC)).toEqual(['?']);
    const legacy = resolverFor(
      { prefixVariable: 'prefix' },
      { scoped: { 'guild:g1:bc_prefix': '?' } },
    );
    expect(await legacy.resolver.resolve('g1', STATIC)).toEqual(['?']);
  });

  it('valeur par défaut de la définition de variable avant la liste statique', async () => {
    const { resolver } = resolverFor(
      {
        prefixVariable: 'prefix',
        scopedVariableDefinitions: [
          { key: 'bc_prefix', scope: 'guild', defaultValue: '>' },
          { key: 'prefix', scope: 'user', defaultValue: 'NOPE' },
        ],
      },
      { scoped: { 'guild:g2:prefix': '?' } },
    );
    expect(await resolver.resolve('g1', STATIC)).toEqual(['>']);
    expect(await resolver.resolve('g2', STATIC)).toEqual(['?']);
  });

  it('portée global : variable globale du bot (runtime, puis config), avec ou sans bc_', async () => {
    const runtime = resolverFor(
      { prefixVariable: 'prefix', prefixVariableScope: 'global' },
      { globals: { prefix: '~' } },
    );
    expect(await runtime.resolver.resolve('g1', STATIC)).toEqual(['~']);
    expect(await runtime.resolver.resolve('g2', STATIC)).toEqual(['~']);
    // DM : liste statique même en portée global.
    expect(await runtime.resolver.resolve(null, STATIC)).toBe(STATIC);

    const fromConfig = resolverFor(
      { prefixVariable: 'prefix', prefixVariableScope: 'global', globalVariables: { bc_prefix: '%' } },
      {},
    );
    expect(await fromConfig.resolver.resolve('g1', STATIC)).toEqual(['%']);

    const override = resolverFor(
      { prefixVariable: 'prefix', prefixVariableScope: 'global', globalVariables: { prefix: '%' } },
      { globals: { prefix: '~' } },
    );
    expect(await override.resolver.resolve('g1', STATIC)).toEqual(['~']);
  });

  it('valeur vide, hostile ou illisible : liste statique', async () => {
    for (const value of ['', '   ', 'x'.repeat(40), 42, null, { a: 1 }]) {
      const { resolver } = resolverFor(
        { prefixVariable: 'prefix' },
        { scoped: { 'guild:g1:prefix': value } },
      );
      expect(await resolver.resolve('g1', STATIC)).toBe(STATIC);
    }
  });

  it('erreur de lecture : liste statique, erreur signalée sans la valeur, nouvel essai après un court délai', async () => {
    const { resolver, calls, errors, clock } = resolverFor(
      { prefixVariable: 'prefix' },
      { failScoped: true },
    );
    expect(await resolver.resolve('g1', STATIC)).toBe(STATIC);
    expect(await resolver.resolve('g1', STATIC)).toBe(STATIC);
    expect(calls.scoped).toBeGreaterThan(0);
    const afterFirst = calls.scoped;
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('prefix');
    clock.now += 6_000;
    await resolver.resolve('g1', STATIC);
    expect(calls.scoped).toBeGreaterThan(afterFirst);
  });

  it('cache : une seule lecture pour des messages rapprochés (même concurrents), relecture après le TTL', async () => {
    const { resolver, calls, clock } = resolverFor(
      { prefixVariable: 'prefix' },
      { scoped: { 'guild:g1:prefix': '?' } },
    );
    await Promise.all([resolver.resolve('g1', STATIC), resolver.resolve('g1', STATIC)]);
    await resolver.resolve('g1', STATIC);
    expect(calls.scoped).toBe(1);
    // Un autre serveur a sa propre entrée (sans valeur : clé puis clé historique bc_, soit 2 lectures).
    await resolver.resolve('g2', STATIC);
    await resolver.resolve('g2', STATIC);
    expect(calls.scoped).toBe(3);
    clock.now += PREFIX_VARIABLE_CACHE_TTL_MS + 1;
    await resolver.resolve('g1', STATIC);
    expect(calls.scoped).toBe(4);
  });

  it('invalidate() force la relecture (reload de la configuration)', async () => {
    const { resolver, calls, scoped } = resolverFor(
      { prefixVariable: 'prefix' },
      { scoped: { 'guild:g1:prefix': '?' } },
    );
    expect(await resolver.resolve('g1', STATIC)).toEqual(['?']);
    scoped.set('guild:g1:prefix', '#');
    expect(await resolver.resolve('g1', STATIC)).toEqual(['?']);
    resolver.invalidate();
    expect(await resolver.resolve('g1', STATIC)).toEqual(['#']);
    expect(calls.scoped).toBe(2);
  });

  it('une lecture en cours au moment d invalidate() ne remplit pas le cache avec une valeur périmée', async () => {
    const config = parseJsBotConfig({ prefixVariable: 'prefix' });
    let release: (() => void) | undefined;
    let current: unknown = '?';
    let reads = 0;
    const store = {
      getScopedVariable: async () => {
        reads += 1;
        const seen = current;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return seen;
      },
      getGlobalVariables: async () => ({}),
    } as unknown as VariableDatabase;
    const resolver = new PrefixResolver({ botId: 'bot', store, getConfig: () => config, now: () => 0 });
    const first = resolver.resolve('g1', STATIC);
    await Promise.resolve();
    current = '#';
    resolver.invalidate();
    release?.();
    expect(await first).toEqual(['?']);
    const second = resolver.resolve('g1', STATIC);
    await new Promise((resolve) => setTimeout(resolve, 0));
    release?.();
    expect(await second).toEqual(['#']);
    expect(reads).toBe(2);
  });
});

describe('PrefixResolver : lecture bornée et cache', () => {
  const STATIC = ['!'];

  it('une lecture qui ne répond jamais est abandonnée après le délai : liste statique, erreur signalée, tous les messages libérés', async () => {
    const config = parseJsBotConfig({ prefixVariable: 'prefix' });
    let reads = 0;
    const store = {
      getScopedVariable: () => {
        reads += 1;
        return new Promise(() => undefined);
      },
      getGlobalVariables: async () => ({}),
    } as unknown as VariableDatabase;
    const errors: string[] = [];
    const resolver = new PrefixResolver({
      botId: 'bot',
      store,
      getConfig: () => config,
      readTimeoutMs: 20,
      onError: (message) => errors.push(message),
    });

    // Plusieurs messages du même serveur partagent la lecture en cours : tous sont libérés ensemble.
    const results = await Promise.all([
      resolver.resolve('g1', STATIC),
      resolver.resolve('g1', STATIC),
      resolver.resolve('g1', STATIC),
    ]);
    expect(results.every((result) => result === STATIC)).toBe(true);
    expect(reads).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('timed out');
    expect(errors[0]).toContain('prefix');

    // Dans le court délai d'erreur, les messages suivants ne rouvrent pas de lecture ni n'attendent.
    expect(await resolver.resolve('g1', STATIC)).toBe(STATIC);
    expect(reads).toBe(1);
  });

  it('une lecture lente mais qui répond dans le délai est utilisée', async () => {
    const config = parseJsBotConfig({ prefixVariable: 'prefix' });
    const store = {
      getScopedVariable: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return '?';
      },
      getGlobalVariables: async () => ({}),
    } as unknown as VariableDatabase;
    const resolver = new PrefixResolver({ botId: 'bot', store, getConfig: () => config, readTimeoutMs: 1_000 });
    expect(await resolver.resolve('g1', STATIC)).toEqual(['?']);
  });

  it('un bot présent dans plus de 1 000 serveurs garde ses lectures en cache (pas une requête par message)', async () => {
    const guilds = 1_500;
    const { resolver, calls } = resolverFor({ prefixVariable: 'prefix' }, { scoped: {} });
    for (let round = 0; round < 2; round += 1) {
      for (let index = 0; index < guilds; index += 1) {
        await resolver.resolve(`g${index}`, STATIC);
      }
    }
    // Variable absente = 2 lectures (clé, puis clé historique bc_) par serveur, une seule fois chacun.
    expect(calls.scoped).toBe(guilds * 2);
  });

  it('cache plein : le serveur le moins récemment utilisé est évincé, pas le plus ancien inséré', async () => {
    const config = parseJsBotConfig({ prefixVariable: 'prefix' });
    const { store, calls } = fakeStore({
      scoped: { 'guild:g1:prefix': '1', 'guild:g2:prefix': '2', 'guild:g3:prefix': '3', 'guild:g4:prefix': '4' },
    });
    const resolver = new PrefixResolver({ botId: 'bot', store, getConfig: () => config, maxEntries: 3 });
    for (const guild of ['g1', 'g2', 'g3']) await resolver.resolve(guild, STATIC);
    expect(calls.scoped).toBe(3);

    await resolver.resolve('g1', STATIC); // g1 redevient le plus récent : g2 est maintenant le moins récent
    await resolver.resolve('g4', STATIC); // cache plein : évince g2
    expect(calls.scoped).toBe(4);

    await resolver.resolve('g1', STATIC);
    await resolver.resolve('g3', STATIC);
    await resolver.resolve('g4', STATIC);
    expect(calls.scoped).toBe(4); // tous en cache
    await resolver.resolve('g2', STATIC);
    expect(calls.scoped).toBe(5); // g2 a dû être relu
  });
});

describe('observePrefixVariableWrites', () => {
  it('signale l écriture de la clé de la variable de préfixe, pas celle des autres', async () => {
    const { store } = fakeStore({});
    let changes = 0;
    const observed = observePrefixVariableWrites(store, () => 'prefix', () => {
      changes += 1;
    });
    await observed.setScopedVariable('bot', 'guild', 'g1', 'prefix', '?');
    await observed.setScopedVariable('bot', 'guild', 'g1', 'bc_prefix', '?');
    expect(changes).toBe(2);
    await observed.setScopedVariable('bot', 'guild', 'g1', 'coins', 1);
    await observed.removeScopedVariable('bot', 'guild', 'g1', 'coins');
    expect(changes).toBe(2);
    await observed.removeScopedVariable('bot', 'guild', 'g1', 'prefix');
    await observed.removeAllScopedValuesForKey('bot', 'guild', 'prefix');
    await observed.setGlobalVariable('bot', 'prefix', '?');
    await observed.removeGlobalVariable('bot', 'prefix');
    await observed.renameGlobalVariable('bot', 'other', 'prefix');
    expect(changes).toBe(7);
    await observed.setGlobalVariable('bot', 'other', 1);
    expect(changes).toBe(7);
  });

  it('délègue les lectures à la base d origine et ne signale rien sans variable configurée', async () => {
    const { store, scoped } = fakeStore({ scoped: { 'guild:g1:prefix': '?' } });
    let changes = 0;
    const observed = observePrefixVariableWrites(store, () => null, () => {
      changes += 1;
    });
    expect(await observed.getScopedVariable('bot', 'guild', 'g1', 'prefix')).toBe('?');
    await observed.setScopedVariable('bot', 'guild', 'g1', 'prefix', '#');
    expect(scoped.get('guild:g1:prefix')).toBe('#');
    expect(changes).toBe(0);
  });
});

describe('mentionsWithoutUser', () => {
  it('retire le bot des mentions utilisateur et membre, laisse le reste intact', () => {
    const bot = { id: '900' };
    const other = { id: '5' };
    const mentions = {
      users: new Collection<string, { id: string }>([['900', bot], ['5', other]]),
      members: new Collection<string, { id: string }>([['900', bot], ['5', other]]),
      everyone: false,
      repliedUser: null,
      has(id: string) {
        return this.users.has(id);
      },
    };
    const view = mentionsWithoutUser(mentions, '900');
    expect([...view.users.keys()]).toEqual(['5']);
    expect([...view.members.keys()]).toEqual(['5']);
    expect(view.users.first()).toBe(other);
    expect(view.everyone).toBe(false);
    expect(view.has('5')).toBe(true);
    // L objet d origine n est pas modifié et la vue est stable d un accès à l autre.
    expect(mentions.users.size).toBe(2);
    expect(view.users).toBe(view.users);
  });

  it('accepte des mentions sans membres (message privé)', () => {
    const view = mentionsWithoutUser({ users: new Collection<string, { id: string }>(), members: null }, '900');
    expect(view.members).toBeNull();
    expect(view.users.size).toBe(0);
  });
});
