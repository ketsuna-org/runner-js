import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { handlePanelInteraction } from '../src/modules/panel/module-panel.js';

// Même fichier que celui rejoué par le moteur Dart (bot-creator, packages/shared/test/modules/panel).
const data = JSON.parse(readFileSync(new URL('./fixtures/module-panel-conformance.json', import.meta.url), 'utf8'));

describe('panneau de config des modules : conformité avec le moteur Dart', () => {
  for (const c of data.cases) {
    test(c.name, async () => {
      const r = await handlePanelInteraction({
        doc: data.doc,
        customId: c.customId,
        read: async (v) => data.variables[v] ?? null,
        language: c.language,
        values: c.values,
        modal: c.modal,
      });
      const got = JSON.parse(
        JSON.stringify({ message: r.message ?? null, modal: r.modal ?? null, writes: r.writes }),
      );
      expect(got).toEqual(JSON.parse(JSON.stringify(c.expect)));
    });
  }
});
