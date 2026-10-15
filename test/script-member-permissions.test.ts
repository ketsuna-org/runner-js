import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PermissionsBitField, type Client } from 'discord.js';

import { parseJsBotConfig, validateJsBotConfig } from '../src/config/js-bot-config.js';
import { HandlerRegistry } from '../src/discord/handler-registry.js';
import { ScriptExecutor } from '../src/scripts/script-executor.js';
import {
  normalizeScriptMember,
  resolveScriptGuildChannel,
  SCRIPT_FETCH_FAILURE_TTL_MS,
  withScriptMember,
} from '../src/scripts/script-member.js';
import type { VariableDatabase } from '../src/runtime/variable-database.js';

const ADMIN = PermissionsBitField.Flags.Administrator;

describe('normalizeScriptMember', () => {
  it('turns a raw string bitfield into a PermissionsBitField (admin)', () => {
    const raw = { id: 'u1', roles: ['r1'], user: { id: 'u1' }, permissions: '8' };
    const member = normalizeScriptMember(raw) as unknown as {
      permissions: PermissionsBitField;
      roles: string[];
      user: { id: string };
    };
    expect(member.permissions).toBeInstanceOf(PermissionsBitField);
    expect(member.permissions.has(ADMIN)).toBe(true);
    expect(member.roles).toEqual(['r1']);
    expect(member.user.id).toBe('u1');
    // l'objet d'origine n'est pas muté
    expect(raw.permissions).toBe('8');
  });

  it('returns false for "0"', () => {
    const member = normalizeScriptMember({ permissions: '0' }) as unknown as {
      permissions: PermissionsBitField;
    };
    expect(member.permissions.has(ADMIN)).toBe(false);
  });

  it('leaves a member that already has a PermissionsBitField untouched', () => {
    const member = { id: 'u1', permissions: new PermissionsBitField(ADMIN) };
    expect(normalizeScriptMember(member)).toBe(member);
  });

  it('does not crash on missing, null or garbage permissions', () => {
    for (const permissions of [undefined, null, '', 'abc', {}]) {
      const member = normalizeScriptMember({ id: 'u1', permissions }) as unknown as {
        permissions: PermissionsBitField;
      };
      expect(member.permissions.has(ADMIN)).toBe(false);
    }
    expect(normalizeScriptMember(null)).toBeNull();
  });

  it('withScriptMember overrides member only, without mutating the target', () => {
    const interaction = { id: 'i1', member: { permissions: '8' }, reply: function () { return this.id; } };
    const member = normalizeScriptMember(interaction.member);
    const view = withScriptMember(interaction, member);
    expect(view.member).toBe(member);
    expect(view.id).toBe('i1');
    expect(view.reply()).toBe('i1');
    expect(interaction.member.permissions).toBe('8');
  });
});

describe('script /nuke-like integration', () => {
  async function runNuke(rawPermissions: unknown): Promise<unknown> {
    const client = new EventEmitter() as EventEmitter & {
      guilds: { fetch: () => Promise<never> };
    };
    client.guilds = { fetch: async () => { throw new Error('Missing Access'); } };
    const config = parseJsBotConfig({
      commands: [
        {
          id: 'nuke',
          name: 'nuke',
          script: `
            const { PermissionsBitField } = require('discord.js');
            return interaction.member.permissions.has(PermissionsBitField.Flags.Administrator);
          `,
        },
      ],
    });
    validateJsBotConfig(config);
    const base = new ScriptExecutor(5000);
    let result: unknown = 'not-run';
    const errors: string[] = [];
    const executor = {
      execute: async (...args: Parameters<ScriptExecutor['execute']>) => {
        result = await base.execute(...args);
      },
    } as unknown as ScriptExecutor;
    const variables = { getGlobalVariables: async () => ({}) } as VariableDatabase;
    const registry = new HandlerRegistry(
      client as unknown as Client,
      config,
      'bot-1',
      executor,
      variables,
      (level, message) => {
        if (level === 'error') errors.push(message);
      },
    );
    const interaction = {
      id: `i-${Math.random()}`,
      commandName: 'nuke',
      guildId: 'g1',
      guild: null,
      channel: null,
      user: { id: 'u1' },
      member: { user: { id: 'u1' }, roles: [], permissions: rawPermissions },
      isAutocomplete: () => false,
      isChatInputCommand: () => true,
      isContextMenuCommand: () => false,
      isRepliable: () => false,
    };
    registry.mount();
    await Promise.all(client.listeners('interactionCreate').map((l) => l(interaction)));
    registry.clear();
    base.dispose();
    expect(errors).toEqual([]);
    return result;
  }

  it('admin raw member passes the check', async () => {
    expect(await runNuke('8')).toBe(true);
  });

  it('non-admin raw member fails the check without throwing', async () => {
    expect(await runNuke('0')).toBe(false);
    expect(await runNuke(undefined)).toBe(false);
  });
});

