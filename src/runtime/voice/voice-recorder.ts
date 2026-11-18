import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream';

import {
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
  joinVoiceChannel,
  type VoiceConnection,
} from '@discordjs/voice';
import type { Client, Guild } from 'discord.js';

import { OggOpusMuxer } from './ogg-opus.js';
import { clientHasGuildVoiceStatesIntent } from '../../discord/discord-client-options.js';

/**
 * Enregistrement vocal EXPÉRIMENTAL (staging seulement, voir DESIGN-flux-vocal.md).
 *
 * Règles non négociables, appliquées ici et non dans le script :
 *  - seules les personnes qui ont donné leur consentement sont enregistrées : l'audio des autres n'est
 *    jamais lu (aucun abonnement au flux de la personne) ;
 *  - une annonce est envoyée dans un salon textuel au démarrage et à l'arrêt, impossible à désactiver ;
 *  - durée bornée, nombre de personnes borné, fichiers temporaires effacés dès la lecture ;
 *  - une seule connexion vocale par serveur : refus si le bot est déjà dans un salon (musique incluse).
 */

export const MAX_RECORDING_SECONDS = 600;
export const DEFAULT_RECORDING_SECONDS = 300;
export const MAX_RECORDED_SPEAKERS = 5;

export interface RecorderStartOptions {
  /** Salon vocal à enregistrer. */
  channelId: string;
  /** Salon textuel où l'annonce est publiée (obligatoire). */
  announceChannelId: string;
  /** Personnes déjà consentantes ; d'autres peuvent s'ajouter avec `consent()` pendant la session. */
  consentUserIds?: string[];
  /** Durée maximale en secondes (300 par défaut, 600 au plus) : l'enregistrement s'arrête seul. */
  maxSeconds?: number;
}

export interface RecordedTrack {
  userId: string;
  name: string;
  bytes: number;
  /** Pièce prête pour `channel.send({ files: [track.file] })`. */
  file: { attachment: Buffer; name: string };
}

export interface RecordingResult {
  id: string;
  channelId: string;
  durationMs: number;
  reason: 'stopped' | 'max-duration' | 'connection-lost';
  tracks: RecordedTrack[];
}

export interface RecorderStatus {
  active: boolean;
  id?: string;
  channelId?: string;
  startedAt?: number;
  consentUserIds: string[];
  recordingUserIds: string[];
}

type LogFn = (level: 'info' | 'warn' | 'error' | 'debug', message: string) => void;

interface TrackWriter {
  userId: string;
  path: string;
  name: string;
  done: Promise<void>;
  destroy: () => void;
}

interface Session {
  id: string;
  guildId: string;
  channelId: string;
  announceChannelId: string;
  startedAt: number;
  dir: string;
  connection: VoiceConnection;
  consent: Set<string>;
  writers: Map<string, TrackWriter>;
  allWriters: TrackWriter[];
  timer: ReturnType<typeof setTimeout>;
  onSpeaking: (userId: string) => void;
  stopping?: Promise<RecordingResult>;
}

/** Dépendances remplaçables en test (aucun réseau). */
export interface RecorderDeps {
  join: typeof joinVoiceChannel;
  waitReady: (connection: VoiceConnection) => Promise<unknown>;
}

const defaultDeps: RecorderDeps = {
  join: joinVoiceChannel,
  waitReady: (connection) => entersState(connection, VoiceConnectionStatus.Ready, 20_000),
};

