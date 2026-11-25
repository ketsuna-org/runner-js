import { describe, expect, test } from 'bun:test';
import { tryHandlePanel } from '../src/modules/panel/module-panel-runtime.js';

const config = {
  moduleConfigCommand: { name: 'config' },
  modules: {
    levels: {
      name: { en: 'Levels' },
      settings: [{ key: 'xp-min', type: 'number', scope: 'guild', default: 15, i18n: { en: { label: 'XP min' } } }],
    },
  },
};

function fake(kind: 'command' | 'button' | 'modal', extra: Record<string, unknown> = {}) {
  const calls: { method: string; payload: any }[] = [];
  const base: any = {
    guildId: '1',
    locale: 'fr',
    memberPermissions: { has: () => true },
    isChatInputCommand: () => kind === 'command',
    isMessageComponent: () => kind === 'button',
    isModalSubmit: () => kind === 'modal',
    isFromMessage: () => kind !== 'command',
    reply: async (p: any) => calls.push({ method: 'reply', payload: p }),
    update: async (p: any) => calls.push({ method: 'update', payload: p }),
    showModal: async (p: any) => calls.push({ method: 'showModal', payload: p }),
    ...extra,
  };
  return { interaction: base, calls };
}

function ctx(writes: string[][] = []) {
  return {
    botId: 'b',
    config,
    store: {
      getScopedVariable: async () => undefined,
      setScopedVariable: async (_b: string, _s: string, _c: string, k: string, v: unknown) => {
        writes.push([k, String(v)]);
      },
    },
    log: () => {},
  };
}

describe('panneau de config : branchement discord.js', () => {
  test('autre commande ou autre custom_id : pas pris', async () => {
    const a = fake('command', { commandName: 'ping', options: { getString: () => null } });
    expect(await tryHandlePanel(a.interaction, ctx())).toBe(false);
    const b = fake('button', { customId: 'other:1' });
    expect(await tryHandlePanel(b.interaction, ctx())).toBe(false);
  });

  test('la commande ouvre le panneau en message éphémère Components V2', async () => {
    const a = fake('command', { commandName: 'config', options: { getString: () => null } });
    expect(await tryHandlePanel(a.interaction, ctx())).toBe(true);
    expect(a.calls[0].method).toBe('reply');
    expect(a.calls[0].payload.flags).toBe(32768 | 64);
  });

  test('sans « Gérer le serveur » : refus court, rien n\'est écrit', async () => {
    const writes: string[][] = [];
    const a = fake('button', { customId: 'mcfg:toggle:levels:xp-min', memberPermissions: { has: () => false } });
    expect(await tryHandlePanel(a.interaction, ctx(writes))).toBe(true);
    expect(writes).toEqual([]);
    expect(JSON.stringify(a.calls[0].payload)).toContain('Gérer le serveur');
  });

  test('soumission de modale : valeur écrite puis panneau mis à jour', async () => {
    const writes: string[][] = [];
    const fields = new Map([['value', { value: '50' }]]);
    const a = fake('modal', { customId: 'mcfg:save:levels:xp-min', fields: { fields } });
    expect(await tryHandlePanel(a.interaction, ctx(writes))).toBe(true);
    expect(writes).toEqual([['mod_levels_xp_min', '50']]);
    expect(a.calls[0].method).toBe('update');
  });

  test('un clic « Modifier » ouvre la modale', async () => {
    const a = fake('button', { customId: 'mcfg:edit:levels:xp-min' });
    expect(await tryHandlePanel(a.interaction, ctx())).toBe(true);
    expect(a.calls[0].method).toBe('showModal');
  });
});

describe('langue du panneau', () => {
  test('personne, puis langue par défaut du bot, puis anglais', async () => {
    const { panelLanguageFor } = await import('../src/modules/panel/module-panel.js');
    expect(panelLanguageFor('de', 'fr')).toBe('de');
    expect(panelLanguageFor('sv', 'fr-FR')).toBe('fr');
    expect(panelLanguageFor('sv', 'xx')).toBe('en');
    expect(panelLanguageFor(null, null)).toBe('en');
  });
});
