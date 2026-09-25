// LE REGISTRE DES COMMANDES NE DOIT PLUS RENUMEROTER.
//
// L'ancien enregistrement faisait un écrasement GLOBAL
// (`PUT /applications/{id}/commands`) sans aucun identifiant dans le corps :
// Discord remplaçait donc tout et attribuait de NOUVEAUX identifiants à chaque
// enregistrement — à chaque démarrage du bot, à chaque `upsertCommand`, à chaque
// changement d'intents. Conséquence mesurée : l'app et le manager gardent les
// identifiants qu'ils connaissent, tous devenaient faux d'un coup, l'app ne
// pouvait plus modifier ni supprimer ses propres commandes (10063) et une
// comparaison par identifiant concluait que tout était orphelin.
//
// Le remplacement est un DIFFÉRENTIEL par NOM et TYPE, sur les routes
// unitaires : identifiant conservé et PATCH de ce qui a changé, création des
// manquantes, suppression des surnuméraires. Deux propriétés en découlent, et
// chacune a son cas de test :
//
//   - une configuration identique ne coûte AUCUNE requête (avant : tout était
//     réécrit à chaque démarrage) ;
//   - un champ que nous n'envoyons pas n'est PAS touché côté Discord (PATCH
//     partiel) : une commande réservée aux administrateurs ne redevient pas
//     publique au démarrage suivant.
import { describe, expect, it } from 'bun:test';

import type { Client } from 'discord.js';

import {
  applyCommandDiff,
  commandMatches,
  type CommandRest,
  type DesiredApplicationCommand,
} from '../src/discord/application-command-sync.js';
import { registerSlashCommands, toDiscordCommand } from '../src/discord/command-registerer.js';

const APP_ID = 'app-1';

interface RecordedCall {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  route: string;
  body?: unknown;
}

/** Faux Discord : rend la liste fournie, enregistre chaque appel. */
function fakeRest(remote: unknown[]): { rest: CommandRest; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const rest: CommandRest = {
    async get(route) {
      calls.push({ method: 'GET', route });
      return remote;
    },
    async post(route, options) {
      calls.push({ method: 'POST', route, body: options.body });
      return { id: 'new-id' };
    },
    async patch(route, options) {
      calls.push({ method: 'PATCH', route, body: options.body });
      return { id: 'patched' };
    },
    async delete(route) {
      calls.push({ method: 'DELETE', route });
      return undefined;
    },
  };
  return { rest, calls };
}

const PING: DesiredApplicationCommand = {
  type: 1,
  name: 'ping',
  description: 'Répond pong',
  options: [],
};

/** Ce que Discord RENVOIE réellement pour une commande : bien plus que l'envoyé. */
function remoteCommand(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '111111111111111111',
    application_id: APP_ID,
    version: '111111111111111111',
    type: 1,
    name: 'ping',
    description: 'Répond pong',
    options: [],
    name_localizations: null,
    description_localizations: null,
    nsfw: false,
    integration_types: [0],
    contexts: [0, 1, 2],
    default_member_permissions: null,
    ...overrides,
  };
}

