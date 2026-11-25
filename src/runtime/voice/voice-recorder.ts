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
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  type Client,
  type Guild,
  type Interaction,
} from 'discord.js';

import {
  CONSENT_TEXT_VERSION,
    REFERENCE_LABELS,
  REFERENCE_TEXT,
  type ConsentStore,
  normalizeLocale,
  renderPrompt,
} from './consent.js';
import { OggOpusMuxer } from './ogg-opus.js';
import { getVoiceQuotaGateway, type VoiceQuotaGateway, type VoiceQuotaStatus } from './voice-quota.js';
import { clientHasGuildVoiceStatesIntent } from '../../discord/discord-client-options.js';

/**
 * Enregistrement vocal EXPÉRIMENTAL (staging seulement, voir DESIGN-flux-vocal.md).
 *
 * Règles non négociables, appliquées ici et non dans le script :
 *  - seules les personnes qui ont donné leur consentement (bouton du message standard, valable 6 mois,
 *    mémorisé par serveur) sont enregistrées : l'audio des autres n'est jamais lu. Un script ne peut pas
 *    consentir à la place de quelqu'un ;
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
  /** Durée maximale en secondes (300 par défaut, 600 au plus) : l'enregistrement s'arrête seul. */
  maxSeconds?: number;
}

export interface RecordedTrack {
  userId: string;
  name: string;
  bytes: number;
  /** Vrai si la personne a aussi accepté l'envoi à un service externe : à vérifier avant tout envoi HTTP. */
  externalConsent: boolean;
  /** Pièce prête pour `channel.send({ files: [track.file] })`. */
  file: { attachment: Buffer; name: string };
}

export interface RecordingResult {
  id: string;
  channelId: string;
  durationMs: number;
  reason: 'stopped' | 'max-duration' | 'quota' | 'connection-lost';
  tracks: RecordedTrack[];
}

export interface RecorderStatus {
  active: boolean;
  id?: string;
  channelId?: string;
  startedAt?: number;
  recordingUserIds: string[];
}

type LogFn = (level: 'info' | 'warn' | 'error' | 'debug', message: string) => void;

interface TrackWriter {
  userId: string;
  external: boolean;
  path: string;
  name: string;
  done: Promise<void>;
  packets: number;
  /** Termine proprement : le muxer écrit sa dernière page et la fin de flux (l'audio déjà reçu est conservé). */
  end: () => void;
}

interface Session {
  id: string;
  guildId: string;
  channelId: string;
  announceChannelId: string;
  startedAt: number;
  dir: string;
  connection: VoiceConnection;
  /** Cache court des consentements lus dans le magasin (personne -> expiration du cache, externe). */
  consentCache: Map<string, { until: number; ok: boolean; external: boolean }>;
  writers: Map<string, TrackWriter>;
  allWriters: TrackWriter[];
  timer: ReturnType<typeof setTimeout>;
  /** Réservation faite auprès du Manager (quota mensuel) ; absente sans Manager. */
  quotaSessionId?: string;
  /** Raison de l'arrêt à l'échéance : « quota » quand le quota restant a raccourci la durée demandée. */
  limitReason: 'max-duration' | 'quota';
  onSpeaking: (userId: string) => void;
  stopping?: Promise<RecordingResult>;
}

/** Dépendances remplaçables en test (aucun réseau). */
export interface RecorderDeps {
  join: typeof joinVoiceChannel;
  waitReady: (connection: VoiceConnection) => Promise<unknown>;
  /** Quota du Manager (Premium, heures mensuelles). Null/absent : pas de Manager, pas de quota. */
  quota?: () => VoiceQuotaGateway | null;
  botId?: string;
}

export function defaultRecorderDeps(botId: string): RecorderDeps {
  return {
    join: joinVoiceChannel,
    waitReady: (connection) => entersState(connection, VoiceConnectionStatus.Ready, 20_000),
    quota: getVoiceQuotaGateway,
    botId,
  };
}

const defaultDeps: RecorderDeps = defaultRecorderDeps('');

