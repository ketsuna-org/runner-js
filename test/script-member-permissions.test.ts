import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PermissionsBitField, type Client } from 'discord.js';

import { parseJsBotConfig, validateJsBotConfig } from '../src/config/js-bot-config.js';
import { HandlerRegistry } from '../src/discord/handler-registry.js';
import { ScriptExecutor } from '../src/scripts/script-executor.js';
import { normalizeScriptMember, withScriptMember } from '../src/scripts/script-member.js';
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
