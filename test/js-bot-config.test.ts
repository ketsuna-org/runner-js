import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { Client } from 'discord.js';

import { HandlerRegistry } from '../src/discord/handler-registry.js';
import type { VariableDatabase } from '../src/runtime/variable-database.js';
import type { ScriptExecutor } from '../src/scripts/script-executor.js';
import {
  commandAllowsNoPrefix,
  normalizePrefixEntry,
  parseJsBotConfig,
  resolveCommandPrefix,
  resolveCommandPrefixes,
  validateJsBotConfig,
} from '../src/config/js-bot-config.js';

describe('JsBotConfig', () => {
  it('accepts independent handlers for the same event', () => {
    const config = parseJsBotConfig({
      events: [
        { id: 'buttons', name: 'interactionCreate', script: 'true;' },
        { id: 'menus', name: 'interactionCreate', script: 'true;' },
      ],
    });
    expect(() => validateJsBotConfig(config)).not.toThrow();
    expect(config.events).toHaveLength(2);
  });

  it('rejects duplicate event identities', () => {
    const config = parseJsBotConfig({
      events: [
        { id: 'same', name: 'interactionCreate', script: 'true;' },
        { id: 'same', name: 'messageCreate', script: 'true;' },
      ],
    });
    expect(() => validateJsBotConfig(config)).toThrow(/Duplicate event handler ID/);
  });
  it('parses a minimal valid config', () => {
    const config = parseJsBotConfig({
      token: 'test-token',
      commands: [
        {
          id: 'cmd-1',
          type: 'command',
          name: 'ping',
          description: 'Ping',
          script: "await interaction.reply('pong');",
        },
      ],
    });

    expect(config.token).toBe('test-token');
    expect(config.commands).toHaveLength(1);
    validateJsBotConfig(config);
  });

  it('rejects duplicate command names', () => {
    const config = parseJsBotConfig({
      token: 'test-token',
      commands: [
        { id: '1', type: 'command', name: 'ping', script: 'true;' },
        { id: '2', type: 'command', name: 'ping', script: 'true;' },
      ],
    });

    expect(() => validateJsBotConfig(config)).toThrow(/Duplicate command name/);
  });

  it('rejects script timeouts above 15 minutes', () => {
    expect(() =>
      parseJsBotConfig({
        token: 'test-token',
        scriptTimeoutMs: 15 * 60 * 1000 + 1,
      }),
    ).toThrow();
  });

  it('defaults script timeout to 15 minutes', () => {
    const config = parseJsBotConfig({ token: 'test-token' });
    expect(config.scriptTimeoutMs).toBe(15 * 60 * 1000);
  });

  it('accepts empty or null command lists', () => {
    const empty = parseJsBotConfig({ token: 'test-token', commands: [] });
    validateJsBotConfig(empty);
    expect(empty.commands).toEqual([]);

    const missing = parseJsBotConfig({ token: 'test-token' });
    validateJsBotConfig(missing);
    expect(missing.commands).toEqual([]);

    const nil = parseJsBotConfig({ token: 'test-token', commands: null });
    validateJsBotConfig(nil);
    expect(nil.commands).toEqual([]);
  });

  it('parses command aliases correctly', () => {
    const config = parseJsBotConfig({
      token: 'test-token',
      commands: [
        {
          id: 'cmd-1',
          type: 'command',
          name: 'help',
          aliases: ['h', 'aide', 'halp'],
          script: 'true;',
        },
      ],
    });

    expect(config.commands[0]?.aliases).toEqual(['h', 'aide', 'halp']);
  });
});