function clean(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

const CONSENT_CACHE_MS = 15_000;
const BUTTON_PREFIX = 'bcvc';

/**
 * L'enregistrement vocal est EXPÉRIMENTAL (ni réserve Premium ni quota) : il est coupé par défaut et ne
 * s'active que si l'environnement le demande (`VOICE_RECORDER_ENABLED=1`, staging). `VOICE_RECORDER_DISABLED=1`
 * reste un coupe-circuit qui l'emporte.
 */
export function voiceRecorderDisabled(env: Record<string, string | undefined> = process.env): boolean {
  if (env.VOICE_RECORDER_DISABLED === '1') return true;
  return env.VOICE_RECORDER_ENABLED !== '1';
}

export class VoiceRecorderManager {
  private readonly sessions = new Map<string, Session>();
  private disposed = false;
  private readonly onInteraction = (interaction: Interaction): void => {
    if (interaction.isButton() && interaction.customId.startsWith(`${BUTTON_PREFIX}:`)) {
      void this.handleButton(interaction).catch((error) =>
        this.log('warn', `[recorder] consent button failed: ${error instanceof Error ? error.message : String(error)}`),
      );
    }
  };

  constructor(
    private readonly client: Client,
    private readonly log: LogFn,
    private readonly store: ConsentStore,
    private readonly deps: RecorderDeps = defaultDeps,
    private readonly disabled: boolean = voiceRecorderDisabled(),
  ) {
    if (!this.disabled) client.on('interactionCreate', this.onInteraction);
  }

  forGuild(guild: Guild | null | undefined, userId?: string | null): VoiceRecorderApi {
    return new VoiceRecorderApi(this, guild ?? null, userId ?? null);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.client.off('interactionCreate', this.onInteraction);
    for (const guildId of [...this.sessions.keys()]) {
      await this.stop(guildId).catch(() => undefined);
    }
  }

  status(guildId: string): RecorderStatus {
    const session = this.sessions.get(guildId);
    if (!session) return { active: false, recordingUserIds: [] };
    return {
      active: true,
      id: session.id,
      channelId: session.channelId,
      startedAt: session.startedAt,
      recordingUserIds: [...session.writers.keys()],
    };
  }

  // ---- Consentement (permanent, par serveur, donné uniquement par la personne) ----

  async hasConsent(guildId: string, userId: string): Promise<boolean> {
    return (await this.store.valid(guildId, userId)) !== null;
  }

  /** Retire l'accord : la personne elle-même, ou quelqu'un qui peut gérer le serveur (vérifié par l'appelant). */
  async withdraw(guildId: string, userId: string): Promise<void> {
    const id = clean(userId);
    if (!id) throw new Error('userId is required.');
    await this.store.remove(guildId, id);
    const session = this.sessions.get(guildId);
    if (session) {
      session.consentCache.set(id, { until: Date.now() + CONSENT_CACHE_MS, ok: false, external: false });
      session.writers.get(id)?.end(); // l'écoute s'arrête immédiatement, l'audio d'avant le retrait est conservé
      session.writers.delete(id);
    }
  }

  /** Poste le message standard (anglais d'abord, puis la traduction complète demandée) avec ses boutons. */
  async consentPrompt(
    guild: Guild,
    options: { channelId: string; locale?: string; texts?: unknown },
  ): Promise<{ messageId: string }> {
    if (this.disabled || this.disposed) throw new Error('The voice recorder is disabled.');
    const channelId = clean(options?.channelId);
    const channel = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null));
    if (!channel || !channel.isTextBased() || typeof (channel as { send?: unknown }).send !== 'function') {
      throw new Error('channelId is not a text channel the bot can write in.');
    }
    const locale = normalizeLocale(options.locale);
    if (options.texts !== undefined) {
      if (!locale) throw new Error('locale is required with texts (for example "fr").');
      await this.store.saveTranslation(guild.id, locale, options.texts);
    }
    const translations = await this.store.translations(guild.id);
    if (locale && !translations[locale]) {
      throw new Error(`No complete translation is saved for "${locale}": pass texts with every block.`);
    }
    const rendered = renderPrompt(locale, translations);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${BUTTON_PREFIX}:accept`).setLabel(rendered.labels.accept).setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`${BUTTON_PREFIX}:external`)
        .setLabel(rendered.labels.acceptExternal)
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`${BUTTON_PREFIX}:withdraw`).setLabel(rendered.labels.withdraw).setStyle(ButtonStyle.Danger),
    );
    const sent = await (channel as unknown as { send: (m: unknown) => Promise<{ id: string }> }).send({
      content: rendered.content,
      components: [row],
    });
    this.log('info', `[recorder] consent prompt posted in ${channelId} (hash ${rendered.hash.slice(0, 12)})`);
    return { messageId: sent.id };
  }

  private async handleButton(interaction: Interaction & { customId: string; guildId: string | null; user: { id: string }; locale?: string }): Promise<void> {
    const action = interaction.customId.split(':')[1];
    const guildId = interaction.guildId;
    const reply = (interaction as unknown as { reply: (o: unknown) => Promise<unknown> }).reply.bind(interaction);
    if (!guildId || (action !== 'accept' && action !== 'external' && action !== 'withdraw')) {
      await reply({ content: 'This button only works in a server.', ephemeral: true });
      return;
    }
    const translations = await this.store.translations(guildId);
    const locale = normalizeLocale(interaction.locale);
    const mine = locale ? translations[locale] : undefined;
    // La preuve garde le texte réellement montré (anglais, plus la langue du message si elle existe).
    const rendered = renderPrompt(mine ? locale : '', translations);
    if (action === 'withdraw') {
      await this.withdraw(guildId, interaction.user.id);
      await reply({ content: mine?.withdrawn ?? REFERENCE_TEXT.withdrawn, ephemeral: true });
      return;
    }
    await this.store.set(guildId, interaction.user.id, {
      at: Date.now(),
      version: CONSENT_TEXT_VERSION,
      locale: rendered.locale,
      hash: rendered.hash,
      external: action === 'external',
    });
    const session = this.sessions.get(guildId);
    session?.consentCache.delete(interaction.user.id);
    await reply({ content: mine?.accepted ?? REFERENCE_TEXT.accepted, ephemeral: true });
  }

  // ---- Enregistrement ----

  async start(
    guild: Guild,
    options: RecorderStartOptions,
  ): Promise<{ id: string; channelId: string; recordedUserIds: string[]; maxSeconds: number; quotaLimited: boolean }> {
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

    // Seules les personnes déjà dans le salon avec un consentement valide comptent au départ.
    const present = [...(channel.members?.values?.() ?? [])].filter((m) => !m.user?.bot).map((m) => m.id);
    const consenting: string[] = [];
    for (const userId of present) {
      if (await this.hasConsent(guild.id, userId)) consenting.push(userId);
    }
    if (consenting.length === 0) {
      throw new Error(
        'Nobody in this voice channel has an active consent. Post the consent message with bc.recorder.consentPrompt() and ask people to press "I agree".',
      );
    }

    // Quota du compte (Manager) : Premium, heures du mois, sessions simultanées. Réservé AVANT de rejoindre le salon ;
    // la durée accordée peut être plus courte que celle demandée (quota restant). Échoue fermé si le Manager ne répond pas.
    const gateway = this.deps.quota?.() ?? null;
    let quotaSessionId: string | undefined;
    let limitReason: Session['limitReason'] = 'max-duration';
    let grantedSeconds = seconds;
    if (gateway) {
      const grant = await gateway.reserve(this.deps.botId ?? '', guild.id, seconds);
      quotaSessionId = grant.sessionId;
      if (grant.grantedSeconds < seconds) {
        grantedSeconds = grant.grantedSeconds;
        limitReason = 'quota';
      }
    }
    const releaseQuota = (): void => {
      if (gateway && quotaSessionId) void this.reportUsage(gateway, quotaSessionId, 0);
    };

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
      releaseQuota();
      throw new Error('Could not join the voice channel (DAVE handshake or permissions). Check Connect permission.');
    }

    // L'annonce précède toute écoute : si elle échoue, rien n'est enregistré.
    const names = consenting.slice(0, MAX_RECORDED_SPEAKERS).map((u) => `<@${u}>`).join(', ');
    try {
      await (announce as unknown as { send: (m: unknown) => Promise<unknown> }).send({
        content: `🔴 **Recording started** in <#${channelId}>. Being recorded (they agreed): ${names}. Everyone else is not recorded. Anyone can withdraw their consent at any time with the button of the consent message: recording of their voice stops immediately. The recording stops automatically after ${Math.round((grantedSeconds / 60) * 10) / 10} min${limitReason === 'quota' ? ' (the monthly recording quota of this server\'s bot owner is almost used up)' : ''}.`,
        allowedMentions: { parse: [] },
        // Retrait en un clic, en pleine session, sans dépendre d'un ancien message.
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`${BUTTON_PREFIX}:withdraw`).setLabel(REFERENCE_LABELS.withdraw).setStyle(ButtonStyle.Danger),
          ),
        ],
      });
    } catch {
      connection.destroy();
      await rm(dir, { recursive: true, force: true });
      releaseQuota();
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
      consentCache: new Map(),
      writers: new Map(),
      allWriters: [],
      quotaSessionId,
      limitReason,
      timer: setTimeout(() => void this.stop(guild.id, limitReason).catch(() => undefined), grantedSeconds * 1000),
      onSpeaking: () => undefined,
    };
    session.onSpeaking = (userId) => void this.listen(session, userId).catch(() => undefined);
    connection.receiver.speaking.on('start', session.onSpeaking);
    // Diagnostic (borné) : transitions DAVE/MLS et échecs de déchiffrement, visibles dans les journaux du bot.
    let diagnostics = 0;
    connection.on('debug', (message: string) => {
      if (diagnostics < 40 && /dave|mls|epoch|transition|decrypt|fail|error|ssrc/i.test(message)) {
        diagnostics++;
        this.log('info', `[recorder] voice debug: ${message.slice(0, 200)}`);
      }
    });
    connection.receiver.speaking.on('start', (userId: string) =>
      this.log('info', `[recorder] speaking event for ${userId}`),
    );
    connection.on('stateChange', (_old, next) => {
      if (next.status === VoiceConnectionStatus.Destroyed || next.status === VoiceConnectionStatus.Disconnected) {
        if (this.sessions.get(guild.id) === session) void this.stop(guild.id, 'connection-lost').catch(() => undefined);
      }
    });
    this.sessions.set(guild.id, session);
    this.log('info', `[recorder] ${id} started in ${channelId} (${consenting.length} consenting present, max ${grantedSeconds}s)`);
    return {
      id,
      channelId,
      recordedUserIds: consenting.slice(0, MAX_RECORDED_SPEAKERS),
      maxSeconds: grantedSeconds,
      quotaLimited: limitReason === 'quota',
    };
  }

  /** Rapporte la durée réellement enregistrée au Manager (une nouvelle tentative) ; sinon la durée réservée compte. */
  private async reportUsage(gateway: VoiceQuotaGateway, sessionId: string, usedSeconds: number): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await gateway.finish(this.deps.botId ?? '', sessionId, usedSeconds);
        return;
      } catch (error) {
        if (attempt === 1) {
          this.log('warn', `[recorder] could not report the recording time to the platform: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }

  /** Quota mensuel restant du compte (Manager) ; null sans Manager. */
  async quota(): Promise<VoiceQuotaStatus | null> {
    const gateway = this.deps.quota?.() ?? null;
    return gateway ? gateway.quota(this.deps.botId ?? '') : null;
  }

  /** Consentement valide, avec un cache de 15 s pour ne pas interroger le magasin à chaque rafale de parole. */
  private async consentOf(session: Session, userId: string): Promise<{ ok: boolean; external: boolean }> {
    const cached = session.consentCache.get(userId);
    if (cached && cached.until > Date.now()) return cached;
    const record = await this.store.valid(session.guildId, userId);
    const entry = { until: Date.now() + CONSENT_CACHE_MS, ok: record !== null, external: record?.external === true };
    session.consentCache.set(userId, entry);
    return entry;
  }

  private async listen(session: Session, userId: string): Promise<void> {
    if (session.writers.has(userId) || session.stopping) return;
    const consent = await this.consentOf(session, userId);
    if (!consent.ok) return; // aucun abonnement : l'audio n'est pas lu
    if (session.writers.has(userId) || session.stopping) return;
    if (session.writers.size >= MAX_RECORDED_SPEAKERS) return;
    const name = `${userId}-${session.allWriters.length + 1}.ogg`;
    const path = join(session.dir, name);
    const opus = session.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 1500 },
    });
    const ogg = new OggOpusMuxer(2);
    const file = createWriteStream(path);
    const writer: TrackWriter = {
      userId,
      external: consent.external,
      path,
      name,
      packets: 0,
      done: Promise.resolve(),
      end: () => {
        // Fin propre du flux (et non destroy) : rien de ce qui est déjà reçu n'est perdu.
        if (!opus.destroyed && !opus.readableEnded) opus.push(null);
      },
    };
    opus.on('data', () => {
      writer.packets++;
    });
    writer.done = new Promise<void>((resolve) => {
      pipeline(opus, ogg, file, (error) => {
        if (error && (error as NodeJS.ErrnoException).code !== 'ERR_STREAM_PREMATURE_CLOSE') {
          this.log('warn', `[recorder] track ${name}: ${error.message}`);
        }
        this.log('info', `[recorder] track ${name} closed: ${writer.packets} Opus packet(s)`);
        if (session.writers.get(userId) === writer) session.writers.delete(userId);
        resolve();
      });
    });
    session.writers.set(userId, writer);
    session.allWriters.push(writer);
    this.log('info', `[recorder] ${userId} is speaking, listening (consent ok)`);
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
    for (const writer of session.writers.values()) writer.end();
    await Promise.all(session.allWriters.map((w) => w.done));
    try {
      session.connection.destroy();
    } catch {
      // déjà détruite
    }
    this.sessions.delete(session.guildId);
    const gateway = this.deps.quota?.() ?? null;
    if (gateway && session.quotaSessionId) {
      await this.reportUsage(gateway, session.quotaSessionId, Math.ceil((Date.now() - session.startedAt) / 1000));
    }

    const tracks: RecordedTrack[] = [];
    for (const writer of session.allWriters) {
      if (writer.packets <= 0) continue; // aucun paquet audio reçu : pas de piste vide
      const bytes = (await stat(writer.path).catch(() => null))?.size ?? 0;
      if (bytes <= 0) continue;
      const buffer = await readFile(writer.path);
      tracks.push({
        userId: writer.userId,
        name: writer.name,
        bytes,
        externalConsent: writer.external,
        file: { attachment: buffer, name: writer.name },
      });
    }
    await rm(session.dir, { recursive: true, force: true }); // rien ne reste sur le disque du pod

    const guild = this.client.guilds.cache.get(session.guildId);
    const announce = guild?.channels.cache.get(session.announceChannelId) as { send?: (m: string) => Promise<unknown> } | undefined;
    await announce?.send?.(`⏹️ **Recording stopped** (${reason === 'stopped' ? 'by request' : reason}).`).catch(() => undefined);
    this.log('info', `[recorder] ${session.id} stopped (${reason}), ${tracks.length} track(s)`);
    return { id: session.id, channelId: session.channelId, durationMs: Date.now() - session.startedAt, reason, tracks };
  }
}

/** `bc.recorder` des scripts, lié au serveur et à la personne du déclencheur. */
export class VoiceRecorderApi {
  constructor(
    private readonly manager: VoiceRecorderManager,
    private readonly guild: Guild | null,
    private readonly triggerUserId: string | null,
  ) {}

  private requireGuild(): Guild {
    if (!this.guild) throw new Error('recorder can only be used in a server.');
    return this.guild;
  }

  start(
    options: RecorderStartOptions,
  ): Promise<{ id: string; channelId: string; recordedUserIds: string[]; maxSeconds: number; quotaLimited: boolean }> {
    return this.manager.start(this.requireGuild(), options);
  }

  stop(): Promise<RecordingResult> {
    return this.manager.stop(this.requireGuild().id);
  }

  /** Poste le message de consentement standard (anglais), avec en plus une traduction complète si `locale` + `texts`. */
  consentPrompt(channelId: string, options?: { locale?: string; texts?: unknown }): Promise<{ messageId: string }> {
    return this.manager.consentPrompt(this.requireGuild(), { channelId, ...options });
  }

  /** Lecture seule : un script ne peut JAMAIS donner le consentement d'une personne. */
  hasConsent(userId: string): Promise<boolean> {
    return this.manager.hasConsent(this.requireGuild().id, clean(userId));
  }

  /** Retire l'accord : la personne elle-même, ou quelqu'un avec la permission « Gérer le serveur ». */
  async withdraw(userId: string): Promise<void> {
    const guild = this.requireGuild();
    const target = clean(userId);
    const actor = this.triggerUserId;
    if (!actor) throw new Error('withdraw needs a person who triggered the script.');
    if (actor !== target) {
      const member = guild.members.cache.get(actor) ?? (await guild.members.fetch(actor).catch(() => null));
      if (!member?.permissions?.has(PermissionFlagsBits.ManageGuild)) {
        throw new Error('Only the person themself or a member who can manage the server can withdraw this consent.');
      }
    }
    await this.manager.withdraw(guild.id, target);
  }

  status(): RecorderStatus {
    return this.manager.status(this.requireGuild().id);
  }

  /** Quota mensuel du compte : `null` sans Manager (self-host), sinon secondes utilisées et restantes. */
  quota(): Promise<VoiceQuotaStatus | null> {
    return this.manager.quota();
  }
}
