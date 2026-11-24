import { localeChain, normalizeLocale } from './locales.js';
import { MessageFormatError, ParsedMessage } from './message-format.js';

export interface TranslationResult {
  text: string;
  found: boolean;
  locale: string | null;
  warnings: string[];
}

export interface TranslateOptions {
  userLocale?: string | null;
  guildLocale?: string | null;
  forced?: string | null;
  args?: Record<string, unknown>;
}

/** Catalogue de traductions d'un bot (section `translations` du document). Port de `translation_catalog.dart`. */
export class TranslationCatalog {
  private readonly parsed = new Map<string, ParsedMessage | null>();

  constructor(private readonly keys: Map<string, Map<string, string>>) {}

  static fromDocument(raw: unknown): TranslationCatalog {
    const keys = new Map<string, Map<string, string>>();
    const doc = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const entries = doc.keys && typeof doc.keys === 'object' ? (doc.keys as Record<string, unknown>) : {};
    for (const [key, entry] of Object.entries(entries)) {
      const values = entry && typeof entry === 'object' ? (entry as Record<string, unknown>).values : undefined;
      if (!values || typeof values !== 'object') continue;
      const byLocale = new Map<string, string>();
      for (const [loc, value] of Object.entries(values as Record<string, unknown>)) {
        const locale = normalizeLocale(loc);
        const text = String(value ?? '');
        if (locale && text.trim()) byLocale.set(locale, text);
      }
      if (byLocale.size > 0) keys.set(key, byLocale);
    }
    return new TranslationCatalog(keys);
  }

  has(key: string): boolean {
    return this.keys.has(key);
  }

  get size(): number {
    return this.keys.size;
  }

  pick(key: string, chain: string[]): [string, string] | null {
    const values = this.keys.get(key);
    if (!values) return null;
    for (const locale of chain) {
      const text = values.get(locale);
      if (text !== undefined) return [text, locale];
    }
    return null;
  }

  translate(key: string, options: TranslateOptions = {}): TranslationResult {
    const chain = options.forced ? localeChain(options.forced) : localeChain(options.userLocale, options.guildLocale);
    const picked = this.pick(key, chain);
    if (!picked) {
      return {
        text: key,
        found: false,
        locale: null,
        warnings: [
          this.keys.has(key)
            ? `Translation key "${key}" has no text in any usable language.`
            : `Translation key "${key}" not found.`,
        ],
      };
    }
    const [text, locale] = picked;
    const cacheKey = `${key}\u0000${locale}`;
    let parsed = this.parsed.get(cacheKey);
    if (parsed === undefined) {
      try {
        parsed = ParsedMessage.parse(text);
      } catch (error) {
        if (!(error instanceof MessageFormatError)) throw error;
        parsed = null;
      }
      this.parsed.set(cacheKey, parsed);
    }
    if (!parsed) {
      return { text, found: true, locale, warnings: [`Translation "${key}" (${locale}) has invalid syntax; shown as is.`] };
    }
    const missing: string[] = [];
    const out = parsed.format(locale, options.args ?? {}, missing);
    return {
      text: out,
      found: true,
      locale,
      warnings: [...new Set(missing)].map((n) => `Translation "${key}" (${locale}): argument "${n}" was not provided.`),
    };
  }
}

/** `nom=valeur` est nommé, tout le reste est positionnel (`1`, `2`…). */
export function parseTranslationArguments(raw: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let position = 0;
  for (const arg of raw) {
    const m = /^([A-Za-z0-9_]+)=([\s\S]*)$/.exec(arg);
    if (m) out[m[1]!] = m[2];
    else {
      position++;
      if (!(String(position) in out)) out[String(position)] = arg;
    }
  }
  return out;
}
