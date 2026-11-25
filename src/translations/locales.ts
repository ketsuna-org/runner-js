/**
 * Les 32 locales de l'API Discord, ni plus ni moins. Les codes sont ceux que Discord envoie dans
 * `interaction.locale` et `interaction.guild_locale`. Port de `packages/shared/lib/translations` (Dart) :
 * le fichier de conformance `translations_conformance.json` est commun.
 */
export const DISCORD_LOCALES: readonly string[] = [
  'id', 'da', 'de', 'en-GB', 'en-US', 'es-ES', 'es-419', 'fr', 'hr', 'it',
  'lt', 'hu', 'nl', 'no', 'pl', 'pt-BR', 'ro', 'fi', 'sv-SE', 'vi', 'tr',
  'cs', 'el', 'bg', 'ru', 'uk', 'hi', 'th', 'zh-CN', 'ja', 'zh-TW', 'ko',
];

export const FALLBACK_LOCALE = 'en-US';

const BY_LOWER = new Map<string, string>([
  ...DISCORD_LOCALES.map((l): [string, string] => [l.toLowerCase(), l]),
  ['en', 'en-US'],
  ['es', 'es-ES'],
  ['pt', 'pt-BR'],
  ['zh', 'zh-CN'],
  ['sv', 'sv-SE'],
  ['nb', 'no'],
  ['nn', 'no'],
  ['en_us', 'en-US'],
  ['en_gb', 'en-GB'],
  ['es_es', 'es-ES'],
  ['pt_br', 'pt-BR'],
  ['zh_cn', 'zh-CN'],
  ['zh_tw', 'zh-TW'],
  ['sv_se', 'sv-SE'],
]);

/** Ramène un code vers l'un des 32 codes Discord, ou `null`. */
export function normalizeLocale(raw: unknown): string | null {
  const text = String(raw ?? '').trim().toLowerCase();
  return text ? (BY_LOWER.get(text) ?? null) : null;
}

// Le chinois simplifié et traditionnel s'écrivent différemment : zh-CN et zh-TW ne sont pas des variantes.
const base = (locale: string): string => (locale.startsWith('zh-') ? locale : (locale.split('-')[0] ?? locale));

/**
 * Ordre d'essai : la personne et les variantes de sa langue, le serveur idem, la langue par défaut du bot (et ses
 * variantes), puis en-US et en-GB. Sans langue par défaut (ou en-US), comme avant.
 */
export function localeChain(
  user?: string | null,
  guild?: string | null,
  defaultLocale?: string | null,
  useSimilar = true,
): string[] {
  const out: string[] = [];
  const add = (locale: string | null | undefined): void => {
    if (locale && !out.includes(locale)) out.push(locale);
  };
  const addWithSiblings = (raw: string | null | undefined): void => {
    const locale = normalizeLocale(raw);
    if (!locale) return;
    add(locale);
    if (!useSimilar) return;
    for (const other of DISCORD_LOCALES) {
      if (base(other) === base(locale)) add(other);
    }
  };
  addWithSiblings(user);
  addWithSiblings(guild);
  addWithSiblings(defaultLocale);
  add(FALLBACK_LOCALE);
  add('en-GB');
  return out;
}
