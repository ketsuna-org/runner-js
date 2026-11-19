import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import {
  CONSENT_TEXT_VERSION,
  ConsentStore,
  REFERENCE_TEXT,
  renderPrompt,
  validateLocaleTexts,
} from '../src/runtime/voice/consent.js';
import { VoiceRecorderManager, voiceRecorderDisabled, type RecorderDeps } from '../src/runtime/voice/voice-recorder.js';

const GUILD_VOICE_STATES = 128;

function memoryDb() {
  const data = new Map<string, unknown>();
  const k = (...parts: string[]) => parts.join('|');
  return {
    data,
    getScopedVariable: async (b: string, s: string, c: string, key: string) => data.get(k(b, s, c, key)),
    setScopedVariable: async (b: string, s: string, c: string, key: string, v: unknown) => void data.set(k(b, s, c, key), v),
    removeScopedVariable: async (b: string, s: string, c: string, key: string) => void data.delete(k(b, s, c, key)),
  } as never;
}

async function consent(store: ConsentStore, userId: string, external = false) {
  await store.set('g1', userId, { at: Date.now(), version: CONSENT_TEXT_VERSION, locale: '', hash: 'h', external });
}

function fixture(options: { intents?: number; meChannelId?: string | null; announceFails?: boolean; members?: string[] } = {}) {
  const sent: Array<string | { content: string }> = [];
  const subscribed: string[] = [];
  const speaking = new EventEmitter();
  const connection = Object.assign(new EventEmitter(), {
    receiver: {
      speaking,
      subscribe: (userId: string) => {
        subscribed.push(userId);
        return new PassThrough();
      },
    },
    destroy: () => undefined,
  });
  const members = new Map((options.members ?? ['u1']).map((id) => [id, { id, user: { bot: false } }]));
  const channels = new Map<string, unknown>([
    ['voice1', { isVoiceBased: () => true, members }],
    ['text1', {
      isVoiceBased: () => false,
      isTextBased: () => true,
      send: async (message: string | { content: string }) => {
        if (options.announceFails) throw new Error('no permission');
        sent.push(message);
        return { id: `m${sent.length}` };
      },
    }],
  ]);
  const guild = {
    id: 'g1',
    voiceAdapterCreator: () => undefined,
    members: { me: { voice: { channelId: options.meChannelId ?? null } }, cache: new Map(), fetch: async () => null },
    channels: { cache: channels, fetch: async () => null },
  };
  const client = Object.assign(new EventEmitter(), {
    options: { intents: options.intents ?? GUILD_VOICE_STATES },
    guilds: { cache: new Map([['g1', guild]]) },
  });
  const store = new ConsentStore(memoryDb(), 'bot1');
  const deps = { join: (() => connection) as unknown as RecorderDeps['join'], waitReady: async () => undefined };
  const manager = new VoiceRecorderManager(client as never, () => undefined, store, deps, false);
  return { manager, guild: guild as never, client, store, sent, subscribed, speaking };
}

const base = { channelId: 'voice1', announceChannelId: 'text1' };
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const textOf = (m: string | { content: string }) => (typeof m === 'string' ? m : m.content);

describe('consentement', () => {
  it('une traduction doit être complète', () => {
    expect(() => validateLocaleTexts({ title: 'Titre' })).toThrow('complete');
    const full = Object.fromEntries(Object.keys(REFERENCE_TEXT).map((key) => [key, `fr ${key}`]));
    expect(validateLocaleTexts({ ...full, accept: "J'accepte" }).accept).toBe("J'accepte");
    expect(() => validateLocaleTexts({ ...full, accept: 'x'.repeat(81) })).toThrow('label');
  });

  it('affiche l anglais d abord, puis la langue demandée', () => {
    const full = Object.fromEntries(Object.keys(REFERENCE_TEXT).map((key) => [key, `fr ${key}`]));
    const rendered = renderPrompt('fr', { fr: validateLocaleTexts(full) });
    expect(rendered.content.startsWith(`**${REFERENCE_TEXT.title}**`)).toBe(true);
    expect(rendered.content).toContain('— FR —');
    expect(renderPrompt('de', {}).locale).toBe('');
  });

  it('expire après 6 mois ou quand la version du texte change', async () => {
    let now = Date.now();
    const store = new ConsentStore(memoryDb(), 'b', () => now);
    await store.set('g', 'u', { at: now, version: CONSENT_TEXT_VERSION, locale: '', hash: '', external: false });
    expect(await store.valid('g', 'u')).not.toBeNull();
    now += 184 * 86_400_000;
    expect(await store.valid('g', 'u')).toBeNull();
    await store.set('g', 'u2', { at: now, version: 'old', locale: '', hash: '', external: false });
    expect(await store.valid('g', 'u2')).toBeNull();
  });
});