describe('guild / channel hors cache (cache minimal)', () => {
  const MANAGE_CHANNELS = PermissionsBitField.Flags.ManageChannels;

  function makeFixtures(options: { guildFails?: boolean } = {}) {
    const calls = { guildFetch: 0, channelFetch: 0, fetchMe: 0 };
    const me = { id: 'bot', permissions: new PermissionsBitField(MANAGE_CHANNELS) };
    const guild = {
      id: 'g1',
      name: 'Serveur',
      members: {
        me: null as unknown,
        fetchMe: async () => {
          calls.fetchMe += 1;
          guild.members.me = me;
          return me;
        },
      },
    };
    const channel = {
      id: 'c1',
      permissionsFor: (who: unknown) =>
        who === me ? new PermissionsBitField(MANAGE_CHANNELS) : null,
    };
    const guildCache = new Map<string, unknown>();
    const channelCache = new Map<string, unknown>();
    const client = new EventEmitter() as EventEmitter & Record<string, unknown>;
    client.guilds = {
      cache: guildCache,
      fetch: async (id: string) => {
        calls.guildFetch += 1;
        if (options.guildFails) throw new Error('Missing Access');
        guildCache.set(id, guild);
        return guild;
      },
    };
    client.channels = {
      cache: channelCache,
      fetch: async (id: string) => {
        calls.channelFetch += 1;
        if (options.guildFails) throw new Error('Unknown Channel');
        channelCache.set(id, channel);
        return channel;
      },
    };
    return { client, calls, guild, channel, guildCache, channelCache, me };
  }

  async function runScriptFor(
    client: EventEmitter,
    script: string,
    interaction: Record<string, unknown>,
  ): Promise<{ result: unknown; errors: string[] }> {
    const config = parseJsBotConfig({ commands: [{ id: 'nuke', name: 'nuke', script }] });
    validateJsBotConfig(config);
    const base = new ScriptExecutor(5000);
    let result: unknown = 'not-run';
    const errors: string[] = [];
    const executor = {
      execute: async (...args: Parameters<ScriptExecutor['execute']>) => {
        result = await base.execute(...args);
      },
    } as unknown as ScriptExecutor;
    const registry = new HandlerRegistry(
      client as unknown as Client,
      config,
      'bot-1',
      executor,
      { getGlobalVariables: async () => ({}) } as VariableDatabase,
      (level, message) => {
        if (level === 'error') errors.push(message);
      },
    );
    registry.mount();
    await Promise.all(client.listeners('interactionCreate').map((l) => l(interaction)));
    registry.clear();
    base.dispose();
    return { result, errors };
  }

  function baseInteraction(over: Record<string, unknown> = {}) {
    return {
      id: `i-${Math.random()}`,
      commandName: 'nuke',
      guildId: 'g1',
      channelId: 'c1',
      guild: null,
      channel: null,
      user: { id: 'u1' },
      member: { user: { id: 'u1' }, roles: [], permissions: '8' },
      isAutocomplete: () => false,
      isChatInputCommand: () => true,
      isContextMenuCommand: () => false,
      isRepliable: () => false,
      ...over,
    };
  }

  const NUKE = `
    const { PermissionsBitField } = require('discord.js');
    const F = PermissionsBitField.Flags;
    return {
      admin: interaction.member.permissions.has(F.Administrator),
      botPerm: interaction.guild.members.me.permissions.has(F.ManageChannels),
      chanPerm: interaction.channel.permissionsFor(interaction.guild.members.me).has(F.ManageChannels),
      name: interaction.guild.name,
    };
  `;

  it('/nuke complet avec interaction hors cache', async () => {
    const { client, calls } = makeFixtures();
    const { result, errors } = await runScriptFor(client, NUKE, baseInteraction());
    expect(errors).toEqual([]);
    expect(result).toEqual({ admin: true, botPerm: true, chanPerm: true, name: 'Serveur' });
    expect(calls).toEqual({ guildFetch: 1, channelFetch: 1, fetchMe: 1 });
  });

  it('aucun fetch REST quand guilde, salon et membre du bot sont en cache', async () => {
    const f = makeFixtures();
    f.guild.members.me = f.me;
    f.guildCache.set('g1', f.guild);
    f.channelCache.set('c1', f.channel);
    const { result, errors } = await runScriptFor(
      f.client,
      NUKE,
      baseInteraction({ get guild() { return f.guildCache.get('g1') ?? null; } }),
    );
    expect(errors).toEqual([]);
    expect((result as { name: string }).name).toBe('Serveur');
    expect(f.calls).toEqual({ guildFetch: 0, channelFetch: 0, fetchMe: 0 });
  });

  it('un seul fetch par type sur des interactions concurrentes, et état borné', async () => {
    const f = makeFixtures();
    await Promise.all(
      Array.from({ length: 10 }, () => runScriptFor(f.client, NUKE, baseInteraction())),
    );
    expect(f.calls.guildFetch).toBe(1);
    expect(f.calls.channelFetch).toBe(1);
    expect(f.calls.fetchMe).toBe(1);
    // le cache du client ne contient que ce qu'il avait déjà le droit de contenir
    expect(f.guildCache.size).toBe(1);
    expect(f.channelCache.size).toBe(1);
  });

  it("l'état interne reste borné face à de nombreuses guildes en échec", async () => {
    const f = makeFixtures({ guildFails: true });
    for (let i = 0; i < 500; i += 1) {
      const out = await resolveScriptGuildChannel(f.client, {
        guild: null,
        channel: null,
        guildId: `g-${i}`,
        channelId: `c-${i}`,
      });
      expect(out).toEqual({ guild: null, channel: null });
    }
    // échecs mémorisés (TTL) : un second passage ne refait aucun fetch
    const before = f.calls.guildFetch;
    await resolveScriptGuildChannel(f.client, {
      guild: null, channel: null, guildId: 'g-499', channelId: 'c-499',
    });
    expect(f.calls.guildFetch).toBe(before);
    // après expiration du TTL on retente
    await resolveScriptGuildChannel(
      f.client,
      { guild: null, channel: null, guildId: 'g-499', channelId: 'c-499' },
      () => Date.now() + SCRIPT_FETCH_FAILURE_TTL_MS + 1,
    );
    expect(f.calls.guildFetch).toBe(before + 1);
  });

  it('DM : guild reste null, aucun fetch de guilde', async () => {
    const f = makeFixtures();
    const { result, errors } = await runScriptFor(
      f.client,
      'return { guild: interaction.guild, chan: interaction.channel && interaction.channel.id };',
      baseInteraction({ guildId: null, member: null }),
    );
    expect(errors).toEqual([]);
    expect(result).toEqual({ guild: null, chan: 'c1' });
    expect(f.calls.guildFetch).toBe(0);
  });

  it('échec de fetch : null sans exception', async () => {
    const f = makeFixtures({ guildFails: true });
    const { result, errors } = await runScriptFor(
      f.client,
      'return { guild: interaction.guild, channel: interaction.channel, perm: interaction.member.permissions.has(8n) };',
      baseInteraction(),
    );
    expect(errors).toEqual([]);
    expect(result).toEqual({ guild: null, channel: null, perm: true });
  });
});
