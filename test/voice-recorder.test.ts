import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { VoiceRecorderManager, type RecorderDeps } from '../src/runtime/voice/voice-recorder.js';

const GUILD_VOICE_STATES = 128;

function fixture(options: { intents?: number; meChannelId?: string | null; announceFails?: boolean } = {}) {
  const sent: string[] = [];
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
  const channels = new Map<string, unknown>([
    ['voice1', { isVoiceBased: () => true }],
    ['text1', {
      isVoiceBased: () => false,
      isTextBased: () => true,
      send: async (message: string) => {
        if (options.announceFails) throw new Error('no permission');
        sent.push(message);
      },
    }],
  ]);
  const guild = {
    id: 'g1',
    voiceAdapterCreator: () => undefined,
    members: { me: { voice: { channelId: options.meChannelId ?? null } } },
    channels: { cache: channels, fetch: async () => null },
  };
  const client = {
    options: { intents: options.intents ?? GUILD_VOICE_STATES },
    guilds: { cache: new Map([['g1', guild]]) },
  };
  const deps = { join: (() => connection) as unknown as RecorderDeps['join'], waitReady: async () => undefined };
  const manager = new VoiceRecorderManager(client as never, () => undefined, deps, false);
  return { manager, guild: guild as never, sent, subscribed, speaking };
}

const base = { channelId: 'voice1', announceChannelId: 'text1', consentUserIds: ['u1'] };

describe('VoiceRecorderManager', () => {
  it('refuse sans consentement, sans annonce, sans intent ou si le bot est déjà en vocal', async () => {
    const f = fixture();
    await expect(f.manager.start(f.guild, { ...base, consentUserIds: [] })).rejects.toThrow('consentUserIds');
    await expect(f.manager.start(f.guild, { ...base, announceChannelId: '' })).rejects.toThrow('announceChannelId');
    await expect(f.manager.start(f.guild, { ...base, consentUserIds: ['1', '2', '3', '4', '5', '6'] })).rejects.toThrow('At most');
    const noIntent = fixture({ intents: 1 });
    await expect(noIntent.manager.start(noIntent.guild, base)).rejects.toThrow('Guild Voice States');
    const busy = fixture({ meChannelId: 'other' });
    await expect(busy.manager.start(busy.guild, base)).rejects.toThrow('already in a voice channel');
  });

  it('n enregistre rien si l annonce échoue', async () => {
    const f = fixture({ announceFails: true });
    await expect(f.manager.start(f.guild, base)).rejects.toThrow('announcement');
    expect(f.manager.status('g1').active).toBe(false);
  });

  it('annonce, n écoute que les personnes consentantes et annonce l arrêt', async () => {
    const f = fixture();
    const started = await f.manager.start(f.guild, base);
    expect(started.channelId).toBe('voice1');
    expect(f.sent[0]).toContain('Recording started');
    f.speaking.emit('start', 'stranger'); // sans consentement : jamais abonné
    f.speaking.emit('start', 'u1');
    expect(f.subscribed).toEqual(['u1']);
    f.manager.consent('g1', 'u2', true);
    f.speaking.emit('start', 'u2');
    expect(f.subscribed).toEqual(['u1', 'u2']);
    f.manager.consent('g1', 'u2', false);
    expect(f.manager.status('g1').consentUserIds).toEqual(['u1']);
    await expect(f.manager.start(f.guild, base)).rejects.toThrow('already running');
    const result = await f.manager.stop('g1');
    expect(result.reason).toBe('stopped');
    expect(result.tracks).toEqual([]); // flux vides : aucun fichier
    expect(f.sent[1]).toContain('Recording stopped');
    expect(f.manager.status('g1').active).toBe(false);
  });

  it('est désactivable par le drapeau', async () => {
    const f = fixture();
    const off = new VoiceRecorderManager({ options: { intents: GUILD_VOICE_STATES } } as never, () => undefined, undefined, true);
    await expect(off.start(f.guild, base)).rejects.toThrow('disabled');
  });
});
