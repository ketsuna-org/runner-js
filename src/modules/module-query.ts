/**
 * Lecture (et validation d'écriture) des modules installés et des commandes du bot, pour
 * `bc.module.*` et `bc.command.*`. Port de `packages/shared/lib/modules/module_query.dart` (Dart,
 * fonctions BDFD `$moduleList`, `$moduleInfo`, `$commandInfo`, etc.) : le fichier
 * `module-query-conformance.json` est commun aux deux moteurs.
 *
 * Tout est piloté par le registre `modules` du document du bot : rien ici ne connaît un module par
 * son nom, un module communautaire est donc pris en charge tel quel.
 */

export class ModuleQueryError extends Error {}

type Rec = Record<string, unknown>;
export interface ModuleQueryDoc {
  modules?: Record<string, unknown>;
  translations?: { defaultLocale?: unknown } | Record<string, unknown>;
}
export type ModuleVariableReader = (variable: string) => Promise<string | null | undefined>;

const MODULE_LIST_FILTERS = ['all', 'enabled', 'configurable'];
const MODULE_LIST_FORMATS = ['id', 'name'];
const MODULE_INFO_FIELDS = ['installed', 'name', 'version', 'enabled', 'commands', 'features', 'settings'];
const MODULE_FEATURE_FIELDS = ['enabled', 'name', 'requires'];
const MODULE_SETTING_FIELDS = ['value', 'default', 'type', 'label', 'description', 'min', 'max', 'choices', 'set'];
const COMMAND_INFO_FIELDS = ['exists', 'name', 'description', 'type', 'module', 'subcommands', 'options', 'usage'];

const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v));

/** Un nombre entier s'écrit sans « .0 ». */
function plain(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v)) return String(v);
  return String(v);
}

function registry(doc: ModuleQueryDoc): Record<string, unknown> {
  return isRec(doc.modules) ? doc.modules : {};
}

function entryOf(doc: ModuleQueryDoc, id: string): Rec | undefined {
  const e = registry(doc)[id];
  return isRec(e) ? e : undefined;
}

const baseOf = (locale: string): string => (locale.includes('-') ? locale.split('-')[0]! : locale);

export function defaultLocaleOf(doc: ModuleQueryDoc): string {
  const t = doc.translations as Rec | undefined;
  return t && t.defaultLocale !== undefined && t.defaultLocale !== null ? String(t.defaultLocale) : '';
}

function candidates(locale: string, def: string): string[] {
  return [locale, baseOf(locale), def, baseOf(def), 'en'].filter((k) => k !== '');
}

function pickText(map: unknown, locale: string, def: string): string | undefined {
  if (!isRec(map)) return undefined;
  for (const k of candidates(locale, def)) {
    const v = map[k];
    if (v !== undefined && v !== null && String(v) !== '') return String(v);
  }
  return undefined;
}

function i18nField(i18n: unknown, locale: string, def: string, field: string, fallback: string): string {
  if (!isRec(i18n)) return fallback;
  for (const k of candidates(locale, def)) {
    const l = i18n[k];
    if (isRec(l) && l[field] !== undefined && l[field] !== null && String(l[field]) !== '') return String(l[field]);
  }
  return fallback;
}

const moduleName = (doc: ModuleQueryDoc, id: string, entry: Rec, locale: string): string =>
  pickText(entry.name, locale, defaultLocaleOf(doc)) ?? id;

const isEnabled = (entry: Rec): boolean => entry.enabled !== false && entry.disabled !== true;

const disabledFeatures = (entry: Rec): Set<string> => new Set(list(entry.disabledFeatures).map(String));

/** Réglages par serveur visibles : ceux d'une fonctionnalité désactivée sont masqués. */
export function guildSettingsOf(entry: Rec): Rec[] {
  const hidden = new Set<string>();
  const off = disabledFeatures(entry);
  for (const f of list(entry.features)) {
    if (isRec(f) && off.has(str(f.key))) {
      for (const r of list(f.entities)) if (String(r).startsWith('setting:')) hidden.add(String(r).slice(8));
    }
  }
  return list(entry.settings).filter((s): s is Rec => isRec(s) && s.scope === 'guild' && !hidden.has(str(s.key)));
}

export const settingVariable = (moduleId: string, key: string): string =>
  `mod_${moduleId.replaceAll('-', '_')}_${key.replaceAll('-', '_')}`;

const installedIds = (doc: ModuleQueryDoc): string[] => Object.keys(registry(doc)).sort();

