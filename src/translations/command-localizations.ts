/**
 * Localisation des commandes slash (noms, descriptions, options, choix, sous-commandes, groupes, menus
 * contextuels). Port de `packages/shared/lib/translations/command_localizations.dart` (Dart) et de
 * `internal/botlocale/command_localizations.go` (Manager) : le fichier `command_localizations_conformance.json` est
 * commun aux trois moteurs.
 *
 * Forme stockée sur la commande (`data.localizations`, clés = noms ou valeurs D'ORIGINE) :
 * `{name:{fr}, description:{fr}, options:{item:{name, description, choices:{sword:{fr}}, options:{…}}}}`.
 * Un texte vide veut dire « pas de traduction ». Les noms d'origine restent la référence de routage.
 */
import { DISCORD_LOCALES, normalizeLocale } from './locales.js';

export const NAME_MAX = 32;
export const DESCRIPTION_MAX = 100;
export const CHOICE_MAX = 100;
export const PAYLOAD_MAX = 8000;

export type CommandKind = 'chat_input' | 'user' | 'message';
export type LocaleTexts = Record<string, string>;

/** Nom CHAT_INPUT, de sous-commande, de groupe ou d'option. L'apostrophe ASCII est refusée par Discord. */
const CHAT_INPUT_NAME = /^[-_ʼ\p{L}\p{N}\p{Script=Devanagari}\p{Script=Thai}]{1,32}$/u;

export interface CommandLocalizations {
  name: LocaleTexts;
  description: LocaleTexts;
  choices: Record<string, LocaleTexts>;
  options: Record<string, CommandLocalizations>;
  /** Clés inconnues (version plus récente), conservées telles quelles. */
  extra: Record<string, unknown>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const length = (s: string): number => [...s].length;

function readTexts(raw: unknown): LocaleTexts {
  const out: LocaleTexts = {};
  if (!isRecord(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== 'string') continue;
    const text = v.trim();
    const key = k.trim();
    if (!text || !key) continue;
    out[normalizeLocale(key) ?? key] = text;
  }
  return out;
}

export function emptyLocalizations(): CommandLocalizations {
  return { name: {}, description: {}, choices: {}, options: {}, extra: {} };
}

export function isEmptyLocalizations(l: CommandLocalizations): boolean {
  return (
    Object.keys(l.name).length === 0 &&
    Object.keys(l.description).length === 0 &&
    Object.values(l.choices).every((c) => Object.keys(c).length === 0) &&
    Object.values(l.options).every(isEmptyLocalizations) &&
    Object.keys(l.extra).length === 0
  );
}

/** Lecture tolérante : ce qui n'a pas la bonne forme est ignoré, rien ne jette. */
export function parseCommandLocalizations(raw: unknown): CommandLocalizations {
  const node = emptyLocalizations();
  if (!isRecord(raw)) return node;
  node.name = readTexts(raw.name);
  node.description = readTexts(raw.description);
  if (isRecord(raw.choices)) {
    for (const [value, texts] of Object.entries(raw.choices)) {
      const t = readTexts(texts);
      if (Object.keys(t).length > 0) node.choices[value] = t;
    }
  }
  if (isRecord(raw.options)) {
    for (const [name, sub] of Object.entries(raw.options)) {
      const parsed = parseCommandLocalizations(sub);
      if (!isEmptyLocalizations(parsed)) node.options[name] = parsed;
    }
  }
  for (const [k, v] of Object.entries(raw)) {
    if (!['name', 'description', 'choices', 'options'].includes(k)) node.extra[k] = v;
  }
  return node;
}

/** Écrit la forme stockée : rien de vide n'est écrit. */
export function commandLocalizationsToJson(l: CommandLocalizations): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (Object.keys(l.name).length > 0) out.name = { ...l.name };
  if (Object.keys(l.description).length > 0) out.description = { ...l.description };
  const choices = Object.fromEntries(
    Object.entries(l.choices).filter(([, t]) => Object.keys(t).length > 0).map(([k, t]) => [k, { ...t }]),
  );
  if (Object.keys(choices).length > 0) out.choices = choices;
  const options = Object.fromEntries(
    Object.entries(l.options).filter(([, o]) => !isEmptyLocalizations(o)).map(([k, o]) => [k, commandLocalizationsToJson(o)]),
  );
  if (Object.keys(options).length > 0) out.options = options;
  Object.assign(out, l.extra);
  return out;
}

