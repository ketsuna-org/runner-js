import { afterEach, describe, expect, it, vi } from 'bun:test';
import { EventEmitter } from 'node:events';
import { Client, Collection, PermissionsBitField } from 'discord.js';
import { parseJsBotConfig, commandTriggerType } from '../src/config/js-bot-config.js';
import { clearLastKnownPortalIntents } from '../src/discord/application-intent-sync.js';
import { JsDiscordRunner } from '../src/worker/js-discord-runner.js';
import { HandlerRegistry } from '../src/discord/handler-registry.js';
import { slashCommandKeys, commandRegistrationsEqual } from '../src/discord/command-registerer.js';
import { ScriptExecutor } from '../src/scripts/script-executor.js';
import type { ScriptExecutionContext } from '../src/scripts/script-context.js';
import type { VariableDatabase } from '../src/runtime/variable-database.js';

function mixedConfig() {
  return parseJsBotConfig(JSON.parse(JSON.stringify({ prefix: '?', commands: [
    { id: 'prefix', name: 'prefix', triggerType: 'prefix', prefixName: 'p', aliases: ['alias'], script: 'prefix', data: { legacyModeEnabled: true } },
    { id: 'slash', name: 'slash', triggerType: 'slash', script: 'slash' },
    { id: 'hybrid', name: 'hybrid', triggerType: 'hybrid', script: 'hybrid' },
    { id: 'user', name: 'user', discordType: 'user', triggerType: 'slash', script: 'user' },
    { id: 'message', name: 'message', discordType: 'message', triggerType: 'slash', script: 'message' },
    { id: 'none', name: 'none', triggerType: 'none', script: 'none' },
    { id: 'disabled', name: 'disabled', triggerType: 'hybrid', enabled: false, script: 'disabled' },
    { id: 'old', name: 'old', aliases: ['oldalias'], script: 'old' },
    { id: 'oldprefix', name: 'oldprefix', legacyModeEnabled: true, legacyPrefixOverride: 'op', script: 'oldprefix' },
  ] })));
}

