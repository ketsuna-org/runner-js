import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { handlePanelInteraction } from '../src/modules/panel/module-panel.js';
import {
  automationCreateBody,
  handleAutomationInteraction,
  PanelAutomationError,
  renderAutomationConfirm,
  renderAutomationModal,
  renderAutomations,
  renderAutomationsClosed,
  type PanelAutomationApi,
} from '../src/modules/panel/module-panel-automations.js';

// Même fichier que celui rejoué par le moteur Dart (bot-creator, packages/shared/test/modules/panel).
const data = JSON.parse(
  readFileSync(new URL('./fixtures/module-panel-automations-conformance.json', import.meta.url), 'utf8'),
);
const panel = JSON.parse(readFileSync(new URL('./fixtures/module-panel-conformance.json', import.meta.url), 'utf8'));

async function run(fn: string, input: any): Promise<unknown> {
  const lang = String(input.language ?? 'en');
  switch (fn) {
    case 'list':
      return renderAutomations(input);
    case 'closed':
      return renderAutomationsClosed(lang, input.paid === true);
    case 'confirm':
      return renderAutomationConfirm(input.automation, lang);
    case 'modal':
      return renderAutomationModal(lang);
    case 'body':
      return automationCreateBody(input.modal, String(input.guildId), String(input.actorId));
    case 'home': {
      const r = await handlePanelInteraction({
        doc: panel.doc,
        customId: input.customId,
        read: async (v) => panel.variables[v] ?? null,
        language: lang,
        automations: true,
      });
      return r.message ?? null;
    }
  }
  throw new Error(fn);
}

describe("écran « Alertes » : conformité avec le moteur Dart", () => {
  for (const c of data.cases) {
    test(c.name, async () => {
      expect(JSON.parse(JSON.stringify(await run(c.fn, c.input)))).toEqual(JSON.parse(JSON.stringify(c.expect)));
    });
  }
});

describe("écran « Alertes » : interactions", () => {
  const view = { enabled: true, paid: true, limits: { max_active_per_guild: 3, max_total_per_bot: 50 }, active: 0, total_in_bot: 0 };
  const calls: string[] = [];
  const api = (overrides: Partial<PanelAutomationApi> = {}): PanelAutomationApi => ({
    list: async () => ({ view, automations: [{ id: 'a1', name: 'Blog', source_kind: 'rss', channel_id: '1', status: 'paused' }] }),
    create: async (b) => void calls.push(`create:${b.name}`),
    setStatus: async (_g, id, enable) => void calls.push(`${enable ? 'on' : 'off'}:${id}`),
    remove: async (_g, id) => void calls.push(`del:${id}`),
    ...overrides,
  });
  const base = { guildId: '9', actorId: '1', language: 'en' };

  test('créer, démarrer et supprimer appellent le Manager', async () => {
    await handleAutomationInteraction({
      ...base,
      api: api(),
      step: 'save',
      arg: '',
      modal: { name: 'Blog', kind: 'rss', source: 'https://e.org/f', channel: '3', action: 'workflow' },
    });
    await handleAutomationInteraction({ ...base, api: api(), step: 'on', arg: 'a1' });
    await handleAutomationInteraction({ ...base, api: api(), step: 'delyes', arg: 'a1' });
    expect(calls).toEqual(['create:Blog', 'on:a1', 'del:a1']);
  });

  test('la modale incomplète ne crée rien', async () => {
    const r = await handleAutomationInteraction({ ...base, api: api(), step: 'save', arg: '', modal: { name: 'x' } });
    expect(JSON.stringify(r.message)).toContain('Some fields are not valid');
  });

  test('un refus du Manager devient un message clair', async () => {
    const r = await handleAutomationInteraction({
      ...base,
      api: api({
        create: async () => {
          throw new PanelAutomationError('automation_limit_reached');
        },
      }),
      step: 'save',
      arg: '',
      modal: { name: 'Blog', kind: 'rss', source: 'u', channel: '3' },
    });
    expect(JSON.stringify(r.message)).toContain('limit of active alerts');
  });

  test('interrupteur éteint : écran fermé', async () => {
    const r = await handleAutomationInteraction({
      ...base,
      api: api({ list: async () => ({ view: { ...view, enabled: false }, automations: [] }) }),
      step: 'list',
      arg: '0',
    });
    expect(JSON.stringify(r.message)).toContain('has not turned on alerts');
  });
});