export function normalizeCommandLocalizations(raw: unknown): Record<string, unknown> {
  return commandLocalizationsToJson(parseCommandLocalizations(raw));
}

const isDiscordLocale = (locale: string): boolean => DISCORD_LOCALES.includes(locale);

const hasUppercaseWithLowercase = (value: string): boolean => {
  for (const ch of value) {
    if (ch.toLowerCase() !== ch && ch === ch.toUpperCase()) return true;
  }
  return false;
};

/** Code d'erreur du nom (rogné, non vide) ou `null`. `strict` : nom CHAT_INPUT, d'option, de sous-commande ou de groupe. */
export function nameIssue(text: string, strict: boolean): string | null {
  if (length(text) > NAME_MAX) return 'name_too_long';
  if (!strict) return null;
  if (!CHAT_INPUT_NAME.test(text)) return 'name_invalid_format';
  if (hasUppercaseWithLowercase(text)) return 'name_must_be_lowercase';
  return null;
}

export const descriptionIssue = (text: string): string | null =>
  length(text) > DESCRIPTION_MAX ? 'description_too_long' : null;

export const choiceIssue = (text: string): string | null =>
  length(text) > CHOICE_MAX ? 'choice_too_long' : null;

export interface LocalizationIssue {
  path: string;
  locale: string;
  code: string;
}

export const issueKey = (i: LocalizationIssue): string => `${i.path}|${i.locale}|${i.code}`;

export interface LocalizationSibling {
  name: string;
  nameLocalizations?: LocaleTexts;
}

const OPTION_TYPES: Record<string, number> = {
  subcommand: 1, subcommandgroup: 2, string: 3, integer: 4, boolean: 5, user: 6, channel: 7, role: 8,
  mentionable: 9, number: 10, attachment: 11,
};

function optionType(raw: unknown): number {
  if (typeof raw === 'number') return Math.trunc(raw);
  return OPTION_TYPES[String(raw ?? 'string').trim().toLowerCase()] ?? 3;
}

const optStr = (v: unknown): string => (typeof v === 'string' ? v : '');

const optionMaps = (raw: unknown): Record<string, unknown>[] =>
  Array.isArray(raw) ? raw.filter(isRecord) : [];

/** Les options de la commande : `data.options`, à défaut `options`. */
function commandOptions(command: Record<string, unknown>): Record<string, unknown>[] {
  const data = isRecord(command.data) ? command.data : undefined;
  return optionMaps(data?.options ?? command.options);
}

const choiceKey = (value: unknown): string => String(value ?? '');

/**
 * Valide `loc` contre la commande (forme stockée). `siblings` : les autres commandes de premier niveau du même type.
 * Un texte vide ou une entrée sans option correspondante est ignoré (jamais une erreur).
 */
