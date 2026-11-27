import { describe, expect, it } from 'bun:test';
import conformance from './fixtures/module-query-conformance.json';
import {
  ModuleQueryError,
  commandInfo,
  commandList,
  moduleCount,
  moduleFeature,
  moduleInfo,
  moduleList,
  moduleSetting,
  validateModuleSettingWrite,
} from '../src/modules/module-query.js';

const doc = conformance.doc as never;
const commands = conformance.commands as never[];
const variables = conformance.variables as Record<string, string>;

const sep = (args: string[], i: number): string => (args[i] !== undefined && args[i] !== '' ? args[i]! : ',');
const arg = (args: string[], i: number, d = ''): string => (args[i] !== undefined ? args[i]! : d);

async function run(c: { fn: string; args: string[]; locale?: string }): Promise<{ ok: string } | { error: string }> {
  const a = c.args;
  const locale = c.locale ?? '';
  try {
    switch (c.fn) {
      case 'moduleList':
        return { ok: moduleList(doc, { separator: sep(a, 0), filter: arg(a, 1, 'all'), format: arg(a, 2, 'id'), locale }) };
      case 'moduleCount':
        return { ok: moduleCount(doc, arg(a, 0, 'all')) };
      case 'moduleInfo':
        return { ok: moduleInfo(doc, arg(a, 0), arg(a, 1, 'name'), { separator: sep(a, 2), locale }) };
      case 'moduleFeature':
        return { ok: moduleFeature(doc, arg(a, 0), arg(a, 1), arg(a, 2, 'enabled'), { separator: sep(a, 3), locale }) };
      case 'moduleSetting':
        return {
          ok: await moduleSetting(doc, arg(a, 0), arg(a, 1), arg(a, 2, 'value'), async (v) => variables[v], {
            separator: sep(a, 3),
            locale,
          }),
        };
      case 'commandList':
        return { ok: commandList(commands, doc, { separator: sep(a, 0), filter: arg(a, 1, 'slash') }) };
      case 'commandInfo':
        return { ok: commandInfo(commands, doc, arg(a, 0), arg(a, 1, 'description'), { separator: sep(a, 2), locale }) };
      case 'validateWrite': {
        const w = validateModuleSettingWrite(doc, arg(a, 0), arg(a, 1), arg(a, 2));
        return { ok: `${w.variable}=${w.value}` };
      }
    }
    throw new Error(`Unknown call ${c.fn}`);
  } catch (e) {
    if (e instanceof ModuleQueryError) return { error: e.message };
    throw e;
  }
}

describe('conformance de module_query (Dart ↔ TypeScript)', () => {
  for (const c of conformance.cases as Array<{ fn: string; args: string[]; locale?: string; expect: unknown }>) {
    it(`${c.fn} ${JSON.stringify(c.args)} ${c.locale ?? ''}`, async () => {
      expect(await run(c)).toEqual(c.expect as never);
    });
  }
});
