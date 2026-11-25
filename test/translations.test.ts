import { describe, expect, test } from 'bun:test';
import conformance from './fixtures/translations-conformance.json';
import { createBcTranslations } from '../src/translations/bc-translations.js';
import { TranslationCatalog, parseTranslationArguments } from '../src/translations/catalog.js';
import { DISCORD_LOCALES, localeChain } from '../src/translations/locales.js';
import { MessageFormatError, ParsedMessage } from '../src/translations/message-format.js';
import { pluralCategory, requiredPluralCategories } from '../src/translations/plural-rules.js';

// Même fichier que celui de packages/shared (Dart) et du Manager : les moteurs doivent donner ces résultats.
describe('conformance des traductions', () => {
  test('les 32 locales de Discord', () => {
    expect([...DISCORD_LOCALES]).toEqual(conformance.discordLocales);
  });

  for (const c of conformance.plural) {
    test(`pluriel ${c.locale} ${c.n} → ${c.category}`, () => {
      expect(pluralCategory(c.locale, c.n)).toBe(c.category);
    });
  }

  test('catégories requises : other en dernier', () => {
    for (const l of DISCORD_LOCALES) expect(requiredPluralCategories(l).at(-1)).toBe('other');
  });

  for (const c of conformance.format) {
    test(`format ${c.message}`, () => {
      expect(ParsedMessage.parse(c.message).format(c.locale, c.args)).toBe(c.expected);
    });
  }

  for (const raw of conformance.invalid) {
    test(`invalide : ${raw}`, () => {
      expect(() => ParsedMessage.parse(raw)).toThrow(MessageFormatError);
    });
  }

  for (const c of conformance.chain) {
    test(`chaîne ${c.user} / ${c.guild}`, () => {
      expect(localeChain(c.user, c.guild, (c as { default?: string | null }).default)).toEqual(c.expected);
    });
  }

  const catalog = TranslationCatalog.fromDocument(conformance.catalog);
  for (const c of conformance.translate as Array<Record<string, any>>) {
    test(`traduire ${c.key} ${c.user}/${c.guild}/${c.forced ?? ''}`, () => {
      const r = catalog.translate(c.key, { userLocale: c.user, guildLocale: c.guild, forced: c.forced, args: c.args });
      expect(r.text).toBe(c.text);
      expect(r.found).toBe(c.found);
      expect(r.locale).toBe(c.locale);
    });
  }

  const catalogDefault = TranslationCatalog.fromDocument(conformance.catalogDefault);
  test('langue par défaut lue', () => expect(catalogDefault.defaultLocale).toBe('fr'));
  for (const c of conformance.translateDefault as Array<Record<string, any>>) {
    test(`traduire (défaut fr) ${c.key} ${c.user}/${c.guild}/${c.forced ?? ''}`, () => {
      const r = catalogDefault.translate(c.key, { userLocale: c.user, guildLocale: c.guild, forced: c.forced, args: c.args });
      expect(r.text).toBe(c.text);
      expect(r.found).toBe(c.found);
      expect(r.locale).toBe(c.locale);
    });
  }

  for (const c of conformance.arguments) {
    test(`arguments ${JSON.stringify(c.raw)}`, () => {
      expect(parseTranslationArguments(c.raw)).toEqual(c.expected);
    });
  }
});

describe('bc.t', () => {
  const config = { translations: conformance.catalog };
  test('langue de la personne, du serveur, anglais', () => {
    const fr = createBcTranslations({ config, interaction: { locale: 'fr', guildLocale: 'de' } });
    expect(fr.t('shop.bought', { user: 'Bob', item: 'Épée' })).toBe('Bob a acheté Épée');
    expect(fr.locale).toBe('fr');
    expect(fr.guildLocale).toBe('de');
    const ja = createBcTranslations({ config, interaction: { locale: 'ja' } });
    expect(ja.t('shop.bought', { user: 'Bob', item: 'X' })).toBe('Bob bought X');
  });
  test('arguments positionnels, t.in, t.has, pluriel', () => {
    const bc = createBcTranslations({ config: { translations: { keys: { p: { values: { en: '{1} has {2}' } } } } } });
    expect(bc.t('p', 'Bob', 3)).toBe('Bob has 3');
    expect(createBcTranslations({ config }).t.in('fr', 'shop.bought', { user: 'A', item: 'B' })).toBe('A a acheté B');
    expect(createBcTranslations({ config }).t.has('shop.items')).toBe(true);
    expect(createBcTranslations({ config, interaction: { locale: 'pl' } }).t('shop.items', { n: 5 })).toBe('5 przedmiotów');
  });
  test('clé absente : la clé et un avertissement', () => {
    const warnings: string[] = [];
    const bc = createBcTranslations({ config }, (m) => warnings.push(m));
    expect(bc.t('nope')).toBe('nope');
    expect(warnings[0]).toContain('not found');
  });
  test('les valeurs ne sont pas ré-interprétées', () => {
    const bc = createBcTranslations({ config: { translations: { keys: { h: { values: { en: 'Hi {name}' } } } } } });
    expect(bc.t('h', { name: '{name} #' })).toBe('Hi {name} #');
  });
});