function requireEntry(doc: ModuleQueryDoc, id: string): Rec {
  const e = entryOf(doc, id);
  if (!e) throw new ModuleQueryError(`Module "${id}" is not installed.`);
  return e;
}

function oneOf(value: string, allowed: string[], what: string): string {
  const v = value.trim().toLowerCase();
  if (!allowed.includes(v)) throw new ModuleQueryError(`Unknown ${what} "${value}". Use ${allowed.join(', ')}.`);
  return v;
}

export function moduleList(
  doc: ModuleQueryDoc,
  o: { separator?: string; filter?: string; format?: string; locale?: string } = {},
): string {
  const f = oneOf(o.filter || 'all', MODULE_LIST_FILTERS, 'filter');
  const fmt = oneOf(o.format || 'id', MODULE_LIST_FORMATS, 'format');
  const out: string[] = [];
  for (const id of installedIds(doc)) {
    const entry = entryOf(doc, id);
    if (!entry) continue;
    if (f === 'enabled' && !isEnabled(entry)) continue;
    if (f === 'configurable' && guildSettingsOf(entry).length === 0) continue;
    out.push(fmt === 'name' ? moduleName(doc, id, entry, o.locale ?? '') : id);
  }
  return out.join(o.separator ?? ',');
}

export function moduleCount(doc: ModuleQueryDoc, filter = 'all'): string {
  const f = oneOf(filter || 'all', MODULE_LIST_FILTERS, 'filter');
  let n = 0;
  for (const id of installedIds(doc)) {
    const entry = entryOf(doc, id);
    if (!entry) continue;
    if (f === 'enabled' && !isEnabled(entry)) continue;
    if (f === 'configurable' && guildSettingsOf(entry).length === 0) continue;
    n++;
  }
  return String(n);
}

const moduleCommands = (entry: Rec): string[] =>
  list(entry.entities)
    .filter((e): e is Rec => isRec(e) && e.kind === 'command')
    .map((e) => str(e.name));

export function moduleInfo(
  doc: ModuleQueryDoc,
  id: string,
  field: string,
  o: { separator?: string; locale?: string } = {},
): string {
  const f = oneOf(field || 'name', MODULE_INFO_FIELDS, 'field');
  const moduleId = id.trim();
  const entry = entryOf(doc, moduleId);
  if (f === 'installed') return String(entry !== undefined);
  if (!entry) throw new ModuleQueryError(`Module "${moduleId}" is not installed.`);
  const sep = o.separator ?? ',';
  switch (f) {
    case 'name':
      return moduleName(doc, moduleId, entry, o.locale ?? '');
    case 'version':
      return str(entry.version);
    case 'enabled':
      return String(isEnabled(entry));
    case 'commands':
      return moduleCommands(entry).join(sep);
    case 'features':
      return list(entry.features)
        .filter(isRec)
        .map((x) => str(x.key))
        .join(sep);
    case 'settings':
      return guildSettingsOf(entry)
        .map((s) => str(s.key))
        .join(sep);
  }
  return '';
}

export function moduleFeature(
  doc: ModuleQueryDoc,
  id: string,
  feature: string,
  field: string,
  o: { separator?: string; locale?: string } = {},
): string {
  const f = oneOf(field || 'enabled', MODULE_FEATURE_FIELDS, 'field');
  const moduleId = id.trim();
  const entry = requireEntry(doc, moduleId);
  const key = feature.trim();
  const found = list(entry.features).find((x): x is Rec => isRec(x) && str(x.key) === key);
  if (!found) throw new ModuleQueryError(`Module "${moduleId}" has no feature "${key}".`);
  switch (f) {
    case 'enabled':
      return String(!disabledFeatures(entry).has(key));
    case 'name':
      return pickText(found.name, o.locale ?? '', defaultLocaleOf(doc)) ?? key;
    case 'requires':
      return list(found.requires).map(String).join(o.separator ?? ',');
  }
  return '';
}

function requireSetting(entry: Rec, moduleId: string, key: string): Rec {
  const s = guildSettingsOf(entry).find((x) => str(x.key) === key);
  if (!s) throw new ModuleQueryError(`Module "${moduleId}" has no setting "${key}".`);
  return s;
}

