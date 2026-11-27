import { describe, expect, it } from 'bun:test';
import conformance from './fixtures/module-query-conformance.json';
import { createBcModules } from '../src/scripts/script-bc-modules.js';

function make(opts: { manage?: boolean; userId?: string | null; guildId?: string | null; locale?: string } = {}) {
  const written = new Map<string, unknown>();
  const store = new Map<string, unknown>(Object.entries(conformance.variables));
  const context = {
    config: { modules: conformance.doc.modules, translations: conformance.doc.translations, commands: conformance.commands },
    interaction:
      opts.userId === null
        ? undefined
        : {
            locale: opts.locale ?? '',
            guildId: opts.guildId === undefined ? '10' : opts.guildId,
            user: { id: opts.userId ?? '22' },
            memberPermissions: { has: (p: string) => p === 'ManageGuild' && opts.manage !== false },
          },
    db: {
      guild: {
        get: async (k: string, id?: string) => store.get(k) ?? (id ? undefined : undefined),
        set: async (k: string, v: unknown, id?: string) => {
          store.set(k, v);
          written.set(`${id}:${k}`, v);
        },
      },
    },
  };
  return { ...createBcModules(context as never), written };
}

describe('bc.module / bc.command', () => {
  it('liste les modules', () => {
    const { module } = make();
    expect(module.list()).toEqual(['tickets', 'welcome']);
    expect(module.list({ filter: 'enabled', format: 'name' })).toEqual(['Billets']);
    expect(module.count('configurable')).toBe(1);
  });

  it('type les champs', () => {
    const { module, command } = make({ locale: 'fr' });
    expect(module.info('tickets', 'installed')).toBe(true);
    expect(module.info('ghost', 'installed')).toBe(false);
    expect(module.info('tickets', 'settings')).toEqual(['category', 'max-open', 'style', 'ping-staff']);
    expect(module.feature('tickets', 'transcripts')).toBe(false);
    expect(command.list({ filter: 'custom' })).toEqual(['hello']);
    expect(command.info('ticket', 'description')).toBe('Ouvrir un billet');
    expect(command.info('ghost', 'exists')).toBe(false);
  });

  it('lit un réglage du serveur', async () => {
    const { module } = make();
    expect(await module.setting('tickets', 'max-open')).toBe(3);
    expect(await module.setting('tickets', 'ping-staff')).toBe(false);
    expect(await module.setting('tickets', 'category')).toBe('123456789012345678');
    expect(await module.setting('tickets', 'max-open', 'max')).toBe(10);
    await expect(module.setting('tickets', 'secret')).rejects.toThrow('has no setting');
  });

  it('écrit un réglage avec « Gérer le serveur »', async () => {
    const { module, written } = make();
    await module.setSetting('tickets', 'max-open', 7);
    expect(written.get('10:mod_tickets_max_open')).toBe('7');
    await expect(module.setSetting('tickets', 'max-open', 99)).rejects.toThrow('must be at most 10');
  });

  it('refuse sans permission, hors serveur et hors interaction', async () => {
    await expect(make({ manage: false }).module.setSetting('tickets', 'max-open', 7)).rejects.toThrow('Manage Server');
    await expect(make({ guildId: null }).module.setSetting('tickets', 'max-open', 7)).rejects.toThrow('need a server');
    await expect(make({ userId: null }).module.setSetting('tickets', 'max-open', 7)).rejects.toThrow('command or a button');
  });
});