export function validateCommandLocalizations(
  kind: CommandKind,
  command: Record<string, unknown>,
  loc: CommandLocalizations,
  siblings: LocalizationSibling[] = [],
): LocalizationIssue[] {
  const issues: LocalizationIssue[] = [];
  const strict = kind === 'chat_input';

  const checkTexts = (path: string, texts: LocaleTexts, check: (t: string) => string | null): void => {
    for (const [locale, text] of Object.entries(texts)) {
      if (!isDiscordLocale(locale)) {
        issues.push({ path, locale, code: 'unknown_locale' });
        continue;
      }
      const code = check(text);
      if (code) issues.push({ path, locale, code });
    }
  };

  const checkDuplicates = (group: { path: string; name: string; texts: LocaleTexts }[]): void => {
    for (const locale of DISCORD_LOCALES) {
      const effective = group.map((m) => (m.texts[locale] ?? m.name).toLowerCase());
      group.forEach((m, i) => {
        if (m.texts[locale] === undefined || m.path === '') return;
        if (effective.some((e, j) => j !== i && e === effective[i])) {
          issues.push({ path: m.path, locale, code: 'name_duplicate' });
        }
      });
    }
  };

  const walk = (options: Record<string, unknown>[], node: CommandLocalizations, prefix: string): void => {
    const group: { path: string; name: string; texts: LocaleTexts }[] = [];
    for (const option of options) {
      const name = optStr(option.name).trim();
      const sub = node.options[name];
      const path = `${prefix}${name}`;
      if (sub) {
        checkTexts(`${path}.name`, sub.name, (t) => nameIssue(t, true));
        checkTexts(`${path}.description`, sub.description, descriptionIssue);
        const type = optionType(option.type);
        if (type !== 1 && type !== 2) {
          if (Array.isArray(option.choices)) {
            for (const choice of option.choices) {
              if (!isRecord(choice)) continue;
              const key = choiceKey(choice.value);
              const texts = sub.choices[key];
              if (texts) checkTexts(`${path}.choices.${key}`, texts, choiceIssue);
            }
          }
        } else {
          walk(optionMaps(option.options), sub, `${path}.options.`);
        }
      }
      group.push({ path: `${path}.name`, name, texts: sub?.name ?? {} });
    }
    checkDuplicates(group);
  };

  checkTexts('name', loc.name, (t) => nameIssue(t, strict));
  if (kind === 'chat_input') {
    checkTexts('description', loc.description, descriptionIssue);
    walk(commandOptions(command), loc, 'options.');
  }
  checkDuplicates([
    { path: 'name', name: optStr(command.name).trim(), texts: loc.name },
    ...siblings.map((s) => ({ path: '', name: s.name.trim(), texts: s.nameLocalizations ?? {} })),
  ]);

  if (payloadSize(buildLocalizedPayloadFields(kind, command, loc)) > PAYLOAD_MAX) {
    issues.push({ path: '', locale: '', code: 'payload_too_large' });
  }
  return issues;
}

