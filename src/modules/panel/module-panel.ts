/**
 * Panneau de configuration des modules (Components V2, éphémère) : port TypeScript de
 * `packages/shared/lib/modules/panel/module_panel.dart` et `module_panel_state.dart` (bot-creator).
 * Fonctions pures : mêmes entrées, mêmes sorties que le moteur Dart, vérifiées par le même fichier
 * de conformité (`test/fixtures/module-panel-conformance.json`).
 */

import { PANEL_STRINGS, PANEL_LANGUAGES } from './module-panel-strings.js';

type Json = Record<string, any>;

/** Langue du panneau pour un code Discord (`fr`, `pt-BR`…) ; anglais si non gérée. */
export function panelStringsLanguage(code: string | null | undefined): string {
  const short = (code ?? '').toLowerCase().split(/[-_]/)[0];
  return PANEL_LANGUAGES.includes(short) ? short : 'en';
}

/** Langue du panneau : celle de la personne si gérée, sinon la langue par défaut du bot, sinon l'anglais. */
export function panelLanguageFor(userLocale: string | null | undefined, botDefault: string | null | undefined): string {
  const supported = (code: string | null | undefined): string | null => {
    const short = (code ?? '').toLowerCase().split(/[-_]/)[0];
    return PANEL_LANGUAGES.includes(short) ? short : null;
  };
  return supported(userLocale) ?? supported(botDefault) ?? 'en';
}

