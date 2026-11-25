import { describe, expect, test } from 'bun:test';
import conformance from './fixtures/command-localizations-conformance.json';
import { toDiscordCommand } from '../src/discord/command-registerer.js';
import { DISCORD_LOCALES } from '../src/translations/locales.js';
import {
  buildLocalizedPayloadFields,
  commandLocalizationsToJson,
  issueKey,
  normalizeCommandLocalizations,
  parseCommandLocalizations,
  validateCommandLocalizations,
  type CommandKind,
} from '../src/translations/command-localizations.js';
import { commandHandlerSchema } from '../src/config/js-bot-config.js';

// Même fichier que celui de packages/shared (Dart) et du Manager : les trois moteurs valident et construisent la
// charge utile Discord de la même façon.
describe('conformance des traductions de commandes', () => {
  test('les 32 locales de Discord', () => {
    expect([...DISCORD_LOCALES]).toEqual(conformance.discordLocales);
  });

  for (const c of conformance.validate) {
    test(`validation : ${c.name}`, () => {
      const siblings = ((c as { siblings?: { name: string; nameLocalizations?: Record<string, string> }[] }).siblings ?? []);
      const got = validateCommandLocalizations(
        c.kind as CommandKind,
        c.command as Record<string, unknown>,
        parseCommandLocalizations(c.localizations),
        siblings,
      ).map(issueKey).sort();
      expect(got).toEqual([...c.issues].sort());
    });
  }

  for (const c of conformance.payload) {
    test(`charge utile : ${c.name}`, () => {
      const built = buildLocalizedPayloadFields(
        c.kind as CommandKind,
        c.command as Record<string, unknown>,
        parseCommandLocalizations(c.localizations),
      );
      expect(JSON.parse(JSON.stringify(built))).toEqual(c.expected);
    });
  }

  for (const c of conformance.normalize) {
    test(`lecture et écriture : ${c.name}`, () => {
      const json = normalizeCommandLocalizations(c.raw);
      expect(JSON.parse(JSON.stringify(json))).toEqual(c.expected);
      expect(commandLocalizationsToJson(parseCommandLocalizations(json))).toEqual(json);
    });
  }
});

// La charge utile réellement construite par le runner (`toDiscordCommand`) porte les mêmes traductions que la
// conformance : on la projette sur les clés que la conformance décrit.
function project(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(project);
  if (typeof value !== 'object' || value === null) return value;
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of ['name', 'description', 'name_localizations', 'description_localizations', 'value']) {
    if (key in src) out[key] = src[key];
  }
  for (const key of ['options', 'choices']) if (key in src) out[key] = project(src[key]);
  return out;
}

describe('toDiscordCommand', () => {
  for (const c of conformance.payload) {
    test(`charge utile envoyée : ${c.name}`, () => {
      const command = c.command as Record<string, unknown>;
      const data = { ...((command.data as Record<string, unknown>) ?? {}), localizations: c.localizations };
      const handler = commandHandlerSchema.parse({
        id: c.name,
        script: '',
        name: command.name,
        description: command.description ?? '',
        discordType: command.type === 'message' ? 'message' : command.type === 'user' ? 'user' : 'chatInput',
        options: data.options ?? [],
        data,
      });
      expect(project(toDiscordCommand(handler))).toEqual(c.expected);
    });
  }

  test('une commande sans traduction ne porte aucun champ de localisation', () => {
    const handler = commandHandlerSchema.parse({ id: 'a', script: '', name: 'ping', description: 'Ping', options: [] });
    expect(JSON.stringify(toDiscordCommand(handler))).not.toContain('_localizations');
  });

  test('une traduction change la signature d\'enregistrement', () => {
    const base = { id: 'a', script: '', name: 'ping', description: 'Ping', options: [] };
    const without = toDiscordCommand(commandHandlerSchema.parse(base));
    const withLoc = toDiscordCommand(commandHandlerSchema.parse({ ...base, data: { localizations: { name: { fr: 'pong' } } } }));
    expect(JSON.stringify(withLoc)).not.toBe(JSON.stringify(without));
  });
});
