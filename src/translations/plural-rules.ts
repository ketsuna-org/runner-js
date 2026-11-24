import { FALLBACK_LOCALE, normalizeLocale } from './locales.js';

export type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';

interface Operands {
  n: number;
  i: number;
  v: number;
  f: number;
  t: number;
}

function parseOperands(text: string): Operands | null {
  const m = /^\s*[-+]?(\d{1,15})(?:\.(\d{1,15}))?\s*$/.exec(text);
  if (!m) return null;
  const whole = Number(m[1]);
  const frac = m[2] ?? '';
  const f = frac ? Number(frac) : 0;
  const trimmed = frac.replace(/0+$/, '');
  const t = trimmed ? Number(trimmed) : 0;
  const n = Number(`${m[1]}${frac ? `.${frac}` : ''}`);
  return { n, i: whole, v: frac.length, f, t };
}

const within = (x: number, lo: number, hi: number): boolean => x >= lo && x <= hi;
const million = (o: Operands): boolean => o.i !== 0 && o.i % 1_000_000 === 0 && o.v === 0;

const ONE_OTHER: PluralCategory[] = ['one', 'other'];
const ONE_MANY_OTHER: PluralCategory[] = ['one', 'many', 'other'];
const ONE_FEW_OTHER: PluralCategory[] = ['one', 'few', 'other'];
const SLAVIC: PluralCategory[] = ['one', 'few', 'many', 'other'];
const OTHER_ONLY: PluralCategory[] = ['other'];

/** Catégories qu'une langue utilise, dans l'ordre de CLDR. */
export const PLURAL_CATEGORIES: Record<string, PluralCategory[]> = {
  id: OTHER_ONLY, vi: OTHER_ONLY, th: OTHER_ONLY, ja: OTHER_ONLY, ko: OTHER_ONLY, 'zh-CN': OTHER_ONLY, 'zh-TW': OTHER_ONLY,
  da: ONE_OTHER, de: ONE_OTHER, 'en-GB': ONE_OTHER, 'en-US': ONE_OTHER, nl: ONE_OTHER, no: ONE_OTHER, fi: ONE_OTHER,
  'sv-SE': ONE_OTHER, hu: ONE_OTHER, tr: ONE_OTHER, el: ONE_OTHER, bg: ONE_OTHER, hi: ONE_OTHER,
  fr: ONE_MANY_OTHER, it: ONE_MANY_OTHER, 'es-ES': ONE_MANY_OTHER, 'es-419': ONE_MANY_OTHER, 'pt-BR': ONE_MANY_OTHER,
  hr: ONE_FEW_OTHER, ro: ONE_FEW_OTHER,
  pl: SLAVIC, ru: SLAVIC, uk: SLAVIC, cs: SLAVIC, lt: SLAVIC,
};

export function requiredPluralCategories(locale: string): PluralCategory[] {
  return PLURAL_CATEGORIES[normalizeLocale(locale) ?? ''] ?? OTHER_ONLY;
}

/** Catégorie de pluriel de [value] (un nombre écrit en texte) dans [locale]. Non numérique : `other`. */
export function pluralCategory(locale: string, value: string): PluralCategory {
  const o = parseOperands(value);
  if (!o) return 'other';
  const code = normalizeLocale(locale) ?? FALLBACK_LOCALE;
  const lang = code.split('-')[0];
  switch (lang) {
    case 'id': case 'vi': case 'th': case 'ja': case 'ko': case 'zh':
      return 'other';
    case 'de': case 'en': case 'nl': case 'sv': case 'fi':
      return o.i === 1 && o.v === 0 ? 'one' : 'other';
    case 'da':
      return o.n === 1 || (o.t !== 0 && (o.i === 0 || o.i === 1)) ? 'one' : 'other';
    case 'no': case 'hu': case 'tr': case 'el': case 'bg':
      return o.n === 1 ? 'one' : 'other';
    case 'hi':
      return o.i === 0 || o.n === 1 ? 'one' : 'other';
    case 'fr': case 'pt':
      if (o.i === 0 || o.i === 1) return 'one';
      return million(o) ? 'many' : 'other';
    case 'es':
      if (o.n === 1) return 'one';
      return million(o) ? 'many' : 'other';
    case 'it':
      if (o.i === 1 && o.v === 0) return 'one';
      return million(o) ? 'many' : 'other';
    case 'hr':
      if ((o.v === 0 && o.i % 10 === 1 && o.i % 100 !== 11) || (o.f % 10 === 1 && o.f % 100 !== 11)) return 'one';
      if (
        (o.v === 0 && within(o.i % 10, 2, 4) && !within(o.i % 100, 12, 14)) ||
        (within(o.f % 10, 2, 4) && !within(o.f % 100, 12, 14))
      ) {
        return 'few';
      }
      return 'other';
    case 'ro':
      if (o.i === 1 && o.v === 0) return 'one';
      if (o.v !== 0 || o.n === 0 || (o.n !== 1 && within(Math.trunc(o.n) % 100, 1, 19))) return 'few';
      return 'other';
    case 'ru': case 'uk':
      if (o.v === 0 && o.i % 10 === 1 && o.i % 100 !== 11) return 'one';
      if (o.v === 0 && within(o.i % 10, 2, 4) && !within(o.i % 100, 12, 14)) return 'few';
      if (o.v === 0 && (o.i % 10 === 0 || within(o.i % 10, 5, 9) || within(o.i % 100, 11, 14))) return 'many';
      return 'other';
    case 'pl':
      if (o.i === 1 && o.v === 0) return 'one';
      if (o.v === 0 && within(o.i % 10, 2, 4) && !within(o.i % 100, 12, 14)) return 'few';
      if (
        o.v === 0 &&
        ((o.i !== 1 && within(o.i % 10, 0, 1)) || within(o.i % 10, 5, 9) || within(o.i % 100, 12, 14))
      ) {
        return 'many';
      }
      return 'other';
    case 'cs':
      if (o.i === 1 && o.v === 0) return 'one';
      if (within(o.i, 2, 4) && o.v === 0) return 'few';
      if (o.v !== 0) return 'many';
      return 'other';
    case 'lt': {
      const whole = o.f === 0 && o.v === 0;
      const mod10 = o.n % 10;
      const mod100 = o.n % 100;
      if (whole && mod10 === 1 && !(mod100 >= 11 && mod100 <= 19)) return 'one';
      if (whole && mod10 >= 2 && mod10 <= 9 && !(mod100 >= 11 && mod100 <= 19)) return 'few';
      if (o.f !== 0) return 'many';
      return 'other';
    }
    default:
      return 'other';
  }
}
