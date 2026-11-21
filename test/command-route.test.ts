import { describe, expect, test } from 'bun:test';
import { MessageFlags } from 'discord.js';
import {
  applyDefaultVisibility,
  resolveCommandScript,
  resolveCommandVisibility,
  resolveInteractionRoute,
  mapMessageOptions,
  resolveMessageRoute,
} from '../src/discord/command-route.js';
import { parseInvocation, withoutLeadingArgs } from '../src/discord/message-invocation.js';

const data = {
  visibility: 'ephemeral',
  subcommandWorkflows: {
    list: { jsScriptContent: 'LIST', visibility: 'public' },
    'admin/ban': { jsScriptContent: '  ', executionMode: 'javascript' },
    other: { executionMode: 'bdfd_script', jsScriptContent: 'IGNORED' },
  },
};

describe('command route', () => {
  test('script de la route, sinon celui de la commande', () => {
    expect(resolveCommandScript('ROOT', data, 'list')).toBe('LIST');
    expect(resolveCommandScript('ROOT', data, 'admin/ban')).toBe('ROOT');
    expect(resolveCommandScript('ROOT', data, 'other')).toBe('ROOT');
    expect(resolveCommandScript('ROOT', data, null)).toBe('ROOT');
    expect(resolveCommandScript('ROOT', undefined, 'list')).toBe('ROOT');
  });

  test('visibilité : route, commande, puis publique', () => {
    expect(resolveCommandVisibility(data, 'list')).toBe('public');
    expect(resolveCommandVisibility(data, 'admin/ban')).toBe('ephemeral');
    expect(resolveCommandVisibility(undefined, null)).toBe('public');
    expect(resolveCommandVisibility({ response: { workflow: { visibility: 'ephemeral' } } }, null)).toBe('ephemeral');
  });

  test('route lue depuis les options', () => {
    const fake = (group: string | null, sub: string | null) =>
      ({ isChatInputCommand: () => true, options: { getSubcommandGroup: () => group, getSubcommand: () => sub } }) as never;
    expect(resolveInteractionRoute(fake('admin', 'ban'))).toBe('admin/ban');
    expect(resolveInteractionRoute(fake(null, 'list'))).toBe('list');
    expect(resolveInteractionRoute(fake(null, null))).toBeNull();
  });

  test('éphémère par défaut, sans écraser le choix du script', async () => {
    const calls: unknown[] = [];
    const interaction = {
      reply: async (o: unknown) => calls.push(o),
      deferReply: async (o: unknown) => calls.push(o),
    } as never;
    applyDefaultVisibility(interaction, 'ephemeral');
    await (interaction as { reply: (o: unknown) => Promise<unknown> }).reply('salut');
    await (interaction as { reply: (o: unknown) => Promise<unknown> }).reply({ content: 'x', ephemeral: false });
    await (interaction as { deferReply: (o?: unknown) => Promise<unknown> }).deferReply();
    expect(calls).toEqual([
      { content: 'salut', flags: MessageFlags.Ephemeral },
      { content: 'x', ephemeral: false },
      { flags: MessageFlags.Ephemeral },
    ]);
  });
});

describe("route d'un message préfixe", () => {
  const options = [
    { type: 'subCommand', name: 'ban' },
    { type: 2, name: 'admin', options: [{ type: 1, name: 'kick' }] },
    { type: 'string', name: 'reason' },
  ];

  test('sous-commande, groupe puis sous-commande, sinon rien', () => {
    expect(resolveMessageRoute(options, ['Ban', 'bob'])).toEqual({ route: 'ban', consumed: 1 });
    expect(resolveMessageRoute(options, ['admin', 'kick', 'x'])).toEqual({ route: 'admin/kick', consumed: 2 });
    expect(resolveMessageRoute(options, ['admin'])).toBeNull();
    expect(resolveMessageRoute(options, ['reason'])).toBeNull();
    expect(resolveMessageRoute(options, [])).toBeNull();
    expect(resolveMessageRoute(undefined, ['ban'])).toBeNull();
  });

  test('withoutLeadingArgs retire les mots de la sous-commande', () => {
    const invocation = parseInvocation('!cmd sub  a  b', { prefixes: ['!'] })!;
    const rest = withoutLeadingArgs(invocation, 1);
    expect(rest.name).toBe('cmd');
    expect(rest.args).toEqual(['a', 'b']);
    expect(rest.rawArgs).toBe('a  b');
    expect(withoutLeadingArgs(invocation, 9).args).toEqual([]);
  });
});

describe('options nommées après un préfixe', () => {
  const options = [
    {
      type: 'subCommand',
      name: 'ban',
      options: [
        { type: 'user', name: 'who' },
        { type: 'boolean', name: 'silent' },
        { type: 'string', name: 'reason' },
      ],
    },
    { type: 'string', name: 'top' },
  ];

  test('les mots remplissent les options de la route', () => {
    const result = mapMessageOptions(options, 'ban', ['<@!123>', 'oui', 'too', 'much'], '<@!123> oui too  much');
    expect(result).toEqual({ who: '123', 'who.id': '123', silent: 'true', reason: 'too  much' });
  });

  test('commande sans sous-commande, route inconnue', () => {
    expect(mapMessageOptions(options, null, ['hello'], 'hello')).toEqual({ top: 'hello' });
    expect(mapMessageOptions(options, 'nope', ['a'], 'a')).toEqual({});
  });
});