export async function moduleSetting(
  doc: ModuleQueryDoc,
  id: string,
  key: string,
  field: string,
  read: ModuleVariableReader,
  o: { separator?: string; locale?: string } = {},
): Promise<string> {
  const f = oneOf(field || 'value', MODULE_SETTING_FIELDS, 'field');
  const moduleId = id.trim();
  const entry = requireEntry(doc, moduleId);
  const s = requireSetting(entry, moduleId, key.trim());
  const def = defaultLocaleOf(doc);
  const locale = o.locale ?? '';
  switch (f) {
    case 'value':
    case 'set': {
      const raw = await read(settingVariable(moduleId, str(s.key)));
      const has = raw !== undefined && raw !== null && raw !== '';
      if (f === 'set') return String(has);
      return has ? raw : plain(s.default);
    }
    case 'default':
      return plain(s.default);
    case 'type':
      return str(s.type);
    case 'label':
      return i18nField(s.i18n, locale, def, 'label', str(s.key));
    case 'description':
      return i18nField(s.i18n, locale, def, 'description', '');
    case 'min':
      return plain(s.min);
    case 'max':
      return plain(s.max);
    case 'choices':
      return list(s.choices).map(String).join(o.separator ?? ',');
  }
  return '';
}

const SNOWFLAKE = /^[0-9]{15,22}$/;