/** Seuls les textes valides, dans les 32 langues de Discord, partent. `undefined` quand rien ne part. */
function sendTexts(texts: LocaleTexts, check: (t: string) => string | null): LocaleTexts | undefined {
  const out: LocaleTexts = {};
  for (const locale of DISCORD_LOCALES) {
    const text = texts[locale];
    if (text === undefined || check(text)) continue;
    out[locale] = text;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function buildOptions(options: Record<string, unknown>[], node: CommandLocalizations): unknown[] {
  return options.map((option) => {
    const name = optStr(option.name).trim();
    const sub = node.options[name];
    const description = optStr(option.description);
    const built: Record<string, unknown> = { name, description: description === '' ? name : description };
    if (sub) {
      const n = sendTexts(sub.name, (t) => nameIssue(t, true));
      if (n) built.name_localizations = n;
      const d = sendTexts(sub.description, descriptionIssue);
      if (d) built.description_localizations = d;
    }
    const type = optionType(option.type);
    if (type === 1 || type === 2) {
      if (Array.isArray(option.options)) {
        built.options = buildOptions(optionMaps(option.options), sub ?? emptyLocalizations());
      }
    } else if (Array.isArray(option.choices)) {
      const list: unknown[] = [];
      for (const choice of option.choices) {
        if (!isRecord(choice) || optStr(choice.name) === '') continue;
        const entry: Record<string, unknown> = { name: optStr(choice.name), value: choice.value };
        const texts = sub?.choices[choiceKey(choice.value)];
        const n = texts ? sendTexts(texts, choiceIssue) : undefined;
        if (n) entry.name_localizations = n;
        list.push(entry);
      }
      if (list.length > 0) built.choices = list;
    }
    return built;
  });
}

/**
 * La part « localisation » de la charge utile Discord d'une commande stockée (nom, description, `name_localizations`,
 * `description_localizations`, `options`). Sert à la taille totale et à la conformance ; la charge utile réelle
 * (`toDiscordCommand`) passe par `localizeDiscordPayload`.
 */
export function buildLocalizedPayloadFields(
  kind: CommandKind,
  command: Record<string, unknown>,
  loc: CommandLocalizations,
): Record<string, unknown> {
  const strict = kind === 'chat_input';
  const name = optStr(command.name).trim();
  const out: Record<string, unknown> = { name };
  const n = sendTexts(loc.name, (t) => nameIssue(t, strict));
  if (n) out.name_localizations = n;
  if (kind === 'chat_input') {
    const description = optStr(command.description).trim();
    out.description = description === '' ? name : description;
    const d = sendTexts(loc.description, descriptionIssue);
    if (d) out.description_localizations = d;
    out.options = buildOptions(commandOptions(command), loc);
  }
  return out;
}

/**
 * Ajoute à `payload` (charge utile Discord déjà construite) les champs de localisation : la commande, ses options,
 * choix, sous-commandes et groupes sont appariés par leur nom d'origine. Rend `payload` (modifié sur place).
 */
export function localizeDiscordPayload<T extends { type?: number; options?: unknown[] }>(
  payload: T,
  loc: CommandLocalizations,
  kind?: CommandKind,
): T {
  if (isEmptyLocalizations(loc)) return payload;
  const resolved: CommandKind = kind ?? (payload.type === 2 ? 'user' : payload.type === 3 ? 'message' : 'chat_input');
  const target = payload as Record<string, unknown>;
  const n = sendTexts(loc.name, (t) => nameIssue(t, resolved === 'chat_input'));
  if (n) target.name_localizations = n;
  if (resolved !== 'chat_input') return payload;
  const d = sendTexts(loc.description, descriptionIssue);
  if (d) target.description_localizations = d;
  const walk = (raw: unknown, node: CommandLocalizations): void => {
    if (!Array.isArray(raw)) return;
    for (const item of raw) {
      if (!isRecord(item)) continue;
      const sub = node.options[optStr(item.name)];
      if (!sub) continue;
      const on = sendTexts(sub.name, (t) => nameIssue(t, true));
      if (on) item.name_localizations = on;
      const od = sendTexts(sub.description, descriptionIssue);
      if (od) item.description_localizations = od;
      if (Array.isArray(item.choices)) {
        for (const choice of item.choices) {
          if (!isRecord(choice)) continue;
          const texts = sub.choices[choiceKey(choice.value)];
          const c = texts ? sendTexts(texts, choiceIssue) : undefined;
          if (c) choice.name_localizations = c;
        }
      }
      walk(item.options, sub);
    }
  };
  walk(payload.options, loc);
  return payload;
}

const longest = (base: unknown, localized: unknown): number => {
  let n = typeof base === 'string' ? length(base) : 0;
  if (isRecord(localized)) {
    for (const v of Object.values(localized)) if (typeof v === 'string' && length(v) > n) n = length(v);
  }
  return n;
};

/**
 * Taille d'une charge utile de commande au sens de Discord (limite 8000) : pour chaque nom et chaque description, la
 * plus longue des langues ; pour un choix, son nom (le plus long) plus sa valeur.
 */
export function payloadSize(payload: Record<string, unknown>): number {
  const options = (raw: unknown): number => {
    let total = 0;
    if (!Array.isArray(raw)) return total;
    for (const o of raw) {
      if (!isRecord(o)) continue;
      total += longest(o.name, o.name_localizations) + longest(o.description, o.description_localizations);
      if (Array.isArray(o.choices)) {
        for (const c of o.choices) {
          if (!isRecord(c)) continue;
          total += longest(c.name, c.name_localizations) + length(String(c.value ?? ''));
        }
      }
      total += options(o.options);
    }
    return total;
  };
  return (
    longest(payload.name, payload.name_localizations) +
    longest(payload.description, payload.description_localizations) +
    options(payload.options)
  );
}

/** Les traductions d'une commande du runner : `data.localizations`, à défaut `localizations` à la racine. */
export function commandLocalizationsOf(command: { data?: Record<string, unknown>; localizations?: unknown }): CommandLocalizations {
  const fromData = command.data?.localizations;
  return parseCommandLocalizations(fromData !== undefined && fromData !== null ? fromData : command.localizations);
}