/** Texte `key` dans `lang` ; `{nom}` est remplacé par `args.nom`. */
export function ps(lang: string, key: string, args: Record<string, unknown> = {}): string {
  let s = PANEL_STRINGS[panelStringsLanguage(lang)]?.[key] ?? PANEL_STRINGS.en[key] ?? key;
  for (const [k, v] of Object.entries(args)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

export const PANEL_FLAGS = 32768 | 64; // Components V2 + éphémère
const MAX_COMPONENTS = 40;
const SETTINGS_PER_PAGE = 6;
const MODULES_PER_PAGE = 4;
const MAX_CHOICES = 25;

const ACCENT_HOME = 0x7c5cf0;
const ACCENT_ON = 0x57f287;
const ACCENT_OFF = 0x949ba4;
const ACCENT_ERR = 0xed4245;

export { MAX_COMPONENTS };

/** custom_id : `mcfg:<vue>:<module>:<argument>` (sans état stocké, 100 caractères au plus). */
export function panelId(view: string, module = '', arg = ''): string {
  const id = `mcfg:${view}:${module}:${arg}`;
  return id.length <= 100 ? id : id.substring(0, 100);
}

export function parsePanelId(customId: string): { view: string; module: string; arg: string } | null {
  if (!customId.startsWith('mcfg:')) return null;
  const p = customId.split(':');
  if (p.length < 4) return null;
  return { view: p[1], module: p[2], arg: p.slice(3).join(':') };
}

const text = (content: string): Json => ({ type: 10, content });
const sep = (): Json => ({ type: 14, divider: true, spacing: 1 });
const button = (id: string, label: string, style = 2, disabled = false): Json => ({
  type: 2,
  style,
  label,
  custom_id: id,
  ...(disabled ? { disabled: true } : {}),
});
const row = (items: Json[]): Json => ({ type: 1, components: items });
const section = (content: string, accessory: Json): Json => ({ type: 9, components: [text(content)], accessory });
const container = (color: number, children: Json[]): Json => ({ type: 17, accent_color: color, components: children });
const message = (c: Json): Json => ({ flags: PANEL_FLAGS, components: [c] });

export function countComponents(node: unknown): number {
  if (Array.isArray(node)) return node.reduce((a, e) => a + countComponents(e), 0);
  if (node === null || typeof node !== 'object') return 0;
  const n = node as Json;
  let count = 1;
  count += countComponents(n.components);
  if (n.accessory != null) count += countComponents(n.accessory);
  if (n.component != null) count += countComponents(n.component);
  return count;
}

const clip = (s: string, max: number): string => (s.length <= max ? s : `${s.substring(0, max - 1)}…`);
const clamp = (n: number, lo: number, hi: number): number => Math.min(Math.max(n, lo), hi);

function shown(s: Json, lang: string): string {
  const v = s.value;
  if (v === null || v === undefined || String(v) === '') return s.type === 'toggle' ? ps(lang, 'val.no') : ps(lang, 'val.empty');
  if (s.type === 'choice') {
    for (const c of s.choices ?? []) {
      if (c && String(c.value) === String(v)) return String(c.label);
    }
  }
  return clip(String(v), 60);
}

export function renderHome(input: Json): Json {
  const lang = String(input.language ?? 'en');
  const modules: Json[] = [...(input.modules ?? [])];
  modules.sort((a, b) => (b.todo?.length ?? 0) - (a.todo?.length ?? 0));
  const pages = modules.length === 0 ? 1 : Math.ceil(modules.length / MODULES_PER_PAGE);
  const page = clamp(Math.trunc(Number(input.page ?? 0)), 0, pages - 1);
  const slice = modules.slice(page * MODULES_PER_PAGE, page * MODULES_PER_PAGE + MODULES_PER_PAGE);
  const active = modules.filter((m) => m.enabled !== false).length;
  const todo = modules.filter((m) => (m.todo?.length ?? 0) > 0).length;
  const children: Json[] = [
    text(ps(lang, 'home.title', { total: modules.length, active, todo })),
    sep(),
  ];
  if (slice.length === 0) children.push(text(ps(lang, 'home.empty')));
  for (const m of slice) {
    const id = String(m.id);
    const todoList: string[] = (m.todo ?? []).map(String);
    const status =
      todoList.length > 0
        ? ps(lang, 'home.todo', { list: todoList.join(', ') })
        : m.enabled === false
          ? ps(lang, 'home.off')
          : ps(lang, 'home.on', { n: m.settingCount ?? 0 });
    children.push(
      section(
        `**${m.name}**\n-# ${status}`,
        button(panelId('module', id, '0'), todoList.length > 0 ? ps(lang, 'home.configure') : ps(lang, 'home.open'), todoList.length > 0 ? 1 : 2),
      ),
    );
  }
  children.push(text(ps(lang, 'home.page', { p: page + 1, n: pages })));
  const categories: Json[] = input.categories ?? [];
  if (categories.length > 0) {
    children.push(
      row([
        {
          type: 3,
          custom_id: panelId('cat', '', String(page)),
          placeholder: ps(lang, 'home.category'),
          options: categories.slice(0, MAX_CHOICES).map((c) => ({
            label: String(c.label),
            value: String(c.id),
            ...(c.id === input.category ? { default: true } : {}),
          })),
        },
      ]),
    );
  }
  if (modules.length > 0) {
    children.push(
      row([
        {
          type: 3,
          custom_id: panelId('goto'),
          placeholder: ps(lang, 'home.goto'),
          options: modules.slice(0, MAX_CHOICES).map((m) => ({ label: clip(String(m.name), 100), value: String(m.id) })),
        },
      ]),
    );
  }
  children.push(
    row([
      button(panelId('home', '', String(page - 1)), '◀', 2, page === 0),
      button(panelId('home', '', String(page + 1)), '▶', 2, page >= pages - 1),
    ]),
  );
  return message(container(ACCENT_HOME, children));
}

export function renderModule(input: Json): Json {
  const lang = String(input.language ?? 'en');
  const m: Json = input.module;
  const id = String(m.id);
  const settings: Json[] = m.settings ?? [];
  const pages = settings.length === 0 ? 1 : Math.ceil(settings.length / SETTINGS_PER_PAGE);
  const page = clamp(Math.trunc(Number(input.page ?? 0)), 0, pages - 1);
  const enabled = m.enabled !== false;
  const children: Json[] = [
    text(`## ${m.name}${m.tagline != null ? `\n-# ${m.tagline}` : ''}`),
    sep(),
    text(enabled ? ps(lang, 'mod.on') : ps(lang, 'mod.paused')),
  ];
  for (const s of settings.slice(page * SETTINGS_PER_PAGE, page * SETTINGS_PER_PAGE + SETTINGS_PER_PAGE)) {
    const key = String(s.key);
    const label = String(s.label);
    switch (s.type) {
      case 'toggle': {
        const on = s.value === true || String(s.value) === 'true';
        children.push(
          section(`**${label}**\n-# ${s.description ?? ''}`, button(panelId('toggle', id, key), on ? ps(lang, 'mod.yes') : ps(lang, 'mod.no'), on ? 3 : 2)),
        );
        break;
      }
      case 'channel':
      case 'role':
        children.push(text(`**${label}**\n-# ${s.description ?? ''}`));
        children.push(
          row([
            {
              type: s.type === 'channel' ? 8 : 6,
              custom_id: panelId('pick', id, key),
              placeholder: s.type === 'channel' ? ps(lang, 'mod.pickChannel') : ps(lang, 'mod.pickRole'),
              min_values: 0,
              max_values: 1,
              ...(String(s.value ?? '') !== '' ? { default_values: [{ id: String(s.value), type: s.type }] } : {}),
            },
          ]),
        );
        break;
      default:
        children.push(section(`**${label}**\n-# ${shown(s, lang)}`, button(panelId('edit', id, key), ps(lang, 'mod.edit'))));
    }
  }
  children.push(sep());
  children.push(text(ps(lang, 'mod.page', { p: page + 1, n: pages })));
  children.push(
    row([
      button(panelId('home'), ps(lang, 'mod.home')),
      button(panelId('module', id, String(page - 1)), '◀', 2, page === 0),
      button(panelId('module', id, String(page + 1)), '▶', 2, page >= pages - 1),
    ]),
  );
  return message(container(enabled ? ACCENT_ON : ACCENT_OFF, children));
}

export function renderEditModal(input: { module: string; setting: Json }): Json {
  const id = String(input.module);
  const s = input.setting;
  const key = String(s.key);
  let field: Json;
  if (s.type === 'choice') {
    field = {
      type: 3,
      custom_id: 'value',
      options: (s.choices as Json[]).slice(0, MAX_CHOICES).map((c) => ({
        label: String(c.label),
        value: String(c.value),
        ...(String(c.value) === String(s.value) ? { default: true } : {}),
      })),
    };
  } else {
    field = {
      type: 4,
      custom_id: 'value',
      style: s.type === 'text' ? 2 : 1,
      required: false,
      ...(String(s.value ?? '') !== '' ? { value: String(s.value) } : {}),
      max_length: s.type === 'text' ? 2000 : 32,
    };
  }
  return {
    title: clip(String(s.label), 45),
    custom_id: panelId('save', id, key),
    components: [{ type: 18, label: clip(String(s.label), 45), description: clip(String(s.description ?? ''), 100), component: field }],
  };
}

/** Dart `num.tryParse` : vrai nombre ou null. */
function tryParseNumber(v: string): number | null {
  const t = v.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function validateSetting(setting: Json, raw: string, lang = 'en'): string | null {
  const v = raw.trim();
  if (v === '') return null;
  switch (setting.type) {
    case 'number': {
      const n = tryParseNumber(v.replace(/,/g, '.'));
      if (n === null) return ps(lang, 'err.number', { label: setting.label });
      if (typeof setting.min === 'number' && n < setting.min) return ps(lang, 'err.min', { label: setting.label, min: setting.min });
      if (typeof setting.max === 'number' && n > setting.max) return ps(lang, 'err.max', { label: setting.label, max: setting.max });
      break;
    }
    case 'choice':
      if (!(setting.choices ?? []).some((c: Json) => c && String(c.value) === v)) return ps(lang, 'err.choice', { label: setting.label });
      break;
  }
  return null;
}

export function renderError(textValue: string, backId = 'mcfg:home::0', lang = 'en'): Json {
  return message(
    container(ACCENT_ERR, [text(ps(lang, 'err.title', { text: textValue })), row([button(backId, ps(lang, 'err.back'), 1)])]),
  );
}

// ---- Couche « état » (module_panel_state.dart) ----------------------------------------------------

export type PanelReader = (variable: string) => Promise<string | null | undefined>;
export interface PanelWrite {
  variable: string;
  value: string;
}
export interface PanelResult {
  message?: Json | null;
  modal?: Json | null;
  writes: PanelWrite[];
}

export const panelVariable = (moduleId: string, key: string): string =>
  `mod_${moduleId.replace(/-/g, '_')}_${key.replace(/-/g, '_')}`;

function pick(map: unknown, lang: string, fallback: string): string {
  if (map && typeof map === 'object') {
    const m = map as Json;
    const v = m[lang] ?? m.en;
    if (v != null && String(v) !== '') return String(v);
  }
  return fallback;
}

function i18nField(i18n: unknown, lang: string, field: string, fallback: string): string {
  if (i18n && typeof i18n === 'object') {
    const m = i18n as Json;
    const l = m[lang];
    if (l && typeof l === 'object' && l[field] != null) return String(l[field]);
    const e = m.en;
    if (e && typeof e === 'object' && e[field] != null) return String(e[field]);
  }
  return fallback;
}

function guildSettings(entry: Json): Json[] {
  const hidden = new Set<string>();
  const off = new Set<string>((entry.disabledFeatures ?? []).map(String));
  for (const f of entry.features ?? []) {
    if (f && typeof f === 'object' && off.has(String(f.key))) {
      for (const r of f.entities ?? []) {
        if (String(r).startsWith('setting:')) hidden.add(String(r).substring(8));
      }
    }
  }
  return (entry.settings ?? []).filter((s: Json) => s && typeof s === 'object' && s.scope === 'guild' && !hidden.has(String(s.key))).map((s: Json) => ({ ...s }));
}

function entryOf(doc: Json, id: string): Json | null {
  const reg = doc.modules;
  const e = reg && typeof reg === 'object' ? reg[id] : null;
  return e && typeof e === 'object' ? { ...e } : null;
}

const isEmpty = (v: unknown): boolean => v === null || v === undefined || String(v) === '';

export async function panelModuleInput(doc: Json, moduleId: string, read: PanelReader, language: string): Promise<Json | null> {
  const entry = entryOf(doc, moduleId);
  if (!entry) return null;
  const settings: Json[] = [];
  for (const s of guildSettings(entry)) {
    const key = String(s.key);
    const raw = await read(panelVariable(moduleId, key));
    const type = String(s.type);
    const value = isEmpty(raw) ? (s.default ?? '') : raw;
    settings.push({
      key,
      type: type === 'emoji' || type === 'color' ? 'text' : type,
      label: i18nField(s.i18n, language, 'label', key),
      description: i18nField(s.i18n, language, 'description', ''),
      ...(s.min != null ? { min: s.min } : {}),
      ...(s.max != null ? { max: s.max } : {}),
      ...(type === 'choice' ? { choices: (s.choices ?? []).map((c: unknown) => ({ value: String(c), label: String(c) })) } : {}),
      value: type === 'toggle' ? String(value) === 'true' : value,
    });
  }
  return { id: moduleId, name: pick(entry.name, language, moduleId), enabled: entry.enabled !== false, settings };
}

export async function panelHomeInput(doc: Json, read: PanelReader, language: string, page = 0): Promise<Json> {
  const reg = doc.modules;
  const modules: Json[] = [];
  if (reg && typeof reg === 'object') {
    const ids = Object.keys(reg).sort();
    for (const id of ids) {
      const entry = entryOf(doc, id);
      if (!entry) continue;
      const settings = guildSettings(entry);
      if (settings.length === 0) continue;
      const todo: string[] = [];
      for (const s of settings) {
        if (s.type !== 'channel' && s.type !== 'role') continue;
        const raw = await read(panelVariable(id, String(s.key)));
        if (isEmpty(raw) && isEmpty(s.default)) todo.push(i18nField(s.i18n, language, 'label', String(s.key)));
      }
      modules.push({
        id,
        name: pick(entry.name, language, id),
        enabled: entry.enabled !== false,
        settingCount: settings.length,
        todo,
      });
    }
  }
  return { modules, page };
}

const intOr0 = (v: string): number => {
  const n = Number.parseInt(v, 10);
  return Number.isNaN(n) ? 0 : n;
};

/** Applique une interaction du panneau. La permission « Gérer le serveur » est vérifiée par l'appelant. */
export async function handlePanelInteraction(args: {
  doc: Json;
  customId: string;
  read: PanelReader;
  language: string;
  values?: string[];
  modal?: Record<string, string>;
}): Promise<PanelResult> {
  const { doc, customId, read, language } = args;
  const values = args.values ?? [];
  const modal = args.modal ?? {};
  const id = parsePanelId(customId);
  if (!id) return { writes: [] };

  const home = async (page: number): Promise<PanelResult> => ({
    message: renderHome({ ...(await panelHomeInput(doc, read, language, page)), language }),
    writes: [],
  });
  const moduleView = async (m: string, page: number): Promise<PanelResult> => {
    const input = await panelModuleInput(doc, m, read, language);
    return input === null ? home(0) : { message: renderModule({ module: input, page, language }), writes: [] };
  };

  switch (id.view) {
    case 'home':
      return home(intOr0(id.arg));
    case 'module':
      return moduleView(id.module, intOr0(id.arg));
    case 'goto':
      return values.length === 0 ? home(0) : moduleView(values[0], 0);
    case 'edit':
    case 'toggle':
    case 'pick':
    case 'save': {
      const input = await panelModuleInput(doc, id.module, read, language);
      const setting = input === null ? null : ((input.settings as Json[]).find((s) => s.key === id.arg) ?? null);
      if (input === null || setting === null) return home(0);
      const variable = panelVariable(id.module, id.arg);
      if (id.view === 'edit') return { modal: renderEditModal({ module: id.module, setting }), writes: [] };
      let value: string;
      if (id.view === 'toggle') {
        value = String(!(setting.value === true));
      } else if (id.view === 'pick') {
        value = values.length === 0 ? '' : values[0];
      } else {
        value = (modal.value ?? '').trim();
        const error = validateSetting(setting, value, language);
        if (error !== null) return { message: renderError(error, panelId('module', id.module, '0'), language), writes: [] };
      }
      const updated = await panelModuleInput(doc, id.module, async (v) => (v === variable ? value : read(v)), language);
      return { message: renderModule({ module: updated, page: 0, language }), writes: [{ variable, value }] };
    }
  }
  return home(0);
}

