import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { parseJsBotConfig } from '../src/config/js-bot-config.js';
import { BotStore } from '../src/runtime/bot-store.js';

describe('BotStore disk persistence', () => {
  let dir: string;
  let store: BotStore;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'runner-js-botstore-'));
    store = new BotStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function sampleConfig(script = 'return 1;') {
    return parseJsBotConfig({
      token: 'test-token',
      commands: [{ id: 'c1', name: 'ping', script }],
    });
  }

  it('saves and loads config from disk', async () => {
    await store.save('bot-1', 'Alpha', sampleConfig('return 42;'));
    const loaded = await store.load('bot-1');
    expect(loaded?.name).toBe('Alpha');
    expect(loaded?.config.commands[0]?.script).toBe('return 42;');
  });

  it('lists bots sorted by name', async () => {
    await store.save('bot-b', 'Bravo', sampleConfig());
    await store.save('bot-a', 'Alpha', sampleConfig());
    const listed = await store.listAll();
    expect(listed.map((entry) => entry.name)).toEqual(['Alpha', 'Bravo']);
  });

  it('updates config via transform', async () => {
    await store.save('bot-1', 'Alpha', sampleConfig('old'));
    const updated = await store.updateConfig('bot-1', (config) => ({
      ...config,
      commands: [{ ...config.commands[0]!, script: 'new' }],
    }));
    expect(updated.config.commands[0]?.script).toBe('new');
    const reloaded = await store.load('bot-1');
    expect(reloaded?.config.commands[0]?.script).toBe('new');
  });

  it('hydrates metadata from existing files on a fresh instance', async () => {
    await store.save('bot-1', 'Alpha', sampleConfig());
    const other = new BotStore(dir);
    const listed = await other.listAll();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe('bot-1');
  });

  it('returns null for missing bots', async () => {
    expect(await store.load('missing')).toBeNull();
  });

  it('never persists token or database password to disk', async () => {
    const sensitiveConfig = parseJsBotConfig({
      token: 'super-sensitive-discord-token',
      databaseConfig: {
        type: 'postgres',
        password: 'db-super-secret-password',
      },
      commands: [{ id: 'c1', name: 'ping', script: 'return 1;' }],
    });

    await store.save('bot-sec', 'SecureBot', sensitiveConfig);

    // Read the raw JSON file directly from disk
    const rawDisk = await readFile(path.join(dir, 'bot-sec.json'), 'utf8');
    expect(rawDisk).not.toContain('super-sensitive-discord-token');
    expect(rawDisk).not.toContain('db-super-secret-password');

    // The runtime in-memory instance still has the token for gateway login
    const loaded = await store.load('bot-sec');
    expect(loaded?.config.token).toBe('super-sensitive-discord-token');
    expect(loaded?.config.databaseConfig.type).toBe('postgres');
  });

  it('conserve les nouveaux champs (préfixes, variable de préfixe, mention, sans préfixe, fonctions, cron) à travers save puis load', async () => {
    const config = parseJsBotConfig({
      token: 'test-token',
      prefix: '!',
      prefixes: ['?', '!!'],
      prefixVariable: 'bc_prefix',
      prefixVariableScope: 'global',
      allowNoPrefixCommands: true,
      mentionAsPrefix: true,
      jsFunctions: [{ id: 'f1', name: 'add', params: ['a', 'b'], script: 'return a + b;' }],
      commands: [{ id: 'c1', name: 'ping', script: 'true;', triggerType: 'prefix', noPrefix: true }],
      scheduled: [
        { id: 's1', script: 'true;', cron: '0 9 * * 1-5', timezone: 'Europe/Paris', runOnStart: true, timeoutMs: 5000 },
        { id: 's2', script: 'true;', everyMinutes: 30 },
      ],
    });

    await store.save('bot-new', 'New', config);

    // Le fichier sur disque porte les clés (elles survivent au redémarrage du pod)...
    const onDisk = JSON.parse(await readFile(path.join(dir, 'bot-new.json'), 'utf8'));
    expect(onDisk.config.prefixes).toEqual(['?', '!!']);
    expect(onDisk.config.scheduled[0].cron).toBe('0 9 * * 1-5');

    // ... et une instance neuve (rien en mémoire) les relit à l'identique.
    const loaded = await new BotStore(dir).load('bot-new');
    expect(loaded?.config.prefixes).toEqual(['?', '!!']);
    expect(loaded?.config.prefixVariable).toBe('bc_prefix');
    expect(loaded?.config.prefixVariableScope).toBe('global');
    expect(loaded?.config.allowNoPrefixCommands).toBe(true);
    expect(loaded?.config.mentionAsPrefix).toBe(true);
    expect(loaded?.config.jsFunctions).toEqual([
      { id: 'f1', name: 'add', params: ['a', 'b'], script: 'return a + b;' },
    ]);
    expect(loaded?.config.commands[0]?.noPrefix).toBe(true);
    expect(loaded?.config.scheduled[0]).toMatchObject({
      cron: '0 9 * * 1-5',
      timezone: 'Europe/Paris',
      runOnStart: true,
      timeoutMs: 5000,
    });
    expect(loaded?.config.scheduled[0]?.everyMinutes).toBeUndefined();
    expect(loaded?.config.scheduled[1]?.everyMinutes).toBe(30);
  });

  it('relit un fichier ancien sans aucune des nouvelles clés', async () => {
    const legacy = {
      id: 'bot-old',
      name: 'Old',
      syncedAt: '2026-01-01T00:00:00.000Z',
      config: {
        token: '',
        intents: {},
        prefix: '!',
        autoRestart: true,
        databaseConfig: { type: 'none' },
        commands: [{ id: 'c1', type: 'command', name: 'ping', script: 'true;', triggerType: 'hybrid' }],
        events: [],
        scheduled: [{ id: 's1', type: 'scheduled', script: 'true;', everyMinutes: 60 }],
        inboundWebhooks: [],
        globalVariables: {},
        scopedVariableDefinitions: [],
        scriptTimeoutMs: 900000,
      },
    };
    await writeFile(path.join(dir, 'bot-old.json'), JSON.stringify(legacy), 'utf8');

    const loaded = await new BotStore(dir).load('bot-old');
    expect(loaded?.config.prefix).toBe('!');
    expect(loaded?.config.scheduled[0]?.everyMinutes).toBe(60);
    for (const key of ['prefixes', 'prefixVariable', 'prefixVariableScope', 'allowNoPrefixCommands', 'mentionAsPrefix', 'jsFunctions']) {
      expect(key in (loaded?.config ?? {})).toBe(false);
    }
    expect('noPrefix' in (loaded?.config.commands[0] ?? {})).toBe(false);
  });

  it('relit un fichier dont les nouveaux champs ont un mauvais type sans rejeter le bot', async () => {
    const stored = {
      id: 'bot-bad',
      name: 'Bad',
      syncedAt: '2026-01-01T00:00:00.000Z',
      config: {
        prefix: '?',
        prefixes: 'oups',
        mentionAsPrefix: 'oui',
        jsFunctions: 7,
        commands: [{ id: 'c1', name: 'ping', script: 'true;', noPrefix: 'oui' }],
        scheduled: [{ id: 's1', script: 'true;', everyMinutes: 'souvent', cron: 5 }],
      },
    };
    await writeFile(path.join(dir, 'bot-bad.json'), JSON.stringify(stored), 'utf8');

    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const loaded = await new BotStore(dir).load('bot-bad');
      expect(loaded?.config.prefix).toBe('?');
      expect(loaded?.config.commands[0]?.name).toBe('ping');
      expect(loaded?.config.prefixes).toBeUndefined();
      expect(loaded?.config.scheduled).toHaveLength(1);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