describe('applyCommandDiff', () => {
  it('laisse intacte une commande déjà conforme, identifiant compris', async () => {
    const { rest, calls } = fakeRest([remoteCommand()]);

    const report = await applyCommandDiff(rest, APP_ID, [PING]);

    expect(report.unchanged).toEqual(['ping']);
    expect(report.created).toEqual([]);
    expect(report.updated).toEqual([]);
    expect(report.removed).toEqual([]);
    expect(calls.map((call) => call.method)).toEqual(['GET']);
  });

  it('modifie une commande sur SON identifiant, en PATCH (pas de recréation)', async () => {
    const { rest, calls } = fakeRest([
      remoteCommand({ description: 'Ancienne description' }),
    ]);

    const report = await applyCommandDiff(rest, APP_ID, [PING]);

    expect(report.updated).toEqual(['ping']);
    const patch = calls.find((call) => call.method === 'PATCH');
    expect(patch?.route).toContain('111111111111111111');
    expect((patch?.body as { description?: string })?.description).toBe('Répond pong');
    // La preuve qui compte : aucun POST, donc AUCUN nouvel identifiant.
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('crée les manquantes et supprime les surnuméraires', async () => {
    const { rest, calls } = fakeRest([
      remoteCommand({ id: '222222222222222222', name: 'orpheline', description: 'orpheline' }),
    ]);

    const report = await applyCommandDiff(rest, APP_ID, [PING]);

    expect(report.created).toEqual(['ping']);
    expect(report.removed).toEqual(['orpheline']);
    const deleted = calls.find((call) => call.method === 'DELETE');
    expect(deleted?.route).toContain('222222222222222222');
  });

  it('ne réécrit pas une commande à cause des champs ajoutés par Discord', async () => {
    // Les champs que Discord ajoute (locales, nsfw, contexts, permissions par
    // défaut, version...) ne doivent pas déclencher une réécriture à chaque
    // démarrage : sinon le diff n'économise rien et touche des commandes saines.
    const { rest, calls } = fakeRest([remoteCommand()]);

    await applyCommandDiff(rest, APP_ID, [PING]);

    expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);
  });

  it('ne touche PAS à une permission non déclarée localement', async () => {
    // Le cas qui protège vraiment : la commande est réservée aux
    // administrateurs sur Discord, la configuration locale ne dit rien des
    // permissions. Elle doit le rester — c'est le PATCH (et non l'écrasement
    // global) qui garantit qu'un champ absent du corps n'est pas réinitialisé.
    const { rest, calls } = fakeRest([
      remoteCommand({ default_member_permissions: '8' }),
    ]);

    const report = await applyCommandDiff(rest, APP_ID, [PING]);

    expect(report.unchanged).toEqual(['ping']);
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);
  });

  it('envoie la permission quand la configuration la déclare', async () => {
    const { rest, calls } = fakeRest([remoteCommand({ default_member_permissions: null })]);

    const command = toDiscordCommand({
      id: 'cmd-1',
      type: 'command',
      name: 'ping',
      description: 'Répond pong',
      discordType: 'chatInput',
      options: [],
      aliases: [],
      enabled: true,
      script: '',
      defaultMemberPermissions: '8',
    } as never);

    await applyCommandDiff(rest, APP_ID, [command]);

    const patch = calls.find((call) => call.method === 'PATCH');
    expect((patch?.body as { default_member_permissions?: string })?.default_member_permissions).toBe(
      '8',
    );
  });

  it('distingue les commandes de contexte par leur type', () => {
    // Un menu contextuel "user" et une commande "chatInput" peuvent porter le
    // même nom sur Discord : les confondre écraserait l'un avec l'autre.
    const chatInput = { type: 1, name: 'ping' };
    const userMenu = { type: 2, name: 'ping' };

    expect(commandMatches(remoteCommand({ type: 2, description: undefined, options: undefined }), userMenu)).toBe(
      true,
    );
    expect(commandMatches(remoteCommand(), chatInput)).toBe(true);
  });
});

describe('registerSlashCommands', () => {
  it('ignore les commandes désactivées et rend le bilan', async () => {
    const { rest, calls } = fakeRest([]);
    const client = { user: { id: APP_ID } } as unknown as Client;

    const report = await registerSlashCommands(
      client,
      'token',
      [
        {
          id: 'cmd-1',
          type: 'command',
          name: 'ping',
          description: 'Répond pong',
          discordType: 'chatInput',
          options: [],
          aliases: [],
          enabled: true,
          script: '',
        },
        {
          id: 'cmd-2',
          type: 'command',
          name: 'desactivee',
          description: 'ne doit pas partir',
          discordType: 'chatInput',
          options: [],
          aliases: [],
          enabled: false,
          script: '',
        },
      ] as never,
      rest,
    );

    expect(report.created).toEqual(['ping']);
    expect(calls.filter((call) => call.method === 'POST').length).toBe(1);
    expect(
      calls.some((call) => JSON.stringify(call.body ?? {}).includes('desactivee')),
    ).toBe(false);
  });

  it('refuse de parler à Discord sans client prêt', async () => {
    const { rest } = fakeRest([]);
    const client = {} as unknown as Client;

    await expect(
      registerSlashCommands(client, 'token', [] as never, rest),
    ).rejects.toThrow(/not ready/);
  });
});
