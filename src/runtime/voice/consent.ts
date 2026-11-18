import { createHash } from 'node:crypto';

import type { VariableDatabase } from '../variable-database.js';

/** Version du texte de référence (anglais). À changer à chaque modification : les consentements plus anciens expirent. */
export const CONSENT_TEXT_VERSION = '2026-11-18.1';

/** Validité d'un consentement en jours (183 = 6 mois). `0` = sans limite. Réglable par VOICE_CONSENT_VALID_DAYS. */
export function consentValidDays(): number {
  const raw = Number(process.env.VOICE_CONSENT_VALID_DAYS);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 183;
}

export const MANDATORY_BLOCKS = ['title', 'purpose', 'retention', 'rights', 'external', 'accepted', 'withdrawn'] as const;
export const LABEL_KEYS = ['accept', 'acceptExternal', 'withdraw'] as const;
export type BlockKey = (typeof MANDATORY_BLOCKS)[number];
export type LabelKey = (typeof LABEL_KEYS)[number];
export type ConsentBlocks = Record<BlockKey, string> & Partial<Record<LabelKey, string>>;

/** Texte de référence : toujours affiché, jamais remplaçable. */
export const REFERENCE_TEXT: Record<BlockKey, string> = {
  title: 'Voice recording consent',
  purpose:
    'This server\'s bot can record the voice of people who agree, in voice channels. Your voice is recorded as an audio file, one track per person, only while a recording is announced in a text channel. Recordings may be shared in this server.',
  retention:
    'Recordings are kept only as long as the server owner decides and are never kept longer than the limits of the service. Your agreement is valid for 6 months and is then asked again.',
  rights:
    'You can withdraw your agreement at any time with the "Withdraw my consent" button: recording of your voice stops immediately. You can ask the server owner to access or delete your recordings. If you do not agree, nothing about you is recorded.',
  external:
    'The second button also lets this server\'s bot send your recordings to an external service (for example a transcription service) chosen by the server owner. This is optional.',
  accepted: 'Thank you. Your agreement is saved for this server.',
  withdrawn: 'Your agreement is withdrawn. Your voice will not be recorded.',
};

export const REFERENCE_LABELS: Record<LabelKey, string> = {
  accept: 'I agree',
  acceptExternal: 'I also agree to external processing',
  withdraw: 'Withdraw my consent',
};

const MAX_BLOCK = 1000;
const MAX_LABEL = 80;
const MAX_LOCALES = 10;

/** Une langue est acceptée avec TOUS les blocs obligatoires ou pas du tout. Renvoie les blocs nettoyés. */
export function validateLocaleTexts(texts: unknown): ConsentBlocks {
  if (!texts || typeof texts !== 'object') throw new Error('texts must be an object.');
  const input = texts as Record<string, unknown>;
  const out: Record<string, string> = {};
  const missing: string[] = [];
  for (const key of MANDATORY_BLOCKS) {
    const value = typeof input[key] === 'string' ? (input[key] as string).trim() : '';
    if (!value) missing.push(key);
    else if (value.length > MAX_BLOCK) throw new Error(`The "${key}" text is longer than ${MAX_BLOCK} characters.`);
    else out[key] = value;
  }
  if (missing.length > 0) {
    throw new Error(`A translation must be complete. Missing: ${missing.join(', ')}.`);
  }
  for (const key of LABEL_KEYS) {
    const raw = input[key];
    if (raw === undefined || raw === null || raw === '') continue;
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value || value.length > MAX_LABEL) throw new Error(`The "${key}" label must be 1 to ${MAX_LABEL} characters.`);
    out[key] = value;
  }
  return out as ConsentBlocks;
}

export function normalizeLocale(locale: unknown): string {
  const value = typeof locale === 'string' ? locale.trim().toLowerCase().split(/[-_]/)[0] ?? '' : '';
  return /^[a-z]{2,3}$/.test(value) ? value : '';
}

export interface RenderedPrompt {
  content: string;
  labels: Record<LabelKey, string>;
  locale: string;
  hash: string;
}

/** Message public : l'anglais d'abord, puis la langue demandée si une traduction complète existe. */
export function renderPrompt(locale: string, translations: Record<string, ConsentBlocks>): RenderedPrompt {
  const local = locale ? translations[locale] : undefined;
  const block = (b: Record<BlockKey, string>): string =>
    `**${b.title}**\n${b.purpose}\n${b.retention}\n${b.rights}\n${b.external}`;
  const content = local ? `${block(REFERENCE_TEXT)}\n\n— ${locale.toUpperCase()} —\n${block(local as Record<BlockKey, string>)}` : block(REFERENCE_TEXT);
  const labels = { ...REFERENCE_LABELS, ...Object.fromEntries(LABEL_KEYS.filter((k) => local?.[k]).map((k) => [k, local![k]!])) } as Record<LabelKey, string>;
  const hash = createHash('sha256').update(`${CONSENT_TEXT_VERSION}\n${content}`).digest('hex');
  return { content, labels, locale: local ? locale : '', hash };
}

export interface ConsentRecord {
  at: number;
  version: string;
  locale: string;
  hash: string;
  external: boolean;
}

const RECORD_KEY = '__bc_voice_consent';
const TEXTS_KEY = '__bc_voice_consent_texts';

/** Consentements persistants, par bot, serveur et personne (magasin de variables du runner). */
export class ConsentStore {
  constructor(
    private readonly db: VariableDatabase,
    private readonly botId: string,
    private readonly now: () => number = Date.now,
  ) {}

  async get(guildId: string, userId: string): Promise<ConsentRecord | null> {
    const raw = await this.db.getScopedVariable(this.botId, 'guildMember', `${guildId}:${userId}`, RECORD_KEY);
    if (!raw || typeof raw !== 'object') return null;
    const record = raw as ConsentRecord;
    if (typeof record.at !== 'number') return null;
    return record;
  }

  /** Valide : version courante du texte et pas expiré. */
  async valid(guildId: string, userId: string): Promise<ConsentRecord | null> {
    const record = await this.get(guildId, userId);
    if (!record || record.version !== CONSENT_TEXT_VERSION) return null;
    const days = consentValidDays();
    if (days > 0 && this.now() - record.at > days * 86_400_000) return null;
    return record;
  }

  async set(guildId: string, userId: string, record: ConsentRecord): Promise<void> {
    await this.db.setScopedVariable(this.botId, 'guildMember', `${guildId}:${userId}`, RECORD_KEY, record);
  }

  async remove(guildId: string, userId: string): Promise<void> {
    await this.db.removeScopedVariable(this.botId, 'guildMember', `${guildId}:${userId}`, RECORD_KEY);
  }

  async translations(guildId: string): Promise<Record<string, ConsentBlocks>> {
    const raw = await this.db.getScopedVariable(this.botId, 'guild', guildId, TEXTS_KEY);
    return raw && typeof raw === 'object' ? (raw as Record<string, ConsentBlocks>) : {};
  }

  /** Enregistre une traduction complète (validée) pour la langue ; les clics de boutons y puisent. */
  async saveTranslation(guildId: string, locale: string, texts: unknown): Promise<ConsentBlocks> {
    const clean = validateLocaleTexts(texts);
    const all = await this.translations(guildId);
    if (!(locale in all) && Object.keys(all).length >= MAX_LOCALES) throw new Error(`At most ${MAX_LOCALES} languages.`);
    all[locale] = clean;
    await this.db.setScopedVariable(this.botId, 'guild', guildId, TEXTS_KEY, all);
    return clean;
  }
}