/** Valide une valeur reçue pour un réglage ; rend la variable cible et la valeur normalisée. */
export function validateModuleSettingWrite(
  doc: ModuleQueryDoc,
  id: string,
  key: string,
  raw: string,
): { variable: string; value: string } {
  const moduleId = id.trim();
  const entry = requireEntry(doc, moduleId);
  const s = requireSetting(entry, moduleId, key.trim());
  const variable = settingVariable(moduleId, str(s.key));
  let v = raw.trim();
  if (v === '') return { variable, value: '' };
  const label = str(s.key);
  switch (str(s.type)) {
    case 'number': {
      const n = /^[-+]?(\d+([.,]\d*)?|[.,]\d+)([eE][-+]?\d+)?$/.test(v) ? Number(v.replace(',', '.')) : Number.NaN;
      if (!Number.isFinite(n)) throw new ModuleQueryError(`"${label}" must be a number.`);
      if (typeof s.min === 'number' && n < s.min) throw new ModuleQueryError(`"${label}" must be at least ${plain(s.min)}.`);
      if (typeof s.max === 'number' && n > s.max) throw new ModuleQueryError(`"${label}" must be at most ${plain(s.max)}.`);
      v = String(n);
      break;
    }
    case 'toggle': {
      const l = v.toLowerCase();
      if (['true', '1', 'on', 'yes'].includes(l)) v = 'true';
      else if (['false', '0', 'off', 'no'].includes(l)) v = 'false';
      else throw new ModuleQueryError(`"${label}" must be true or false.`);
      break;
    }
    case 'choice': {
      const choices = list(s.choices).map(String);
      if (!choices.includes(v)) throw new ModuleQueryError(`"${label}" must be one of: ${choices.join(', ')}.`);
      break;
    }
    case 'channel':
    case 'role': {
      const m = /^<(?:#|@&)([0-9]{15,22})>$/.exec(v);
      if (m) v = m[1]!;
      if (!SNOWFLAKE.test(v)) throw new ModuleQueryError(`"${label}" must be a Discord ID.`);
      break;
    }
  }
  return { variable, value: v };
}

// ------------------------------------------------------------------ commandes

export type QueryCommand = Rec;

const KNOWN_KINDS = ['chatInput', 'chat_input', 'user', 'message', '1', '2', '3'];

/** Genre de la commande : `discordType`, puis `data.commandType`, puis `type` (qui peut valoir `command`). */
function commandKind(c: Rec): string {
  const data = isRec(c.data) ? c.data : {};
  for (const v of [c.discordType, data.commandType, c.type]) {
    if (v !== undefined && v !== null && KNOWN_KINDS.includes(String(v))) return String(v);
  }
  return 'chatInput';
}

function isSlash(c: Rec): boolean {
  const data = isRec(c.data) ? c.data : {};
  const t = str(c.triggerType ?? data.triggerType ?? 'slash');
  return (t === 'slash' || t === 'hybrid') && ['chatInput', 'chat_input', '1'].includes(commandKind(c));
}

function owners(doc: ModuleQueryDoc): Map<string, string> {
  const out = new Map<string, string>();
  for (const id of installedIds(doc)) {
    const entry = entryOf(doc, id);
    if (!entry) continue;
    for (const n of moduleCommands(entry)) out.set(n.toLowerCase(), id);
  }
  return out;
}

export function commandList(
  commands: QueryCommand[],
  doc: ModuleQueryDoc,
  o: { separator?: string; filter?: string } = {},
): string {
  const f = (o.filter ?? '').trim() === '' ? 'slash' : o.filter!.trim();
  const own = owners(doc);
  const names: string[] = [];
  for (const c of commands) {
    const name = str(c.name);
    if (name === '') continue;
    const owner = own.get(name.toLowerCase());
    if (f === 'all') {
      // tout
    } else if (f === 'slash') {
      if (!isSlash(c)) continue;
    } else if (f === 'custom') {
      if (!isSlash(c) || owner !== undefined) continue;
    } else if (f.startsWith('module:')) {
      if (!isSlash(c) || owner !== f.slice(7)) continue;
    } else {
      throw new ModuleQueryError(`Unknown filter "${o.filter}". Use slash, all, custom or module:<id>.`);
    }
    names.push(name);
  }
  names.sort(compareCodeUnits);
  return names.join(o.separator ?? ',');
}

/** Même ordre que Dart (`List.sort` sur des chaînes) : par unité de code UTF-16. */
const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function findCommand(commands: QueryCommand[], name: string): Rec | undefined {
  const want = name.trim().toLowerCase();
  return (
    commands.find((c) => str(c.name).toLowerCase() === want && isSlash(c)) ??
    commands.find((c) => str(c.name).toLowerCase() === want)
  );
}

function optionsOf(c: Rec): Rec[] {
  const data = isRec(c.data) ? c.data : {};
  return list(data.options ?? c.options).filter(isRec);
}

function localizationsOf(c: Rec): Rec | undefined {
  const data = isRec(c.data) ? c.data : {};
  const l = data.localizations ?? c.localizations;
  return isRec(l) ? l : undefined;
}

function localizedText(texts: unknown, locale: string, fallback: string): string {
  if (!isRec(texts)) return fallback;
  for (const k of [locale, baseOf(locale)]) {
    if (k === '') continue;
    const v = texts[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return fallback;
}

const isSub = (o: Rec): boolean => ['subcommand', '1'].includes(str(o.type).toLowerCase());
const isGroup = (o: Rec): boolean => ['subcommandgroup', '2'].includes(str(o.type).toLowerCase());

function usageOf(prefix: string, options: Rec[]): string {
  const parts = [prefix];
  for (const o of options) {
    if (isSub(o) || isGroup(o)) continue;
    parts.push(o.required === true ? `<${str(o.name)}>` : `[${str(o.name)}]`);
  }
  return parts.join(' ');
}

export function commandInfo(
  commands: QueryCommand[],
  doc: ModuleQueryDoc,
  name: string,
  field: string,
  o: { separator?: string; locale?: string } = {},
): string {
  const f = oneOf(field || 'description', COMMAND_INFO_FIELDS, 'field');
  const c = findCommand(commands, name);
  if (f === 'exists') return String(c !== undefined);
  if (!c) throw new ModuleQueryError(`Command "${name.trim()}" not found.`);
  const cname = str(c.name);
  const loc = localizationsOf(c);
  const options = optionsOf(c);
  const sep = o.separator ?? ',';
  const locale = o.locale ?? '';
  switch (f) {
    case 'name':
      return localizedText(loc?.name, locale, cname);
    case 'description': {
      const data = isRec(c.data) ? c.data : {};
      return localizedText(loc?.description, locale, str(c.description ?? data.description));
    }
    case 'type':
      return isSlash(c) ? 'slash' : str(c.triggerType ?? 'text');
    case 'module':
      return owners(doc).get(cname.toLowerCase()) ?? '';
    case 'subcommands': {
      const out: string[] = [];
      for (const opt of options) {
        if (isSub(opt)) out.push(str(opt.name));
        if (isGroup(opt)) for (const s of list(opt.options)) if (isRec(s)) out.push(`${str(opt.name)} ${str(s.name)}`);
      }
      return out.join(sep);
    }
    case 'options':
      return options
        .filter((x) => !isSub(x) && !isGroup(x))
        .map((x) => str(x.name))
        .join(sep);
    case 'usage': {
      const lines: string[] = [];
      let hasSub = false;
      for (const opt of options) {
        if (isSub(opt)) {
          hasSub = true;
          lines.push(usageOf(`/${cname} ${str(opt.name)}`, list(opt.options).filter(isRec)));
        } else if (isGroup(opt)) {
          hasSub = true;
          for (const s of list(opt.options)) {
            if (!isRec(s)) continue;
            lines.push(usageOf(`/${cname} ${str(opt.name)} ${str(s.name)}`, list(s.options).filter(isRec)));
          }
        }
      }
      if (!hasSub) lines.push(usageOf(`/${cname}`, options));
      return lines.join(sep);
    }
  }
  return '';
}
