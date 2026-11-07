import { describe, expect, test } from 'bun:test';
import { MessageFlags } from 'discord.js';
import {
  applyDefaultVisibility,
  resolveCommandScript,
  resolveCommandVisibility,
  resolveInteractionRoute,
} from '../src/discord/command-route.js';

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