describe('resolveCommandPrefix', () => {
  it('keeps the configured prefix', () => {
    expect(resolveCommandPrefix({ prefix: ' ? ', commands: [] })).toBe('?');
  });
  it('falls back to ! when a prefix or hybrid command exists without a configured prefix', () => {
    expect(resolveCommandPrefix({ commands: [{ triggerType: 'prefix' } as never] })).toBe('!');
    expect(resolveCommandPrefix({ commands: [{ data: { triggerType: 'hybrid' } } as never] })).toBe('!');
    expect(resolveCommandPrefix({ commands: [{ data: { legacyModeEnabled: true } } as never] })).toBe('!');
  });
  it('stays empty without explicit prefix commands', () => {
    expect(resolveCommandPrefix({ commands: [{ triggerType: 'slash' } as never, { enabled: false, triggerType: 'prefix' } as never, {} as never] })).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Lot RJ-SCHEMA : nouveaux champs de configuration (tous optionnels, tolérants).
// ---------------------------------------------------------------------------

describe('JsBotConfig : nouveaux champs conservés par zod', () => {
  it('conserve les champs racine du bot (préfixes, variable de préfixe, sans préfixe, mention, fonctions)', () => {
    const config = parseJsBotConfig({
      token: 't',
      prefix: '!',
      prefixes: ['?', '!!'],
      prefixVariable: 'bc_prefix',
      prefixVariableScope: 'global',
      allowNoPrefixCommands: true,
      mentionAsPrefix: true,
      jsFunctions: [
        { id: 'f1', name: 'add', params: ['a', 'b'], script: 'return a + b;', enabled: true },
      ],
    });

    expect(config.prefixes).toEqual(['?', '!!']);
    expect(config.prefixVariable).toBe('bc_prefix');
    expect(config.prefixVariableScope).toBe('global');
    expect(config.allowNoPrefixCommands).toBe(true);
    expect(config.mentionAsPrefix).toBe(true);
    expect(config.jsFunctions).toEqual([
      { id: 'f1', name: 'add', params: ['a', 'b'], script: 'return a + b;', enabled: true },
    ]);
  });

  it('conserve noPrefix sur la commande (racine et data) sans inventer de champ de mention par commande', () => {
    const config = parseJsBotConfig({
      commands: [
        {
          id: 'c1',
          name: 'ping',
          script: 'true;',
          noPrefix: true,
          data: { noPrefix: false },
          // Décision utilisateur : la mention est un réglage du BOT (mentionAsPrefix), pas de la commande.
          mentionTriggerEnabled: true,
        },
      ],
    });

    const command = config.commands[0]!;
    expect(command.noPrefix).toBe(true);
    expect(command.data?.noPrefix).toBe(false);
    expect('mentionTriggerEnabled' in command).toBe(false);
  });

  it('conserve les champs de planification : cron, timezone, runOnStart, timeoutMs, everyMinutes optionnel', () => {
    const config = parseJsBotConfig({
      scheduled: [
        {
          id: 's1',
          name: 'daily',
          script: 'true;',
          cron: '0 9 * * 1-5',
          timezone: 'Europe/Paris',
          runOnStart: true,
          timeoutMs: 30_000,
        },
        { id: 's2', script: 'true;', everyMinutes: 15 },
        { id: 's3', script: 'true;', everyMinutes: 60, cron: '@hourly' },
      ],
    });

    expect(config.scheduled[0]).toMatchObject({
      id: 's1',
      cron: '0 9 * * 1-5',
      timezone: 'Europe/Paris',
      runOnStart: true,
      timeoutMs: 30_000,
    });
    expect(config.scheduled[0]!.everyMinutes).toBeUndefined();
    expect(config.scheduled[1]!.everyMinutes).toBe(15);
    expect(config.scheduled[2]).toMatchObject({ everyMinutes: 60, cron: '@hourly' });
  });

  it('laisse la sortie strictement identique pour une config sans aucun nouveau champ', () => {
    const parsed = parseJsBotConfig({
      token: 't',
      intents: { GuildMessages: true },
      prefix: '!',
      autoRestart: true,
      presence: { status: 'online', activities: [] },
      databaseConfig: { type: 'none' },
      commands: [{ id: 'c1', name: 'ping', script: 'x', triggerType: 'prefix' }],
      events: [{ id: 'e1', name: 'ready', script: 'x' }],
      scheduled: [{ id: 's1', script: 'x', everyMinutes: 5 }],
      inboundWebhooks: [{ id: 'w1', path: 'p', script: 'x' }],
      globalVariables: { a: 1 },
      scopedVariableDefinitions: [{ key: 'k', scope: 'guild' }],
      scriptTimeoutMs: 1000,
    });

    // toStrictEqual distingue une clé absente d'une clé valant undefined : aucun nouveau champ n'apparaît.
    expect(parsed).toStrictEqual({
      token: 't',
      intents: { GuildMessages: true },
      prefix: '!',
      autoRestart: true,
      presence: { status: 'online', activities: [] },
      databaseConfig: { type: 'none' },
      commands: [
        {
          id: 'c1',
          enabled: true,
          script: 'x',
          type: 'command',
          name: 'ping',
          description: '',
          discordType: 'chatInput',
          triggerType: 'prefix',
          options: [],
          aliases: [],
        },
      ],
      events: [{ id: 'e1', enabled: true, script: 'x', type: 'event', name: 'ready' }],
      scheduled: [{ id: 's1', enabled: true, script: 'x', type: 'scheduled', everyMinutes: 5 }],
      inboundWebhooks: [
        { id: 'w1', enabled: true, script: 'x', type: 'inboundWebhook', path: 'p', secret: '' },
      ],
      globalVariables: { a: 1 },
      scopedVariableDefinitions: [{ key: 'k', scope: 'guild' }],
      scriptTimeoutMs: 1000,
    });
  });
});

describe('JsBotConfig : tolérance des nouveaux champs', () => {
  let warn: ReturnType<typeof spyOn>;

  beforeEach(() => {
    warn = spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  const baseConfig = {
    token: 't',
    prefix: '?',
    commands: [{ id: 'c1', name: 'ping', script: 'true;' }],
    scheduled: [{ id: 's1', script: 'true;', everyMinutes: 5 }],
  };

  function expectRestIntact(config: ReturnType<typeof parseJsBotConfig>): void {
    expect(config.token).toBe('t');
    expect(config.prefix).toBe('?');
    expect(config.commands).toHaveLength(1);
    expect(config.commands[0]!.name).toBe('ping');
    expect(config.scheduled).toHaveLength(1);
    expect(config.scheduled[0]!.everyMinutes).toBe(5);
  }

  const invalidBotValues: Array<[string, unknown]> = [
    ['prefixes', 'pas-un-tableau'],
    ['prefixes', 42],
    ['prefixes', { a: '?' }],
    ['prefixVariable', 12],
    ['prefixVariable', ['x']],
    ['prefixVariableScope', 'user'],
    ['prefixVariableScope', 3],
    ['allowNoPrefixCommands', 'yes'],
    ['allowNoPrefixCommands', 1],
    ['mentionAsPrefix', 'true'],
    ['mentionAsPrefix', {}],
    ['jsFunctions', 'oops'],
    ['jsFunctions', { f: { script: 'x' } }],
  ];

  for (const [field, value] of invalidBotValues) {
    it(`${field} = ${JSON.stringify(value)} : la config est acceptée, le champ ignoré avec un warn`, () => {
      const config = parseJsBotConfig({ ...baseConfig, [field]: value });
      expect((config as Record<string, unknown>)[field]).toBeUndefined();
      expectRestIntact(config);
      expect(() => validateJsBotConfig(config)).not.toThrow();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain(field);
    });
  }

  it('null équivaut à absent, sans warn (le Manager efface ainsi une valeur)', () => {
    const config = parseJsBotConfig({
      ...baseConfig,
      prefixes: null,
      prefixVariable: null,
      prefixVariableScope: null,
      allowNoPrefixCommands: null,
      mentionAsPrefix: null,
      jsFunctions: null,
    });
    expect(config.prefixes).toBeUndefined();
    expect(config.prefixVariable).toBeUndefined();
    expect(config.prefixVariableScope).toBeUndefined();
    expect(config.allowNoPrefixCommands).toBeUndefined();
    expect(config.mentionAsPrefix).toBeUndefined();
    expect(config.jsFunctions).toBeUndefined();
    expectRestIntact(config);
    expect(warn).not.toHaveBeenCalled();
  });

  it('prefixes : les éléments qui ne sont pas des chaînes sont écartés avec un warn', () => {
    const config = parseJsBotConfig({ ...baseConfig, prefixes: [1, '?', null, {}, '$'] });
    expect(config.prefixes).toEqual(['?', '$']);
    expectRestIntact(config);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('jsFunctions : seuls les objets sont gardés (la validation fine est celle du lot fonctions)', () => {
    const config = parseJsBotConfig({
      ...baseConfig,
      jsFunctions: [1, { id: 'f1', name: 'ok', script: 'return 1;' }, 'x', null, [1], { name: '??' }],
    });
    expect(config.jsFunctions).toEqual([{ id: 'f1', name: 'ok', script: 'return 1;' }, { name: '??' }]);
    expectRestIntact(config);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("noPrefix mal typé sur la racine d'une commande : ignoré, la config reste valide", () => {
    const config = parseJsBotConfig({
      ...baseConfig,
      commands: [{ id: 'c1', name: 'ping', script: 'true;', noPrefix: 'yes' }],
    });
    expect(config.commands[0]!.noPrefix).toBeUndefined();
    expect(config.commands[0]!.name).toBe('ping');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('noPrefix');
  });

  const invalidScheduledValues: Array<[string, unknown]> = [
    ['everyMinutes', 0],
    ['everyMinutes', -5],
    ['everyMinutes', 1.5],
    ['everyMinutes', '60'],
    ['cron', 12],
    ['cron', ['* * * * *']],
    ['timezone', { zone: 'UTC' }],
    ['runOnStart', 'yes'],
    ['timeoutMs', -1],
    ['timeoutMs', 1.5],
    ['timeoutMs', '5000'],
  ];

  for (const [field, value] of invalidScheduledValues) {
    it(`scheduled.${field} = ${JSON.stringify(value)} : la config est acceptée, le champ ignoré avec un warn`, () => {
      const config = parseJsBotConfig({
        ...baseConfig,
        scheduled: [{ id: 's1', script: 'true;', everyMinutes: 5, [field]: value }],
      });
      const entry = config.scheduled[0]! as Record<string, unknown>;
      expect(config.scheduled).toHaveLength(1);
      expect(entry.id).toBe('s1');
      if (field === 'everyMinutes') {
        expect(entry.everyMinutes).toBeUndefined();
      } else {
        expect(entry[field]).toBeUndefined();
        expect(entry.everyMinutes).toBe(5);
      }
      expect(config.prefix).toBe('?');
      expect(() => validateJsBotConfig(config)).not.toThrow();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain(field);
    });
  }

  it("une entrée scheduled sans everyMinutes ni cron n'est plus rejetée", () => {
    const config = parseJsBotConfig({
      ...baseConfig,
      scheduled: [{ id: 's1', script: 'true;' }, { id: 's2', script: 'true;', timezone: 'Nope/Nowhere' }],
    });
    expect(config.scheduled).toHaveLength(2);
    expect(config.scheduled[0]!.everyMinutes).toBeUndefined();
    expect(config.scheduled[0]!.cron).toBeUndefined();
    expect(() => validateJsBotConfig(config)).not.toThrow();
  });

  it('les ids scheduled dupliqués ne font pas rejeter la config : dédupliqués avec un warn', () => {
    // Le Manager prend id = workflowName quand l'id est vide : deux déclencheurs du même workflow
    // donnent deux entrées de même id, tolérées par le runner actuel.
    const config = parseJsBotConfig({
      ...baseConfig,
      scheduled: [
        { id: 'wf', name: 'wf', script: 'a;', everyMinutes: 5 },
        { id: 'wf', name: 'wf', script: 'a;', cron: '0 9 * * *' },
        { id: 'wf#2', script: 'b;', everyMinutes: 10 },
      ],
    });

    expect(() => validateJsBotConfig(config)).not.toThrow();
    const ids = config.scheduled.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids[0]).toBe('wf');
    expect(config.scheduled.map((entry) => entry.script)).toEqual(['a;', 'a;', 'b;']);
    expect(warn).toHaveBeenCalled();

    // Idempotent : relire la config déjà assainie ne change plus rien et ne rejette pas.
    warn.mockClear();
    expect(parseJsBotConfig(config)).toEqual(config);
    expect(warn).not.toHaveBeenCalled();
  });

  it('dédupliquer des ids scheduled identiques reste linéaire : 20 000 entrées de même id ne figent pas le processus', () => {
    const count = 20_000;
    const startedAt = performance.now();
    const config = parseJsBotConfig({
      ...baseConfig,
      scheduled: Array.from({ length: count }, () => ({ id: 'a', script: 'x;', everyMinutes: 1 })),
    });
    const elapsed = performance.now() - startedAt;

    const ids = config.scheduled.map((entry) => entry.id);
    expect(ids[0]).toBe('a');
    expect(ids[1]).toBe('a#2');
    expect(ids[count - 1]).toBe(`a#${count}`);
    expect(new Set(ids).size).toBe(count);
    // Quadratique, ce parse prenait ~12 s (la boucle d'événements de TOUS les bots du nœud gelée).
    expect(elapsed).toBeLessThan(1500);
    // Le journal ne recopie pas 20 000 renommages.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0]).length).toBeLessThan(2000);
  });

  it('les renommages gardent la numérotation d’origine quand un id explicite occupe déjà un suffixe', () => {
    const config = parseJsBotConfig({
      ...baseConfig,
      scheduled: ['a', 'a#2', 'a', 'a', 'b', 'a#3', 'b'].map((id) => ({ id, script: 'x;', everyMinutes: 1 })),
    });
    expect(config.scheduled.map((entry) => entry.id)).toEqual(['a', 'a#2', 'a#3', 'a#4', 'b', 'a#3#2', 'b#2']);
  });

  it('garde-fou : un triggerType inconnu est toujours rejeté', () => {
    expect(() =>
      parseJsBotConfig({
        commands: [{ id: 'c1', name: 'ping', script: 'true;', triggerType: 'mention' }],
      }),
    ).toThrow();
  });
});

describe('HandlerRegistry : entrées scheduled', () => {
  it('arme une entrée cron seule et une entrée everyMinutes par setTimeout (jamais de setInterval), et ignore avec un warn une entrée sans planification valide', () => {
    const intervals: unknown[] = [];
    const delays: number[] = [];
    const setIntervalSpy = spyOn(globalThis, 'setInterval').mockImplementation(((_fn: unknown, delay: unknown) => {
      intervals.push(delay);
      return 0;
    }) as never);
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((_fn: unknown, delay: unknown) => {
      delays.push(Number(delay));
      return 0;
    }) as never);
    const clearTimeoutSpy = spyOn(globalThis, 'clearTimeout').mockImplementation((() => undefined) as never);
    const logs: string[] = [];
    try {
      const registry = new HandlerRegistry(
        new EventEmitter() as unknown as Client,
        parseJsBotConfig({
          scheduled: [
            { id: 'seconds', script: 'true;', cron: '* * * * * *' },
            { id: 'cron-only', script: 'true;', cron: '0 9 * * *' },
            { id: 'every', script: 'true;', everyMinutes: 5 },
          ],
        }),
        'bot',
        { execute: async () => {} } as unknown as ScriptExecutor,
        { getGlobalVariables: async () => ({}) } as unknown as VariableDatabase,
        (level, message) => {
          if (level === 'warn') logs.push(message);
        },
      );
      registry.mount();
      registry.clear();
    } finally {
      setIntervalSpy.mockRestore();
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }

    expect(intervals).toEqual([]);
    // `every` (au plus 5 min) et `cron-only` (au plus 24 h) : un timer chacun ; `seconds` (6 champs) est refusée.
    expect(delays).toHaveLength(2);
    expect(delays.every((delay) => delay > 0 && delay <= 24 * 3_600_000)).toBe(true);
    expect(logs.some((line) => line.includes('Scheduled task seconds ignored'))).toBe(true);
    expect(logs.some((line) => line.includes('cron-only'))).toBe(false);
  });
});

describe('resolveCommandPrefixes', () => {
  it("déduplique et trie du plus long au plus court, en gardant l'ordre déclaré à longueur égale", () => {
    expect(resolveCommandPrefixes({ prefix: '!', prefixes: ['!!', '?', '!', '$'] })).toEqual(['!!', '!', '?', '$']);
  });

  it('écarte sans rejet les entrées vides, avec espace ou saut de ligne, trop longues ou non textuelles', () => {
    expect(
      resolveCommandPrefixes({
        prefix: '!',
        prefixes: ['', '   ', 'a b', 'a\tb', 'a\nb', 'abcdef', 'ok', 42 as never, null as never],
      }),
    ).toEqual(['ok', '!']);
  });

  it('mesure la longueur en points de code (un emoji vaut 1, pas 2)', () => {
    expect(resolveCommandPrefixes({ prefixes: ['😀', '😀😀😀😀😀', '😀😀😀😀😀😀'] })).toEqual(['😀😀😀😀😀', '😀']);
  });

  it('limite prefixes à 5 entrées valides', () => {
    expect(resolveCommandPrefixes({ prefixes: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] })).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it("garde le préfixe historique tel quel (compatibilité : il n'a jamais été borné à 5 caractères)", () => {
    expect(resolveCommandPrefixes({ prefix: ' longprefix ' })).toEqual(['longprefix']);
  });

  it('repli sur ! seulement sans aucun préfixe valide et avec une commande prefix ou hybrid active', () => {
    const hybrid = { triggerType: 'hybrid' } as never;
    expect(resolveCommandPrefixes({ commands: [hybrid] })).toEqual(['!']);
    expect(resolveCommandPrefixes({ prefix: '', prefixes: ['', 'a b'], commands: [hybrid] })).toEqual(['!']);
    expect(resolveCommandPrefixes({ commands: [{ triggerType: 'slash' } as never] })).toEqual([]);
    expect(resolveCommandPrefixes({ commands: [{ enabled: false, triggerType: 'prefix' } as never] })).toEqual([]);
    expect(resolveCommandPrefixes({})).toEqual([]);
  });

  it('ne rajoute pas ! quand prefix est vide mais que prefixes contient un préfixe valide', () => {
    expect(
      resolveCommandPrefixes({ prefix: '', prefixes: ['?'], commands: [{ triggerType: 'prefix' } as never] }),
    ).toEqual(['?']);
  });

  it('ne modifie pas resolveCommandPrefix (toujours un seul préfixe, mêmes replis)', () => {
    expect(resolveCommandPrefix({ prefix: '?', prefixes: ['!!'] } as never)).toBe('?');
    expect(resolveCommandPrefix({ prefixes: ['?'], commands: [{ triggerType: 'prefix' } as never] } as never)).toBe('!');
  });
});

describe('normalizePrefixEntry', () => {
  it("rend l'entrée nettoyée ou null", () => {
    expect(normalizePrefixEntry(' ? ')).toBe('?');
    expect(normalizePrefixEntry('')).toBeNull();
    expect(normalizePrefixEntry('a b')).toBeNull();
    expect(normalizePrefixEntry('abcdef')).toBeNull();
    expect(normalizePrefixEntry('abcde')).toBe('abcde');
    expect(normalizePrefixEntry(7)).toBeNull();
  });
});

describe('commandAllowsNoPrefix', () => {
  const make = (extra: Record<string, unknown>) => extra as never;

  it('est vrai seulement pour une commande prefix|hybrid activée avec noPrefix', () => {
    expect(commandAllowsNoPrefix(make({ triggerType: 'prefix', noPrefix: true }))).toBe(true);
    expect(commandAllowsNoPrefix(make({ triggerType: 'hybrid', noPrefix: true }))).toBe(true);
    // Sans triggerType déclaré, une commande historique est hybride.
    expect(commandAllowsNoPrefix(make({ noPrefix: true }))).toBe(true);
    expect(commandAllowsNoPrefix(make({ data: { legacyModeEnabled: true, noPrefix: true } }))).toBe(true);
  });

  it('est faux pour slash, none, commande désactivée ou noPrefix absent', () => {
    expect(commandAllowsNoPrefix(make({ triggerType: 'slash', noPrefix: true }))).toBe(false);
    expect(commandAllowsNoPrefix(make({ triggerType: 'none', noPrefix: true }))).toBe(false);
    expect(commandAllowsNoPrefix(make({ triggerType: 'prefix', noPrefix: true, enabled: false }))).toBe(false);
    expect(commandAllowsNoPrefix(make({ triggerType: 'prefix' }))).toBe(false);
    expect(commandAllowsNoPrefix(make({ triggerType: 'prefix', noPrefix: false }))).toBe(false);
  });

  it('lit data.noPrefix avant la racine, et ignore une valeur non booléenne', () => {
    expect(commandAllowsNoPrefix(make({ triggerType: 'prefix', noPrefix: true, data: { noPrefix: false } }))).toBe(false);
    expect(commandAllowsNoPrefix(make({ triggerType: 'prefix', noPrefix: false, data: { noPrefix: true } }))).toBe(true);
    expect(commandAllowsNoPrefix(make({ triggerType: 'prefix', noPrefix: true, data: { noPrefix: 'no' } }))).toBe(true);
    expect(commandAllowsNoPrefix(make({ triggerType: 'prefix', data: { noPrefix: 'true' } }))).toBe(false);
  });

  it('dérive la présence de statuses et presenceStatus quand presence est absent', () => {
    const parsed = parseJsBotConfig({
      token: 't',
      presenceStatus: 'dnd',
      statuses: [
        { type: 'custom', text: 'Prêt à aider', minIntervalSeconds: 30 },
        { type: 'inconnu', name: 'x' },
        { type: 'playing', text: '  ' },
      ],
    });
    expect(parsed.presence).toEqual({
      status: 'dnd',
      activities: [
        { type: 'custom', name: 'Prêt à aider', minIntervalSeconds: 30 },
        { type: 'playing', name: 'x' },
      ],
    });
  });

  it('garde presence telle quelle quand elle est fournie', () => {
    const parsed = parseJsBotConfig({
      token: 't',
      presence: { status: 'idle', activities: [] },
      presenceStatus: 'dnd',
      statuses: [{ type: 'custom', name: 'ignoré' }],
    });
    expect(parsed.presence).toEqual({ status: 'idle', activities: [] });
  });
});