function clean(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

export class VoiceRecorderManager {
  private readonly sessions = new Map<string, Session>();
  private disposed = false;

  constructor(
    private readonly client: Client,
    private readonly log: LogFn,
    private readonly deps: RecorderDeps = defaultDeps,
    private readonly disabled: boolean = process.env.VOICE_RECORDER_DISABLED === '1',
  ) {}

  forGuild(guild: Guild | null | undefined): VoiceRecorderApi {
    return new VoiceRecorderApi(this, guild ?? null);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const guildId of [...this.sessions.keys()]) {
      await this.stop(guildId).catch(() => undefined);
    }
  }

  status(guildId: string): RecorderStatus {
    const session = this.sessions.get(guildId);
    if (!session) return { active: false, consentUserIds: [], recordingUserIds: [] };
    return {
      active: true,
      id: session.id,
      channelId: session.channelId,
      startedAt: session.startedAt,
      consentUserIds: [...session.consent],
      recordingUserIds: [...session.writers.keys()],
    };
  }

  async start(guild: Guild, options: RecorderStartOptions): Promise<{ id: string; channelId: string }> {
    if (this.disabled || this.disposed) throw new Error('The voice recorder is disabled.');
    if (this.sessions.has(guild.id)) throw new Error('A recording is already running on this server.');
    if (!clientHasGuildVoiceStatesIntent(this.client)) {
      throw new Error('Turn on the "Guild Voice States" intent of the bot to record voice.');
    }
    const channelId = clean(options?.channelId);
    const announceChannelId = clean(options?.announceChannelId);
    if (!channelId) throw new Error('channelId is required.');
    if (!announceChannelId) {
      throw new Error('announceChannelId is required: the recording must be announced in a text channel.');
    }
    const consent = new Set((options.consentUserIds ?? []).map(clean).filter(Boolean));
    if (consent.size === 0) {
      throw new Error('consentUserIds is required: nobody is recorded without their consent.');
    }
    if (consent.size > MAX_RECORDED_SPEAKERS) {
      throw new Error(`At most ${MAX_RECORDED_SPEAKERS} people can be recorded at once.`);
    }
    const seconds = Math.min(
      MAX_RECORDING_SECONDS,
      Math.max(5, Math.floor(Number(options.maxSeconds ?? DEFAULT_RECORDING_SECONDS)) || DEFAULT_RECORDING_SECONDS),
    );

    const channel = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null));
    if (!channel || !channel.isVoiceBased()) throw new Error('This channel is not a voice channel of the server.');
    const announce = guild.channels.cache.get(announceChannelId) ?? (await guild.channels.fetch(announceChannelId).catch(() => null));
    if (!announce || !announce.isTextBased() || typeof (announce as { send?: unknown }).send !== 'function') {
      throw new Error('announceChannelId is not a text channel the bot can write in.');
    }
    if (guild.members.me?.voice?.channelId) {
      throw new Error('The bot is already in a voice channel of this server (music or another recording).');
    }

    const id = `rec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const dir = await mkdtemp(join(tmpdir(), 'bc-voice-'));
    const connection = this.deps.join({
      channelId,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false, // obligatoire pour recevoir
      selfMute: true,
    });
    try {
      await this.deps.waitReady(connection);
    } catch {
      connection.destroy();
      await rm(dir, { recursive: true, force: true });
      throw new Error('Could not join the voice channel (DAVE handshake or permissions). Check Connect permission.');
    }

    // L'annonce précède toute écoute : si elle échoue, rien n'est enregistré.
    try {
      await (announce as unknown as { send: (m: string) => Promise<unknown> }).send(
        `🔴 **Recording started** in <#${channelId}>. Only people who gave their consent are recorded (${[...consent]
          .map((u) => `<@${u}>`)
          .join(', ')}). Everyone else's audio is ignored. The recording stops automatically after ${Math.round(seconds / 60 * 10) / 10} min.`,
      );
    } catch {
      connection.destroy();
      await rm(dir, { recursive: true, force: true });
      throw new Error('Could not post the recording announcement: nothing was recorded.');
    }

    const session: Session = {
      id,
      guildId: guild.id,
      channelId,
      announceChannelId,
      startedAt: Date.now(),
      dir,
      connection,
      consent,
      writers: new Map(),
      allWriters: [],
      timer: setTimeout(() => void this.stop(guild.id, 'max-duration').catch(() => undefined), seconds * 1000),
      onSpeaking: () => undefined,
    };
    session.onSpeaking = (userId) => this.listen(session, userId);
    connection.receiver.speaking.on('start', session.onSpeaking);
    connection.on('stateChange', (_old, next) => {
      if (next.status === VoiceConnectionStatus.Destroyed || next.status === VoiceConnectionStatus.Disconnected) {
        if (this.sessions.get(guild.id) === session) void this.stop(guild.id, 'connection-lost').catch(() => undefined);
      }
    });
    this.sessions.set(guild.id, session);
    this.log('info', `[recorder] ${id} started in ${channelId} (${consent.size} consenting, max ${seconds}s)`);
    return { id, channelId };
  }

  consent(guildId: string, userId: string, granted: boolean): void {
    const session = this.sessions.get(guildId);
    if (!session) throw new Error('No recording is running on this server.');
    const user = clean(userId);
    if (!user) throw new Error('userId is required.');
    if (granted) {
      if (!session.consent.has(user) && session.consent.size >= MAX_RECORDED_SPEAKERS) {
        throw new Error(`At most ${MAX_RECORDED_SPEAKERS} people can be recorded at once.`);
      }
      session.consent.add(user);
    } else {
      session.consent.delete(user);
      // Retrait du consentement : l'écoute de la personne s'arrête immédiatement.
      session.writers.get(user)?.destroy();
      session.writers.delete(user);
    }
  }

  private listen(session: Session, userId: string): void {
    if (!session.consent.has(userId)) return; // aucun abonnement : l'audio n'est pas lu
    if (session.writers.has(userId)) return;
    const name = `${userId}-${session.allWriters.length + 1}.ogg`;
    const path = join(session.dir, name);
    const opus = session.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 1500 },
    });
    const ogg = new OggOpusMuxer(2);
    const file = createWriteStream(path);
    const done = new Promise<void>((resolve) => {
      pipeline(opus, ogg, file, (error) => {
        if (error && (error as NodeJS.ErrnoException).code !== 'ERR_STREAM_PREMATURE_CLOSE') {
          this.log('warn', `[recorder] track ${name}: ${error.message}`);
        }
        if (session.writers.get(userId) === writer) session.writers.delete(userId);
        resolve();
      });
    });
    const writer: TrackWriter = { userId, path, name, done, destroy: () => opus.destroy() };
    session.writers.set(userId, writer);
    session.allWriters.push(writer);
  }

  async stop(guildId: string, reason: RecordingResult['reason'] = 'stopped'): Promise<RecordingResult> {
    const session = this.sessions.get(guildId);
    if (!session) throw new Error('No recording is running on this server.');
    session.stopping ??= this.finish(session, reason);
    return session.stopping;
  }

  private async finish(session: Session, reason: RecordingResult['reason']): Promise<RecordingResult> {
    clearTimeout(session.timer);
    session.connection.receiver.speaking.off('start', session.onSpeaking);
    for (const writer of session.writers.values()) writer.destroy();
    await Promise.all(session.allWriters.map((w) => w.done));
    try {
      session.connection.destroy();
    } catch {
      // déjà détruite
    }
    this.sessions.delete(session.guildId);

    const tracks: RecordedTrack[] = [];
    for (const writer of session.allWriters) {
      const bytes = (await stat(writer.path).catch(() => null))?.size ?? 0;
      if (bytes <= 0) continue;
      const buffer = await readFile(writer.path);
      tracks.push({ userId: writer.userId, name: writer.name, bytes, file: { attachment: buffer, name: writer.name } });
    }
    await rm(session.dir, { recursive: true, force: true }); // rien ne reste sur le disque du pod

    const guild = this.client.guilds.cache.get(session.guildId);
    const announce = guild?.channels.cache.get(session.announceChannelId) as { send?: (m: string) => Promise<unknown> } | undefined;
    await announce?.send?.(`⏹️ **Recording stopped** (${reason === 'stopped' ? 'by request' : reason}).`).catch(() => undefined);
    this.log('info', `[recorder] ${session.id} stopped (${reason}), ${tracks.length} track(s)`);
    return { id: session.id, channelId: session.channelId, durationMs: Date.now() - session.startedAt, reason, tracks };
  }
}

/** `bc.recorder` des scripts, lié au serveur du déclencheur. */
export class VoiceRecorderApi {
  constructor(
    private readonly manager: VoiceRecorderManager,
    private readonly guild: Guild | null,
  ) {}

  private requireGuild(): Guild {
    if (!this.guild) throw new Error('recorder can only be used in a server.');
    return this.guild;
  }

  start(options: RecorderStartOptions): Promise<{ id: string; channelId: string }> {
    return this.manager.start(this.requireGuild(), options);
  }

  stop(): Promise<RecordingResult> {
    return this.manager.stop(this.requireGuild().id);
  }

  /** Ajoute (ou retire, avec `false`) le consentement d'une personne pendant la session. */
  consent(userId: string, granted = true): void {
    this.manager.consent(this.requireGuild().id, userId, granted !== false);
  }

  status(): RecorderStatus {
    return this.manager.status(this.requireGuild().id);
  }
}