describe('mixed/restored command invocation types', () => {
  it('exposes only slash/hybrid/context commands (the Manager publishes them, this runner never does)', () => {
    expect(slashCommandKeys(mixedConfig().commands).map(key => [key.name, key.type])).toEqual([
      ['slash', 1], ['hybrid', 1], ['user', 2], ['message', 3], ['old', 1],
    ]);
    const original = mixedConfig().commands.find(command => command.id === 'hybrid')!;
    expect(commandRegistrationsEqual([original], [{ ...original, triggerType: 'prefix' }])).toBe(false);
  });

  it('dispatches each route with its proper context, preserves legacy aliases and remount/upsert cleanup', async () => {
    const client = new EventEmitter();
    const executions: string[] = [];
    const errors: string[] = [];
    const executor = { execute: async (script: string, context: ScriptExecutionContext) => {
      executions.push(`${script}:${context.interaction ? 'slash' : 'prefix'}`);
    } } as unknown as ScriptExecutor;
    const registry = new HandlerRegistry(client as unknown as Client, mixedConfig(), 'bot', executor,
      { getGlobalVariables: async () => ({}) } as VariableDatabase,
      (level, message) => { if (level === 'error') errors.push(message); });
    let sequence = 0;
    const dispatch = async (event: string, value: unknown) => Promise.all(client.listeners(event).map(listener => listener(value)));
    const message = (name: string) => dispatch('messageCreate', { author: { bot: false }, content: `?${name}`, guild: null, member: null, channel: null });
    const interaction = (name: string, context = false) => dispatch('interactionCreate', {
      id: `i-${++sequence}`, commandName: name, guild: null, member: null, channel: null,
      isAutocomplete: () => false, isChatInputCommand: () => !context, isContextMenuCommand: () => context,
    });
    registry.mount();
    for (const name of ['p', 'alias', 'prefix', 'slash', 'hybrid', 'user', 'message', 'none', 'disabled', 'old', 'oldalias', 'op']) await message(name);
    for (const name of ['prefix', 'alias', 'slash', 'hybrid', 'none', 'disabled', 'old', 'oldprefix']) await interaction(name);
    await interaction('user', true); await interaction('message', true);
    expect(executions).toEqual(['prefix:prefix', 'prefix:prefix', 'hybrid:prefix', 'old:prefix', 'old:prefix', 'oldprefix:prefix', 'slash:slash', 'hybrid:slash', 'old:slash', 'user:slash', 'message:slash']);
    expect(errors).toEqual([]);
    executions.length = 0;
    const prefix = mixedConfig().commands.find(command => command.id === 'prefix')!;
    registry.upsertCommand({ ...prefix, triggerType: 'slash', script: 'changed' });
    await message('p'); await message('alias'); await interaction('prefix');
    expect(executions).toEqual(['changed:slash']);
    registry.updateConfig(mixedConfig());
    executions.length = 0;
    await message('p'); await interaction('prefix');
    expect(executions).toEqual(['prefix:prefix']);
    registry.clear();
    expect(client.listenerCount('messageCreate')).toBe(0);
    expect(client.listenerCount('interactionCreate')).toBe(0);
  });

  it('honours historical flags before ambiguous compatibility fallback', () => {
    for (const [data, expected] of [
      [{ legacyModeEnabled: true }, 'prefix'],
      [{ legacyModeEnabled: false }, 'slash'],
      [{ legacyLocalOnly: true }, 'none'],
      [{ triggerType: 'hybrid', legacyModeEnabled: true }, 'hybrid'],
      [{}, 'hybrid'],
    ] as const) {
      expect(commandTriggerType(parseJsBotConfig({ commands: [{ id: 'a', name: 'a', script: '', data }] }).commands[0]!)).toBe(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// Routes de message : plusieurs préfixes, variable de préfixe, mention, sans préfixe
// ---------------------------------------------------------------------------

const BOT_ID = '900';

type Run = { script: string; message: any };
type Logged = { level: string; message: string };

function routeHarness(
  rawConfig: Record<string, unknown>,
  options: {
    botId?: string | null;
    messageContentAvailable?: boolean;
    scoped?: Record<string, unknown>;
    globals?: Record<string, unknown>;
    executor?: ScriptExecutor;
  } = {},
) {
  const clock = { now: 1_000_000 };
  const client = new EventEmitter() as EventEmitter & { user?: { id: string } | null };
  client.user = options.botId === null ? null : { id: options.botId ?? BOT_ID };
  const runs: Run[] = [];
  const logs: Logged[] = [];
  const reads = { prefix: 0 };
  const scoped = new Map<string, unknown>(Object.entries(options.scoped ?? {}));
  const store = {
    getGlobalVariables: async () => ({ ...(options.globals ?? {}) }),
    getScopedVariable: async (_bot: string, scope: string, contextId: string, key: string) => {
      if (key === 'prefix' || key === 'bc_prefix') reads.prefix += 1;
      return scoped.get(`${scope}:${contextId}:${key}`);
    },
    setScopedVariable: async (_bot: string, scope: string, contextId: string, key: string, value: unknown) => {
      scoped.set(`${scope}:${contextId}:${key}`, value);
    },
  } as unknown as VariableDatabase;
  const executor = options.executor ?? ({
    execute: async (script: string, context: ScriptExecutionContext) => {
      runs.push({ script, message: context.message });
    },
  } as unknown as ScriptExecutor);
  const registry = new HandlerRegistry(
    client as unknown as Client,
    parseJsBotConfig(rawConfig),
    'bot',
    executor,
    store,
    (level, message) => logs.push({ level, message }),
    undefined,
    { messageContentAvailable: options.messageContentAvailable ?? true, now: () => clock.now },
  );
  registry.mount();
  const message = (content: string, extra: Record<string, unknown> = {}) => ({
    author: { id: 'u1', bot: false },
    content,
    guild: null,
    guildId: 'g1',
    channelId: 'c1',
    member: { id: 'u1', permissions: new PermissionsBitField(PermissionsBitField.Flags.SendMessages) },
    channel: null,
    ...extra,
  });
  const send = (content: string, extra: Record<string, unknown> = {}) =>
    Promise.all(client.listeners('messageCreate').map((listener) => listener(message(content, extra))));
  return {
    client,
    registry,
    runs,
    logs,
    reads,
    scoped,
    clock,
    send,
    scripts: () => runs.map((run) => run.script),
    warnings: () => logs.filter((line) => line.level === 'warn').map((line) => line.message),
  };
}

const routeCommands = () => [
  { id: 'ping', name: 't_ping', triggerType: 'hybrid', aliases: ['t_pong'], script: 'ping' },
  { id: 'named', name: 't_named', triggerType: 'prefix', prefixName: 't_custom', script: 'named' },
  { id: 'slash', name: 't_slash', triggerType: 'slash', script: 'slash' },
  { id: 'local', name: 't_local', triggerType: 'none', script: 'local' },
];

describe('plusieurs préfixes', () => {
  it('chaque préfixe déclenche les mêmes commandes, et le plus long gagne', async () => {
    const t = routeHarness({ prefix: '!', prefixes: ['?', '!!'], commands: routeCommands() });
    for (const content of ['!t_ping', '?t_ping', '!!t_ping', '$t_ping', '!t_pong', '?t_custom', '!!t_named']) {
      await t.send(content);
    }
    expect(t.scripts()).toEqual(['ping', 'ping', 'ping', 'ping', 'named']);
  });

  it('prefix vide + prefixes : seuls les préfixes listés servent (pas de repli sur « ! »)', async () => {
    const t = routeHarness({ prefix: '', prefixes: ['?'], commands: routeCommands() });
    await t.send('?t_ping');
    await t.send('!t_ping');
    expect(t.scripts()).toEqual(['ping']);
  });

  it('un préfixe suivi d un espace reste accepté comme aujourd hui', async () => {
    const t = routeHarness({ prefix: '!', commands: routeCommands() });
    await t.send('! t_ping');
    expect(t.scripts()).toEqual(['ping']);
  });
});

describe('gardes communes aux routes de message', () => {
  const config = () => ({
    prefix: '!',
    mentionAsPrefix: true,
    allowNoPrefixCommands: true,
    commands: [{ id: 'ping', name: 't_ping', triggerType: 'hybrid', noPrefix: true, script: 'ping' }],
  });

  it.each([
    ['auteur bot', { author: { id: 'b1', bot: true } }],
    ['webhook', { webhookId: 'w1' }],
    ['message système', { system: true }],
  ])('%s : rien ne s exécute (préfixe, mention, sans préfixe)', async (_name, extra) => {
    const t = routeHarness(config());
    await t.send('!t_ping', extra);
    await t.send(`<@${BOT_ID}> t_ping`, extra);
    await t.send('t_ping', extra);
    expect(t.runs).toEqual([]);
  });

  it('contenu vide ou client.user absent : pas de plantage, le préfixe fonctionne encore', async () => {
    const t = routeHarness(config(), { botId: null });
    await t.send('');
    await t.send(`<@${BOT_ID}> t_ping`);
    await t.send('!t_ping');
    expect(t.scripts()).toEqual(['ping']);
  });

  it('seul messageCreate est écouté : un message modifié ne déclenche rien', () => {
    const t = routeHarness(config());
    expect(t.client.listenerCount('messageUpdate')).toBe(0);
    t.client.emit('messageUpdate', {}, { author: { bot: false }, content: '!t_ping' });
    expect(t.runs).toEqual([]);
  });
});

describe('variable de préfixe', () => {
  const config = (extra: Record<string, unknown> = {}) => ({
    prefix: '!',
    prefixVariable: 'prefix',
    commands: routeCommands(),
    ...extra,
  });

  it('la valeur du serveur REMPLACE la liste statique ; les autres serveurs et les DM gardent « ! »', async () => {
    const t = routeHarness(config(), { scoped: { 'guild:g1:prefix': '?' } });
    await t.send('?t_ping');
    await t.send('!t_ping');
    expect(t.scripts()).toEqual(['ping']);
    await t.send('!t_ping', { guildId: 'g2' });
    await t.send('?t_ping', { guildId: 'g2' });
    await t.send('!t_ping', { guildId: null });
    expect(t.scripts()).toEqual(['ping', 'ping', 'ping']);
  });

  it('valeur vide ou hostile : liste statique', async () => {
    for (const value of ['', '   ', 'x'.repeat(40)]) {
      const t = routeHarness(config(), { scoped: { 'guild:g1:prefix': value } });
      await t.send('!t_ping');
      expect(t.scripts()).toEqual(['ping']);
    }
  });

  it('portée global', async () => {
    const t = routeHarness(config({ prefixVariableScope: 'global' }), { globals: { prefix: '~' } });
    await t.send('~t_ping', { guildId: 'g7' });
    await t.send('!t_ping', { guildId: 'g7' });
    expect(t.scripts()).toEqual(['ping']);
  });

  it('lue une seule fois pour des messages rapprochés, relue après le TTL ou updateConfig', async () => {
    const t = routeHarness(config(), { scoped: { 'guild:g1:prefix': '?' } });
    await Promise.all([t.send('?t_ping'), t.send('?t_ping')]);
    await t.send('?t_ping');
    expect(t.reads.prefix).toBe(1);
    t.clock.now += 61_000;
    await t.send('?t_ping');
    expect(t.reads.prefix).toBe(2);
    t.registry.updateConfig(parseJsBotConfig(config()));
    await t.send('?t_ping');
    expect(t.reads.prefix).toBe(3);
  });

  it('notifyVariableWrite : une écriture de la variable faite hors script (API) vide le cache tout de suite', async () => {
    const t = routeHarness(config(), { scoped: { 'guild:g1:prefix': '?' } });
    await t.send('?t_ping');
    expect(t.scripts()).toEqual(['ping']);

    // Écriture directe dans le store (ce que fait POST /variables/scoped-values/set) : le cache garde l'ancien « ? ».
    t.scoped.set('guild:g1:prefix', '#');
    await t.send('#t_ping');
    expect(t.scripts()).toEqual(['ping']);

    // Une autre variable ne touche pas au cache ; la bonne clé (avec ou sans bc_) le vide.
    t.registry.notifyVariableWrite('color');
    await t.send('#t_ping');
    expect(t.scripts()).toEqual(['ping']);
    t.registry.notifyVariableWrite('bc_prefix');
    await t.send('?t_ping');
    await t.send('#t_ping');
    expect(t.scripts()).toEqual(['ping', 'ping']);
  });

  it('notifyVariableWrite : une lecture « absente » mémorisée avant l’écriture est elle aussi oubliée', async () => {
    const t = routeHarness(config());
    await t.send('?t_ping'); // variable absente : liste statique « ! », mémorisée
    expect(t.runs).toEqual([]);
    t.scoped.set('guild:g1:prefix', '?');
    t.registry.notifyVariableWrite('prefix');
    await t.send('?t_ping');
    await t.send('!t_ping');
    expect(t.scripts()).toEqual(['ping']);
  });

  it('notifyVariableWrite : sans variable de préfixe configurée, rien à invalider et aucune lecture', async () => {
    const t = routeHarness({ prefix: '!', commands: routeCommands() });
    t.registry.notifyVariableWrite('prefix');
    await t.send('!t_ping');
    expect(t.scripts()).toEqual(['ping']);
    expect(t.reads.prefix).toBe(0);
  });

  it('aucune lecture sans commande prefix|hybrid active', async () => {
    const t = routeHarness(
      config({ commands: [{ id: 's', name: 't_slash', triggerType: 'slash', script: 'slash' }] }),
      { scoped: { 'guild:g1:prefix': '?' } },
    );
    await t.send('?t_slash');
    expect(t.reads.prefix).toBe(0);
    expect(t.runs).toEqual([]);
  });

  it('écriture puis lecture immédiate : un script change « ? » en « # », le nouveau préfixe sert sans attendre le TTL', async () => {
    const executed: string[] = [];
    const real = new ScriptExecutor(5000);
    const executor = {
      execute: async (script: string, context: ScriptExecutionContext, ...rest: unknown[]) => {
        executed.push(`${script.includes('db.guild.set') ? 'set' : 'ping'}:${context.message?.content}`);
        await (real.execute as (...args: unknown[]) => Promise<unknown>)(script, context, ...rest);
      },
    } as unknown as ScriptExecutor;
    const t = routeHarness(
      config({
        commands: [
          { id: 'ping', name: 't_ping', triggerType: 'hybrid', script: 'return 1;' },
          { id: 'set', name: 't_setprefix', triggerType: 'hybrid', script: "await db.guild.set('prefix', '#');" },
        ],
      }),
      { scoped: { 'guild:g1:prefix': '?' }, executor },
    );
    await t.send('?t_setprefix');
    expect(t.scoped.get('guild:g1:prefix')).toBe('#');
    await t.send('?t_ping');
    await t.send('#t_ping');
    expect(executed).toEqual(['set:?t_setprefix', 'ping:#t_ping']);
  });
});

describe('la mention sert de préfixe (mentionAsPrefix)', () => {
  const config = (extra: Record<string, unknown> = {}) => ({
    prefix: '!',
    mentionAsPrefix: true,
    commands: routeCommands(),
    ...extra,
  });

  it('<@bot> nom, <@!bot> nom, alias et prefixName : mêmes mots déclencheurs que le préfixe', async () => {
    const t = routeHarness(config());
    await t.send(`<@${BOT_ID}> t_ping`);
    await t.send(`<@!${BOT_ID}> t_ping a b`);
    await t.send(`<@${BOT_ID}> t_pong`);
    await t.send(`<@${BOT_ID}> t_custom`);
    await t.send(`<@${BOT_ID}> T_PING`);
    expect(t.scripts()).toEqual(['ping', 'ping', 'ping', 'named', 'ping']);
  });

  it('seulement les commandes prefix|hybrid : slash pur et « none » sont ignorés', async () => {
    const t = routeHarness(config());
    await t.send(`<@${BOT_ID}> t_slash`);
    await t.send(`<@${BOT_ID}> t_local`);
    await t.send(`<@${BOT_ID}> t_named`);
    expect(t.runs).toEqual([]);
  });

  it('réglage du bot absent ou faux : aucune mention ne déclenche', async () => {
    for (const extra of [{ mentionAsPrefix: false }, { mentionAsPrefix: undefined }]) {
      const t = routeHarness(config(extra));
      await t.send(`<@${BOT_ID}> t_ping`);
      expect(t.runs).toEqual([]);
    }
  });

  it('marche sans préfixe configuré', async () => {
    const t = routeHarness({
      mentionAsPrefix: true,
      commands: [{ id: 'ping', name: 't_ping', script: 'ping' }],
    });
    await t.send('!t_ping');
    expect(t.runs).toEqual([]);
    await t.send(`<@${BOT_ID}> t_ping`);
    expect(t.scripts()).toEqual(['ping']);
  });

  it('ne déclenche pas : mention seule, rôle, @everyone, @here, hors tête, collée, autre utilisateur, reply-ping', async () => {
    const t = routeHarness(config());
    for (const content of [
      `<@${BOT_ID}>`,
      `<@${BOT_ID}>   `,
      `<@&${BOT_ID}> t_ping`,
      '@everyone t_ping',
      '@here t_ping',
      `salut <@${BOT_ID}> t_ping`,
      `<@${BOT_ID}>t_ping`,
      '<@901> t_ping',
    ]) {
      await t.send(content);
    }
    await t.send('t_ping', { mentions: { repliedUser: { id: BOT_ID }, everyone: true } });
    expect(t.runs).toEqual([]);
  });

  it('fonctionne en message privé (comme un préfixe) et dans un fil', async () => {
    const t = routeHarness(config());
    await t.send(`<@${BOT_ID}> t_ping`, { guildId: null, member: null });
    await t.send(`<@${BOT_ID}> t_ping`, { channel: { isThread: () => true } });
    expect(t.scripts()).toEqual(['ping', 'ping']);
  });

  it('le préfixe et la mention coexistent ; la variable de préfixe ne gêne pas la mention', async () => {
    const t = routeHarness(config({ prefixVariable: 'prefix' }), { scoped: { 'guild:g1:prefix': '?' } });
    await t.send(`<@${BOT_ID}> t_ping`);
    await t.send('?t_ping');
    await t.send('!t_ping');
    expect(t.scripts()).toEqual(['ping', 'ping']);
  });

  it('expose message.invocation aux scripts ; mentions sans le bot sur cette route seulement', async () => {
    const real = new ScriptExecutor(5000);
    const results: unknown[] = [];
    const executor = {
      execute: async (...args: Parameters<ScriptExecutor['execute']>) => {
        results.push(await real.execute(...args));
      },
    } as unknown as ScriptExecutor;
    const t = routeHarness(
      config({
        commands: [
          {
            id: 'who',
            name: 't_who',
            triggerType: 'hybrid',
            script:
              'return { invocation: message.invocation, content: message.content, mentioned: message.mentions.users.map(u => u.id), size: message.mentions.users.size };',
          },
        ],
      }),
      { executor },
    );
    const mentions = () => ({
      users: new Collection<string, { id: string }>([[BOT_ID, { id: BOT_ID }], ['5', { id: '5' }]]),
      members: null,
    });
    await t.send(`<@${BOT_ID}> T_who  <@5> now`, { mentions: mentions() });
    await t.send('!t_who <@5>', { mentions: mentions() });
    expect(results).toEqual([
      {
        invocation: { source: 'mention', prefix: null, name: 't_who', args: ['<@5>', 'now'], rawArgs: '<@5> now' },
        content: `<@${BOT_ID}> T_who  <@5> now`,
        mentioned: ['5'],
        size: 1,
      },
      {
        invocation: { source: 'prefix', prefix: '!', name: 't_who', args: ['<@5>'], rawArgs: '<@5>' },
        content: '!t_who <@5>',
        mentioned: [BOT_ID, '5'],
        size: 2,
      },
    ]);
  });
});

describe('permission par défaut du membre sur les routes mention et sans préfixe', () => {
  const config = () => ({
    prefix: '!',
    mentionAsPrefix: true,
    allowNoPrefixCommands: true,
    commands: [
      { id: 'ban', name: 't_ban', triggerType: 'hybrid', noPrefix: true, defaultMemberPermissions: '4', script: 'ban' },
      { id: 'admin', name: 't_admin', triggerType: 'hybrid', noPrefix: true, defaultMemberPermissions: '0', script: 'admin' },
      { id: 'open', name: 't_open', triggerType: 'hybrid', noPrefix: true, script: 'open' },
      { id: 'viadata', name: 't_data', triggerType: 'hybrid', noPrefix: true, data: { defaultMemberPermissions: '8' }, script: 'data' },
    ],
  });
  const member = (bits: bigint) => ({ id: 'u1', permissions: new PermissionsBitField(bits) });

  it('refus silencieux (journal debug) pour un membre sans la permission, sur les deux routes', async () => {
    const t = routeHarness(config());
    await t.send(`<@${BOT_ID}> t_ban u2`, { member: member(0n) });
    await t.send('t_ban u2', { member: member(0n) });
    await t.send(`<@${BOT_ID}> t_admin`, { member: member(PermissionsBitField.Flags.BanMembers) });
    await t.send('t_data', { member: member(PermissionsBitField.Flags.BanMembers) });
    expect(t.runs).toEqual([]);
    const refusals = t.logs.filter((line) => line.level === 'debug' && line.message.includes('refused'));
    expect(refusals.map((line) => line.message.match(/t_\w+/)?.[0])).toEqual(['t_ban', 't_ban', 't_admin', 't_data']);
    expect(t.warnings()).toEqual([]);
  });

  it('exécute pour un membre qui a la permission (administrateur implique tout) et pour une commande ouverte', async () => {
    const t = routeHarness(config());
    await t.send(`<@${BOT_ID}> t_ban u2`, { member: member(PermissionsBitField.Flags.BanMembers) });
    await t.send('t_ban u2', { member: member(PermissionsBitField.Flags.Administrator) });
    await t.send('t_admin', { member: member(PermissionsBitField.Flags.Administrator) });
    await t.send('t_data', { member: member(PermissionsBitField.Flags.Administrator) });
    await t.send('t_open', { member: member(0n) });
    expect(t.scripts()).toEqual(['ban', 'ban', 'admin', 'data', 'open']);
  });

  it('refuse sans membre résolvable (message privé) plutôt que d ouvrir la commande', async () => {
    const t = routeHarness(config());
    await t.send(`<@${BOT_ID}> t_ban u2`, { guildId: null, member: null });
    expect(t.runs).toEqual([]);
  });

  it('route préfixe : refus silencieux sans la permission, exécution avec, commande ouverte inchangée', async () => {
    const t = routeHarness(config());
    await t.send('!t_ban u2', { member: member(0n) });
    await t.send('!t_admin', { member: member(PermissionsBitField.Flags.BanMembers) });
    await t.send('!t_data', { member: member(PermissionsBitField.Flags.BanMembers) });
    await t.send('!t_ban u2', { guildId: null, member: null });
    expect(t.runs).toEqual([]);
    const refusals = t.logs.filter((line) => line.level === 'debug' && line.message.includes('refused'));
    expect(refusals.map((line) => line.message.match(/t_\w+/)?.[0])).toEqual(['t_ban', 't_admin', 't_data', 't_ban']);
    expect(refusals.every((line) => line.message.includes('prefix route'))).toBe(true);
    expect(t.warnings()).toEqual([]);

    await t.send('!t_ban u2', { member: member(PermissionsBitField.Flags.BanMembers) });
    await t.send('!t_admin', { member: member(PermissionsBitField.Flags.Administrator) });
    await t.send('!t_data', { member: member(PermissionsBitField.Flags.Administrator) });
    await t.send('!t_open', { member: member(0n) });
    expect(t.scripts()).toEqual(['ban', 'admin', 'data', 'open']);
  });
});

describe('commandes sans préfixe (double opt-in)', () => {
  const config = (extra: Record<string, unknown> = {}) => ({
    prefix: '!',
    allowNoPrefixCommands: true,
    commands: [
      { id: 'ping', name: 't_ping', triggerType: 'hybrid', noPrefix: true, aliases: ['t_pong'], script: 'ping' },
      { id: 'named', name: 't_named', triggerType: 'prefix', prefixName: 't_custom', data: { noPrefix: true }, script: 'named' },
      { id: 'plain', name: 't_plain', triggerType: 'hybrid', script: 'plain' },
      { id: 'slash', name: 't_slash', triggerType: 'slash', noPrefix: true, script: 'slash' },
      { id: 'off', name: 't_off', triggerType: 'hybrid', noPrefix: true, enabled: false, script: 'off' },
      { id: 'flip', name: 't_flip', triggerType: 'hybrid', noPrefix: true, data: { noPrefix: false }, script: 'flip' },
    ],
    ...extra,
  });

  it('s exécute si allowNoPrefixCommands ET noPrefix ET prefix|hybrid ET activée (nom, alias, prefixName)', async () => {
    const t = routeHarness(config());
    for (const content of ['t_ping', 't_pong', 'T_PING', 't_custom', 't_named', 't_plain', 't_slash', 't_off', 't_flip']) {
      await t.send(content, { author: { id: `u-${content}`, bot: false } });
    }
    expect(t.scripts()).toEqual(['ping', 'ping', 'ping', 'named']);
  });

  it('le message préfixé passe par la route préfixe, l autre par la route sans préfixe', async () => {
    const t = routeHarness(config());
    await t.send('!t_ping');
    await t.send('t_ping x');
    expect(t.scripts()).toEqual(['ping', 'ping']);
    expect(t.runs.map((run) => run.message?.invocation?.source)).toEqual(['prefix', 'noPrefix']);
  });

  it('réglage du bot absent ou faux : aucune exécution sans préfixe, avertissement unique', async () => {
    for (const extra of [{ allowNoPrefixCommands: false }, { allowNoPrefixCommands: undefined }]) {
      const t = routeHarness(config(extra));
      await t.send('t_ping');
      await t.send('t_ping');
      expect(t.runs).toEqual([]);
      const warnings = t.warnings().filter((line) => line.includes('allowNoPrefixCommands'));
      expect(warnings).toHaveLength(1);
    }
  });

  it('intent Message Content indisponible : aucune correspondance sans préfixe, UN seul avertissement, la mention marche', async () => {
    const t = routeHarness(config({ mentionAsPrefix: true }), { messageContentAvailable: false });
    await t.send('t_ping');
    await t.send('t_ping');
    t.registry.updateConfig(parseJsBotConfig(config({ mentionAsPrefix: true })));
    await t.send('t_ping');
    expect(t.runs).toEqual([]);
    const warnings = t.warnings().filter((line) => line.includes('Message Content'));
    expect(warnings).toHaveLength(1);
    await t.send(`<@${BOT_ID}> t_ping`);
    await t.send('!t_ping');
    expect(t.scripts()).toEqual(['ping', 'ping']);
  });

  it('serveur seulement : pas de sans-préfixe en message privé', async () => {
    const t = routeHarness(config());
    await t.send('t_ping', { guildId: null, member: null });
    expect(t.runs).toEqual([]);
  });

  it('collision de noms : un nom principal l emporte sur l alias d une autre commande, quel que soit l ordre', async () => {
    const a = { id: 'a', name: 't_a', triggerType: 'hybrid', noPrefix: true, aliases: ['t_dup'], script: 'a' };
    const b = { id: 'b', name: 't_dup', triggerType: 'hybrid', noPrefix: true, script: 'b' };
    for (const commands of [[a, b], [b, a]]) {
      const t = routeHarness({ prefix: '!', allowNoPrefixCommands: true, commands });
      await t.send('t_dup');
      expect(t.scripts()).toEqual(['b']);
    }
  });

  it('cooldown par (utilisateur, commande)', async () => {
    const { NO_PREFIX_USER_COOLDOWN_MS } = await import('../src/discord/message-invocation.js');
    const t = routeHarness(config());
    await t.send('t_ping');
    await t.send('t_ping');
    expect(t.scripts()).toEqual(['ping']);
    await t.send('t_ping', { author: { id: 'u2', bot: false } });
    await t.send('t_custom');
    expect(t.scripts()).toEqual(['ping', 'ping', 'named']);
    t.clock.now += NO_PREFIX_USER_COOLDOWN_MS;
    await t.send('t_ping');
    expect(t.scripts()).toEqual(['ping', 'ping', 'named', 'ping']);
  });

  it('plafond de déclenchements par fenêtre et par bot, puis reprise', async () => {
    const { NO_PREFIX_MAX_PER_WINDOW, NO_PREFIX_WINDOW_MS } = await import('../src/discord/message-invocation.js');
    const t = routeHarness(config());
    for (let i = 0; i < NO_PREFIX_MAX_PER_WINDOW + 10; i += 1) {
      await t.send('t_ping', { author: { id: `flood-${i}`, bot: false } });
    }
    expect(t.runs).toHaveLength(NO_PREFIX_MAX_PER_WINDOW);
    expect(t.warnings().filter((line) => line.includes('rate'))).toHaveLength(1);
    // La route préfixe n est jamais limitée par ce plafond.
    await t.send('!t_ping', { author: { id: 'flood-prefix', bot: false } });
    expect(t.runs).toHaveLength(NO_PREFIX_MAX_PER_WINDOW + 1);
    t.clock.now += NO_PREFIX_WINDOW_MS;
    await t.send('t_ping', { author: { id: 'after', bot: false } });
    expect(t.runs).toHaveLength(NO_PREFIX_MAX_PER_WINDOW + 2);
  });

  it('les tentatives refusées par la permission de la commande ne consomment pas le plafond du bot', async () => {
    const { NO_PREFIX_MAX_PER_WINDOW, NO_PREFIX_USER_COOLDOWN_MS } = await import('../src/discord/message-invocation.js');
    const adminOnly = Array.from({ length: 10 }, (_, index) => ({
      id: `adm${index}`,
      name: `t_adm${index}`,
      triggerType: 'hybrid',
      noPrefix: true,
      defaultMemberPermissions: '8',
      script: `adm${index}`,
    }));
    const t = routeHarness(
      config({ commands: [...adminOnly, { id: 'open', name: 't_open', triggerType: 'hybrid', noPrefix: true, script: 'open' }] }),
    );
    const admin = { id: 'admin', bot: false };
    const adminMember = { id: 'admin', permissions: new PermissionsBitField(PermissionsBitField.Flags.Administrator) };

    // Un membre sans droit essaie chacun des 10 noms réservés aux admins, 5 fois par fenêtre (le délai est par
    // couple utilisateur+commande) : 50 passages, aucun script exécuté pour lui.
    for (let round = 0; round < NO_PREFIX_MAX_PER_WINDOW / 10; round += 1) {
      if (round > 0) t.clock.now += NO_PREFIX_USER_COOLDOWN_MS;
      for (let index = 0; index < 10; index += 1) {
        await t.send(`t_adm${index}`);
      }
    }
    expect(t.runs).toEqual([]);

    // Les commandes des autres (admins comme utilisateurs ordinaires) fonctionnent toujours dans la même fenêtre.
    await t.send('t_adm0', { author: admin, member: adminMember });
    await t.send('t_open', { author: { id: 'someone', bot: false } });
    expect(t.scripts()).toEqual(['adm0', 'open']);
    expect(t.warnings().filter((line) => line.includes('rate'))).toEqual([]);
  });

  it('expose message.invocation (source noPrefix) aux scripts', async () => {
    const real = new ScriptExecutor(5000);
    const results: unknown[] = [];
    const executor = {
      execute: async (...args: Parameters<ScriptExecutor['execute']>) => {
        results.push(await real.execute(...args));
      },
    } as unknown as ScriptExecutor;
    const t = routeHarness(
      config({
        commands: [
          { id: 'w', name: 't_w', triggerType: 'hybrid', noPrefix: true, script: 'return message.invocation;' },
        ],
      }),
      { executor },
    );
    await t.send('t_w un deux');
    expect(results).toEqual([{ source: 'noPrefix', prefix: null, name: 't_w', args: ['un', 'deux'], rawArgs: 'un deux' }]);
  });

  it('deleteCommand, upsertCommand, updateConfig et clear purgent / reconstruisent la table sans préfixe', async () => {
    const t = routeHarness(config());
    await t.send('t_ping');
    expect(t.scripts()).toEqual(['ping']);
    t.registry.deleteCommand('ping', 't_ping');
    t.clock.now += 60_000;
    await t.send('t_ping');
    await t.send('t_pong');
    expect(t.scripts()).toEqual(['ping']);
    const ping = parseJsBotConfig(config()).commands.find((command) => command.id === 'ping')!;
    t.registry.upsertCommand({ ...ping, script: 'ping2' });
    await t.send('t_ping');
    expect(t.scripts()).toEqual(['ping', 'ping2']);
    t.registry.upsertCommand({ ...ping, noPrefix: false, script: 'ping3' });
    t.clock.now += 60_000;
    await t.send('t_ping');
    expect(t.scripts()).toEqual(['ping', 'ping2']);
    t.registry.updateConfig(parseJsBotConfig(config({ allowNoPrefixCommands: false })));
    t.clock.now += 60_000;
    await t.send('t_custom');
    expect(t.scripts()).toEqual(['ping', 'ping2']);
    t.registry.updateConfig(parseJsBotConfig(config()));
    await t.send('t_custom');
    expect(t.scripts()).toEqual(['ping', 'ping2', 'named']);
    t.registry.clear();
    expect(t.client.listenerCount('messageCreate')).toBe(0);
  });
});

describe('JsDiscordRunner : état réel de l intent Message Content transmis au registre', () => {
  const originalFetch = globalThis.fetch;
  const MESSAGE_CONTENT_LIMITED = 1 << 19;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    clearLastKnownPortalIntents();
  });

  async function startAndCollectLogs(flags: number): Promise<Logged[]> {
    vi.spyOn(Client.prototype, 'login').mockResolvedValue('token');
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ flags }), { status: 200 }),
    ) as unknown as typeof fetch;
    const logs: Logged[] = [];
    const runner = new JsDiscordRunner(
      'bot-wiring',
      parseJsBotConfig({
        token: 'token',
        prefix: '!',
        allowNoPrefixCommands: true,
        commands: [{ id: 'p', name: 't_ping', triggerType: 'hybrid', noPrefix: true, script: '' }],
      }),
      {} as VariableDatabase,
      (level, message) => logs.push({ level, message }),
    );
    await runner.start();
    await runner.stop();
    return logs;
  }

  it('intent approuvé au portail : le sans-préfixe est actif, aucun avertissement', async () => {
    const logs = await startAndCollectLogs(MESSAGE_CONTENT_LIMITED);
    expect(logs.filter((line) => line.message.includes('no-prefix'))).toEqual([]);
  });

  it('intent non approuvé : le sans-préfixe est désactivé avec UN avertissement', async () => {
    const logs = await startAndCollectLogs(0);
    const warnings = logs.filter((line) => line.level === 'warn' && line.message.includes('no-prefix'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain('Message Content');
  });
});
