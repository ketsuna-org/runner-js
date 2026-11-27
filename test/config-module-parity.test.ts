import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createBcModules } from '../src/scripts/script-bc-modules.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/config-module-parity.json', import.meta.url), 'utf8'));
const dir = process.env.MODULE_CATALOG_DIR;
const cat = dir ? JSON.parse(readFileSync(`${dir}/config.json`, 'utf8')) : null;
const S: Record<string, string> = {};
if (cat) {
  cat.variants.js.workflows.forEach((w: any) => (S[w.key] = w.jsScriptContent));
  S.command = cat.variants.js.commands[0].data.jsScriptContent;
}
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

const norm = (x: any): any => Array.isArray(x) ? x.map(norm) : x && typeof x === 'object'
  ? Object.fromEntries(Object.entries(x).filter(([k, v]) => !(k === 'default' && v === false) && !(k === 'disabled' && v === false)).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, norm(v)])) : x;

async function run(script: string, customId: string, extra: any = {}) {
  const out: any = {};
  const store: Record<string, unknown> = { ...fx.vars };
  const bc: any = createBcModules({
    config: { modules: fx.mods, translations: {}, commands: [] },
    interaction: { locale: 'en-US', guildId: '10', user: { id: '22' }, memberPermissions: { has: () => true } },
    db: { guild: { get: async (k: string) => store[k], set: async (k: string, v: unknown) => void (store[k] = v) } },
  } as never);
  bc.t = async (key: string, vars: any = {}) => String(fx.en[key.replace('mod.config.', '')]).replace(/\{(\w+)\}/g, (_: string, n: string) => String(vars[n]));
  const interaction = {
    guildId: '10', customId, locale: 'en-US', memberPermissions: { has: () => true },
    options: { getString: () => extra.module ?? '' }, values: extra.values ?? [],
    fields: { getTextInputValue: () => extra.value ?? '' },
    reply: async (p: any) => void (out.reply = p), update: async (p: any) => void (out.update = p), showModal: async (p: any) => void (out.modal = p),
  };
  await new AsyncFunction('interaction', 'bc', S[script] ? S[script] : script)(interaction, bc);
  return { out, store };
}

/** Le module « config » (scripts JS du catalogue) rend EXACTEMENT ce que rendait le panneau natif (rendus Dart gardés dans la fixture). */
test.skipIf(!cat)('config module = native panel', async () => {
  for (const c of fx.cases) {
    const view = c.split(':')[1];
    const r = view === 'edit' ? await run('edit', c) : c === 'mcfg:home::0' ? await run('command', c) : await run('nav', c);
    const got = r.out.modal ?? r.out.update ?? r.out.reply;
    const nat = fx.native[c];
    const a = norm(got.components ?? got), b = norm(nat.components ?? nat);
    expect(JSON.stringify(a), c).toBe(JSON.stringify(b));
  }
});
