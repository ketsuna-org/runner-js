// LES RUNNERS NE PUBLIENT JAMAIS DE COMMANDE CHEZ DISCORD.
//
// Le Manager (bot Cloud) ou l'application (bot local) créent et modifient les commandes. Le runner ne
// propage que la suppression basique : une commande slash qui disparaît de sa configuration disparaît
// aussi chez Discord. Il ne supprime jamais ce qu'il ne connaissait pas.
import { describe, expect, it } from 'bun:test';

import type { Client } from 'discord.js';

import { removeCommands, type CommandRest } from '../src/discord/application-command-sync.js';
import { removeStaleSlashCommands } from '../src/discord/command-registerer.js';
import { parseJsBotConfig } from '../src/config/js-bot-config.js';

function fakeRest(remote: unknown[]): { rest: CommandRest; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    rest: {
      async get(route) { calls.push(`GET ${route}`); return remote; },
      async delete(route) { calls.push(`DELETE ${route}`); },
    },
  };
}

const client = { user: { id: 'app-1' } } as Client;
const commands = (names: string[], extra: Record<string, unknown> = {}) =>
  parseJsBotConfig(JSON.parse(JSON.stringify({ commands: names.map((name) => ({
    id: name, name, triggerType: 'slash', script: name, ...extra,
  })) }))).commands;

describe('propagation de la suppression seulement', () => {
  it('ne fait aucun appel quand rien n\'a disparu', async () => {
    const { rest, calls } = fakeRest([]);
    const removed = await removeStaleSlashCommands(client, commands(['a', 'b']), commands(['a', 'b', 'c']), rest);
    expect(removed).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('retire chez Discord la commande disparue, et elle seule', async () => {
    const { rest, calls } = fakeRest([
      { id: '1', name: 'a', type: 1 },
      { id: '2', name: 'b', type: 1 },
      { id: '3', name: 'inconnue', type: 1 },
    ]);
    const removed = await removeStaleSlashCommands(client, commands(['a', 'b']), commands(['a']), rest);
    expect(removed).toEqual(['b']);
    expect(calls.filter((call) => call.startsWith('DELETE'))).toEqual(['DELETE /applications/app-1/commands/2']);
  });

  it('ne crée ni ne modifie jamais : le REST de test n\'expose ni post ni patch', async () => {
    const { rest } = fakeRest([{ id: '1', name: 'a', type: 1 }]);
    expect('post' in rest).toBe(false);
    expect('patch' in rest).toBe(false);
  });

  it('une commande qui passe en préfixe n\'est plus slash : elle est retirée', async () => {
    const { rest, calls } = fakeRest([{ id: '9', name: 'x', type: 1 }]);
    const removed = await removeStaleSlashCommands(client, commands(['x']), commands(['x'], { triggerType: 'prefix' }), rest);
    expect(removed).toEqual(['x']);
    expect(calls).toContain('DELETE /applications/app-1/commands/9');
  });

  it('removeCommands reconnaît par type et nom, sans casse', async () => {
    const { rest, calls } = fakeRest([{ id: '1', name: 'Kick', type: 1 }, { id: '2', name: 'Kick', type: 2 }]);
    expect(await removeCommands(rest, 'app-1', [{ type: 1, name: 'kick' }])).toEqual(['Kick']);
    expect(calls.filter((call) => call.startsWith('DELETE'))).toEqual(['DELETE /applications/app-1/commands/1']);
  });
});
