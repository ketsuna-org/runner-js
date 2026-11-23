import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DocumentsGatewayError, type DocSpace } from '../src/documents/documents-gateway.js';
import { LocalDocumentsGateway } from '../src/documents/local-documents.js';

type Step = Record<string, any>;
const fixture = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'document-conformance.json'), 'utf8')) as {
  cases: Array<{ name: string; steps: Step[] }>;
};

/** Chaque clé attendue doit correspondre ; les tableaux se comparent élément par élément. */
function subset(expected: unknown, actual: unknown, path: string): void {
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual), path).toBe(true);
    expect((actual as unknown[]).length, `${path} length`).toBe(expected.length);
    expected.forEach((e, i) => subset(e, (actual as unknown[])[i], `${path}[${i}]`));
  } else if (expected !== null && typeof expected === 'object') {
    expect(actual !== null && typeof actual === 'object', path).toBe(true);
    for (const [k, v] of Object.entries(expected)) {
      subset(v, (actual as Record<string, unknown>)[k], `${path}.${k}`);
    }
  } else {
    expect(actual, path).toEqual(expected);
  }
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

describe('documents conformance (local sqlite)', () => {
  for (const c of fixture.cases) {
    test(c.name, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'bc-docs-'));
      dirs.push(dir);
      let clock = new Date('2026-01-01T00:00:00Z');
      const gateway = new LocalDocumentsGateway({ dir, now: () => clock });
      const cursors: Record<string, string> = {};
      for (const step of c.steps) {
        if (step.call === 'advance') {
          clock = new Date(clock.getTime() + step.seconds * 1000);
          continue;
        }
        const space = step.space as DocSpace;
        const run = async (): Promise<unknown> => {
          switch (step.call) {
            case 'apply':
              return gateway.apply('bot1', space, step.ops);
            case 'get':
              return gateway.get('bot1', space, step.collection, step.id);
            case 'find': {
              const query = { ...step.query };
              if (step.after_from) {
                query.after = cursors[step.after_from];
              }
              const r = await gateway.find('bot1', space, step.collection, query);
              if (step.save_next) {
                cursors[step.save_next] = String(r.next);
              }
              return r;
            }
            case 'aggregate':
              return gateway.aggregate('bot1', space, step.collection, step.request);
          }
          throw new Error(`unknown step ${step.call}`);
        };
        if (step.error) {
          let code = '';
          try {
            await run();
          } catch (error) {
            code = error instanceof DocumentsGatewayError ? error.code : String(error);
          }
          expect(code).toBe(step.error);
          continue;
        }
        const result = await run();
        if ('expect' in step) {
          subset(step.expect, result, step.call);
        }
      }
      gateway.close();
    });
  }

  test('documents survive a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bc-docs-'));
    dirs.push(dir);
    const space: DocSpace = { kind: 'guild', id: '1' };
    const a = new LocalDocumentsGateway({ dir });
    await a.apply('b', space, [{ op: 'set', collection: 'xp', id: 'u1', value: { n: 2 } }]);
    a.close();
    const b = new LocalDocumentsGateway({ dir });
    expect((await b.get('b', space, 'xp', 'u1'))?.data).toEqual({ n: 2 });
    b.close();
  });
});
