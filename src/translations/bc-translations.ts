import { TranslationCatalog, parseTranslationArguments } from './catalog.js';
import { normalizeLocale } from './locales.js';

/** Ce que le global `bc` expose pour les traductions : `bc.t`, `bc.locale`, `bc.guildLocale`. */
export interface BcTranslate {
  (key: string, ...args: unknown[]): string;
  /** Même chose dans une langue choisie : `bc.t.in('fr', 'key', {…})`. */
  in(locale: string, key: string, ...args: unknown[]): string;
  has(key: string): boolean;
}

export interface TranslationContext {
  config?: { translations?: unknown };
  interaction?: unknown;
  guild?: unknown;
  message?: unknown;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

function localeOf(source: unknown, field: string): string | null {
  const value = (source as Record<string, unknown> | undefined)?.[field];
  return typeof value === 'string' && value ? value : null;
}

/** Langue de la personne : la locale de l'interaction (aucune pour un message, un événement ou une tâche). */
export function userLocaleOf(context: TranslationContext): string | null {
  return localeOf(context.interaction, 'locale');
}

/** Langue du serveur : celle de l'interaction (serveur « Communauté »), sinon la langue préférée connue. */
export function guildLocaleOf(context: TranslationContext): string | null {
  return (
    localeOf(context.interaction, 'guildLocale') ??
    localeOf(context.guild, 'preferredLocale') ??
    localeOf((context.message as Record<string, unknown> | undefined)?.guild, 'preferredLocale')
  );
}

/** Langue du serveur pour la CHAÎNE : seulement celle de l'interaction (serveur Communauté), jamais `preferredLocale`. */
export function chainGuildLocaleOf(context: TranslationContext): string | null {
  return localeOf(context.interaction, 'guildLocale');
}

/** Arguments de `t(key, …)` : un objet = nommés ; sinon positionnels (`{1}`, `{2}`). */
export function toTranslationArgs(args: unknown[]): Record<string, unknown> {
  if (args.length === 1 && isPlainObject(args[0])) return args[0];
  const out: Record<string, unknown> = {};
  let named = false;
  const positional: string[] = [];
  for (const a of args) {
    if (isPlainObject(a)) {
      Object.assign(out, a);
      named = true;
    } else positional.push(String(a ?? ''));
  }
  if (named && positional.length === 0) return out;
  const parsed = parseTranslationArguments(positional.map((p) => (/^[A-Za-z0-9_]+=/.test(p) ? `1=${p}` : p)));
  return { ...parsed, ...out };
}

export function createBcTranslations(
  context: TranslationContext,
  warn: (message: string) => void = () => undefined,
): { t: BcTranslate; locale: string; guildLocale: string } {
  let cache: { raw: unknown; catalog: TranslationCatalog } | undefined;
  const catalog = (): TranslationCatalog => {
    const raw = context.config?.translations;
    if (!cache || cache.raw !== raw) cache = { raw, catalog: TranslationCatalog.fromDocument(raw) };
    return cache.catalog;
  };
  const run = (key: unknown, args: unknown[], forced?: string): string => {
    const name = String(key ?? '').trim();
    if (!name) throw new Error('Translation key must not be empty.');
    const result = catalog().translate(name, {
      userLocale: userLocaleOf(context),
      guildLocale: chainGuildLocaleOf(context),
      forced,
      args: toTranslationArgs(args),
    });
    for (const w of result.warnings) warn(w);
    return result.text;
  };
  const t = ((key: string, ...args: unknown[]) => run(key, args)) as BcTranslate;
  t.in = (locale, key, ...args) => {
    const forced = normalizeLocale(locale);
    if (!forced) throw new Error('Unknown locale. Use a Discord locale such as fr, en-US or pt-BR.');
    return run(key, args, forced);
  };
  t.has = (key) => catalog().has(String(key ?? '').trim());
  return {
    t,
    get locale(): string {
      return userLocaleOf(context) ?? '';
    },
    get guildLocale(): string {
      return guildLocaleOf(context) ?? '';
    },
  };
}