describe('VoiceRecorderManager', () => {
  it('refuse sans annonce, sans intent, si le bot est déjà en vocal ou si personne n a consenti', async () => {
    const f = fixture();
    await expect(f.manager.start(f.guild, { ...base, announceChannelId: '' })).rejects.toThrow('announceChannelId');
    await expect(f.manager.start(f.guild, base)).rejects.toThrow('Nobody in this voice channel');
    const noIntent = fixture({ intents: 1 });
    await expect(noIntent.manager.start(noIntent.guild, base)).rejects.toThrow('Guild Voice States');
    const busy = fixture({ meChannelId: 'other' });
    await expect(busy.manager.start(busy.guild, base)).rejects.toThrow('already in a voice channel');
  });

  it('n enregistre rien si l annonce échoue', async () => {
    const f = fixture({ announceFails: true });
    await consent(f.store, 'u1');
    await expect(f.manager.start(f.guild, base)).rejects.toThrow('announcement');
    expect(f.manager.status('g1').active).toBe(false);
  });

  it('n écoute que les personnes consentantes et coupe l écoute au retrait', async () => {
    const f = fixture({ members: ['u1', 'u2'] });
    await consent(f.store, 'u1');
    const started = await f.manager.start(f.guild, base);
    expect(started.recordedUserIds).toEqual(['u1']);
    expect(textOf(f.sent[0]!)).toContain('Recording started');
    expect(textOf(f.sent[0]!)).toContain('<@u1>');
    expect(textOf(f.sent[0]!)).not.toContain('<@u2>');
    expect(JSON.stringify((f.sent[0] as { components?: unknown }).components)).toContain('bcvc:withdraw');
    f.speaking.emit('start', 'u2'); // pas de consentement : jamais abonné
    f.speaking.emit('start', 'stranger');
    f.speaking.emit('start', 'u1');
    await tick();
    expect(f.subscribed).toEqual(['u1']);
    expect(f.manager.status('g1').recordingUserIds).toEqual(['u1']);
    await f.manager.withdraw('g1', 'u1');
    expect(f.manager.status('g1').recordingUserIds).toEqual([]);
    expect(await f.manager.hasConsent('g1', 'u1')).toBe(false);
    f.speaking.emit('start', 'u1'); // retiré : plus jamais d'écoute
    await tick();
    expect(f.subscribed).toEqual(['u1']);
    await expect(f.manager.start(f.guild, base)).rejects.toThrow('already running');
    const result = await f.manager.stop('g1');
    expect(result.reason).toBe('stopped');
    expect(textOf(f.sent[1]!)).toContain('Recording stopped');
    expect(f.manager.status('g1').active).toBe(false);
  });

  it('les boutons enregistrent et retirent le consentement de la personne qui clique', async () => {
    const f = fixture();
    const replies: Array<{ content: string; ephemeral: boolean }> = [];
    const click = (action: string) =>
      f.client.emit('interactionCreate', {
        isButton: () => true,
        customId: `bcvc:${action}`,
        guildId: 'g1',
        user: { id: 'u7' },
        locale: 'en-US',
        reply: async (o: { content: string; ephemeral: boolean }) => void replies.push(o),
      });
    click('external');
    await tick();
    const record = await f.store.valid('g1', 'u7');
    expect(record?.external).toBe(true);
    expect(replies[0]!.ephemeral).toBe(true);
    click('withdraw');
    await tick();
    expect(await f.store.valid('g1', 'u7')).toBeNull();
    expect(replies[1]!.content).toBe(REFERENCE_TEXT.withdrawn);
  });

  it('poste le message de consentement et refuse une langue sans traduction complète', async () => {
    const f = fixture();
    const posted = await f.manager.consentPrompt(f.guild, { channelId: 'text1' });
    expect(posted.messageId).toBe('m1');
    expect(textOf(f.sent[0]!)).toContain(REFERENCE_TEXT.title);
    await expect(f.manager.consentPrompt(f.guild, { channelId: 'text1', locale: 'fr' })).rejects.toThrow('translation');
    await expect(f.manager.consentPrompt(f.guild, { channelId: 'text1', locale: 'fr', texts: { title: 'x' } })).rejects.toThrow('complete');
  });

  it('est désactivable par le drapeau', async () => {
    const f = fixture();
    const off = new VoiceRecorderManager(f.client as never, () => undefined, f.store, undefined, true);
    await expect(off.start(f.guild, base)).rejects.toThrow('disabled');
  });

  it('est coupée par défaut, activée seulement par VOICE_RECORDER_ENABLED=1, coupe-circuit prioritaire', () => {
    expect(voiceRecorderDisabled({})).toBe(true);
    expect(voiceRecorderDisabled({ VOICE_RECORDER_ENABLED: '0' })).toBe(true);
    expect(voiceRecorderDisabled({ VOICE_RECORDER_ENABLED: '1' })).toBe(false);
    expect(voiceRecorderDisabled({ VOICE_RECORDER_ENABLED: '1', VOICE_RECORDER_DISABLED: '1' })).toBe(true);
  });
});
