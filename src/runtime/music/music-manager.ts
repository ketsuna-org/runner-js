import { Connectors, Constants, Shoukaku } from 'shoukaku';
import type { Node, Player, Track } from 'shoukaku';
import type { Client, Guild } from 'discord.js';

import type { LavalinkServer } from '../../config/js-bot-config.js';
import { pickBest, selectNodes, type FetchLike, type LavalinkCandidate } from './lavalink-nodes.js';
import { isLoopMode, TrackQueue, type LoopMode, type QueueTrack } from './queue.js';

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export const MUSIC_DISABLED_MESSAGE =
  'Music is not available for this bot: turn on the Lavalink music setting in the bot settings (Lavalink tab). Cloud-hosted bots also need Premium.';

/** Sans piste, le bot quitte le salon après ce délai (une session vocale oubliée coûte au serveur Lavalink). */
const IDLE_LEAVE_MS = 5 * 60_000;
/** Seul dans le salon, le bot le quitte après ce délai. */
const ALONE_LEAVE_MS = 2 * 60_000;
const NODE_READY_TIMEOUT_MS = 10_000;
const MAX_VOLUME = 200;
const MAX_SEARCH_RESULTS = 10;

const SEARCH_PREFIX: Record<string, string> = {
  youtube: 'ytsearch',
  youtubemusic: 'ytmsearch',
  soundcloud: 'scsearch',
  spotify: 'spsearch',
};

export interface TrackInfo {
  title: string;
  author: string;
  url: string | null;
  /** Durée en millisecondes (0 pour un direct). */
  duration: number;
  durationText: string;
  isStream: boolean;
  thumbnail: string | null;
  source: string;
  identifier: string;
  /** Identifiant Discord de la personne qui a demandé la piste. */
  requestedBy: string | null;
}

export interface PlayResult {
  track: TrackInfo;
  /** Vrai si la piste a été mise en file au lieu de démarrer tout de suite. */
  queued: boolean;
  /** Rang dans la file (0 = en cours de lecture). */
  position: number;
  /** Présent quand l'URL était une playlist : toutes ses pistes sont en file. */
  playlist?: { name: string; tracks: number };
}

export interface QueueInfo {
  connected: boolean;
  channelId: string | null;
  current: (TrackInfo & { positionMs: number }) | null;
  upcoming: TrackInfo[];
  loop: LoopMode;
  volume: number;
  paused: boolean;
}

export interface VoiceContext {
  guild: Guild | null | undefined;
  /** Personne qui a lancé le script, pour retrouver son salon vocal et signer les demandes. */
  userId?: string | null;
}

interface GuildState {
  queue: TrackQueue;
  player: Player;
  channelId: string;
  volume: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  aloneTimer?: ReturnType<typeof setTimeout>;
}

function formatDuration(ms: number, isStream: boolean): string {
  if (isStream) return 'LIVE';
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function toQueueTrack(track: Track, requestedBy: string | null): QueueTrack {
  const info = track.info;
  return {
    encoded: track.encoded,
    identifier: info.identifier,
    title: info.title,
    author: info.author,
    url: info.uri ?? null,
    durationMs: info.isStream ? 0 : info.length,
    isStream: info.isStream,
    thumbnail: info.artworkUrl ?? null,
    source: info.sourceName,
    requestedBy,
  };
}

function toTrackInfo(track: QueueTrack): TrackInfo {
  return {
    title: track.title,
    author: track.author,
    url: track.url,
    duration: track.durationMs,
    durationText: formatDuration(track.durationMs, track.isStream),
    isStream: track.isStream,
    thumbnail: track.thumbnail,
    source: track.source,
    identifier: track.identifier,
    requestedBy: track.requestedBy,
  };
}

/**
 * Connecteur discord.js de Shoukaku qui fonctionne aussi quand le client est DÉJÀ prêt (la musique s'initialise
 * à la première utilisation, pas au démarrage du bot : un bot gratuit ou sans musique n'écoute aucun paquet brut).
 */
class LateDiscordJsConnector extends Connectors.DiscordJS {
  private rawHandler: ((packet: unknown) => void) | null = null;

  override listen(nodes: Parameters<Connectors.DiscordJS['listen']>[0]): void {
    this.rawHandler = (packet) => this.raw(packet as Parameters<Connectors.DiscordJS['raw']>[0]);
    this.client.on('raw', this.rawHandler);
    if (this.client.isReady()) {
      this.ready(nodes);
    } else {
      this.client.once('clientReady', () => this.ready(nodes));
    }
  }

  detach(): void {
    if (this.rawHandler) {
      this.client.off('raw', this.rawHandler);
      this.rawHandler = null;
    }
  }
}

/**
 * Musique d'un bot : un client Lavalink (Shoukaku) par bot, une file par serveur Discord. Les scripts n'écrivent
 * aucun gestionnaire d'événement : la file avance seule, le bot quitte le salon quand il n'a plus rien à jouer.
 */
export class MusicManager {
  private enabled = false;
  private customServers: LavalinkServer[] = [];
  private shoukaku: Shoukaku | null = null;
  private connector: LateDiscordJsConnector | null = null;
  private starting: Promise<Shoukaku> | null = null;
  private readonly guilds = new Map<string, GuildState>();
  private disposed = false;
  private readonly onVoiceState = (_old: unknown, state: { guild: Guild }) => this.checkAlone(state.guild);

  constructor(
    private readonly client: Client,
    private readonly log: (level: LogLevel, message: string) => void,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  /** Appliquée au démarrage et à chaque rechargement de la configuration. */
  setConfig(lavalink: { enabled: boolean; custom_servers: LavalinkServer[] } | undefined): void {
    const wasEnabled = this.enabled;
    const nextServers = lavalink?.custom_servers ?? [];
    const serversChanged = JSON.stringify(nextServers) !== JSON.stringify(this.customServers);
    this.enabled = lavalink?.enabled === true;
    this.customServers = nextServers;
    if ((wasEnabled && !this.enabled) || serversChanged) {
      // Musique coupée (perte du Premium) ou serveurs changés : on repart de zéro à la prochaine demande.
      void this.reset();
    }
  }

  isEnabled(): boolean {
    return this.enabled && !this.disposed;
  }

  forContext(context: VoiceContext): VoiceApi {
    return new VoiceApi(this, context);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.reset();
  }

  private async reset(): Promise<void> {
    const shoukaku = this.shoukaku;
    const pending = this.starting;
    this.shoukaku = null;
    this.starting = null;
    this.client.off('voiceStateUpdate', this.onVoiceState);
    for (const state of this.guilds.values()) {
      clearTimeout(state.idleTimer);
      clearTimeout(state.aloneTimer);
    }
    this.guilds.clear();
    const connector = this.connector;
    this.connector = null;
    connector?.detach();
    const target = shoukaku ?? (await pending?.catch(() => null)) ?? null;
    if (!target) return;
    for (const guildId of [...target.connections.keys()]) {
      await target.leaveVoiceChannel(guildId).catch(() => undefined);
    }
    for (const name of [...target.nodes.keys()]) {
      target.removeNode(name, 'music reset');
    }
    target.removeAllListeners();
  }

  private async ensureShoukaku(): Promise<Shoukaku> {
    if (this.shoukaku) return this.shoukaku;
    if (!this.starting) {
      this.starting = this.start().catch((error) => {
        this.starting = null;
        throw error;
      });
    }
    return this.starting;
  }

  private async start(): Promise<Shoukaku> {
    const candidates = await selectNodes(this.customServers, this.fetchImpl);
    if (candidates.length === 0) {
      throw new Error('No Lavalink server is reachable right now. Try again in a moment.');
    }
    const connector = new LateDiscordJsConnector(this.client);
    const shoukaku = new Shoukaku(connector, [], {
      // Une coupure brève de la liaison avec le serveur ne doit pas arrêter la lecture : Lavalink garde les
      // lecteurs de la session pendant le délai de reprise.
      resume: true,
      resumeTimeout: 60,
      reconnectTries: 5,
      reconnectInterval: 3,
      moveOnDisconnect: true,
      restTimeout: 15_000,
      userAgent: 'bot-creator-runner-js',
      nodeResolver: (nodes) => pickNode(nodes),
    });
    shoukaku.on('error', (name, error) => this.log('warn', `[music] Lavalink node ${name}: ${error.message}`));
    shoukaku.on('disconnect', (name) => this.log('debug', `[music] Lavalink node ${name} disconnected`));
    this.connector = connector;
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('No Lavalink server answered in time.')), NODE_READY_TIMEOUT_MS);
      shoukaku.once('ready', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    for (const candidate of candidates) {
      shoukaku.addNode({
        name: `${candidate.group}:${candidate.host}:${candidate.port}`,
        url: `${candidate.host}:${candidate.port}`,
        auth: candidate.password,
        secure: candidate.secure,
        group: candidate.group,
      });
    }
    try {
      await ready;
    } catch (error) {
      connector.detach();
      for (const name of [...shoukaku.nodes.keys()]) shoukaku.removeNode(name, 'start failed');
      shoukaku.removeAllListeners();
      throw error;
    }
    this.shoukaku = shoukaku;
    this.client.on('voiceStateUpdate', this.onVoiceState);
    this.log('info', `[music] Lavalink ready (${shoukaku.nodes.size} server(s))`);
    return shoukaku;
  }

  // ---- Opérations (appelées par VoiceApi) ----

  state(guildId: string): GuildState | undefined {
    return this.guilds.get(guildId);
  }

  async join(guild: Guild, channelId: string): Promise<GuildState> {
    this.assertEnabled();
    const existing = this.guilds.get(guild.id);
    if (existing && existing.channelId === channelId) {
      return existing;
    }
    if (existing) {
      if (existing.queue.current) {
        throw new Error('The bot is already playing in another voice channel of this server.');
      }
      await this.leave(guild.id);
    }
    const channel = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null));
    if (!channel || !channel.isVoiceBased()) {
      throw new Error('This channel is not a voice channel of the server.');
    }
    const shoukaku = await this.ensureShoukaku();
    const player = await shoukaku.joinVoiceChannel({
      guildId: guild.id,
      channelId,
      shardId: guild.shardId,
      deaf: true,
    });
    const state: GuildState = { queue: new TrackQueue(), player, channelId, volume: 100 };
    this.guilds.set(guild.id, state);
    this.wirePlayer(guild.id, state);
    this.armIdle(guild.id, state);
    return state;
  }

  async leave(guildId: string): Promise<boolean> {
    const state = this.guilds.get(guildId);
    if (!state) return false;
    clearTimeout(state.idleTimer);
    clearTimeout(state.aloneTimer);
    this.guilds.delete(guildId);
    state.player.removeAllListeners();
    await this.shoukaku?.leaveVoiceChannel(guildId).catch(() => undefined);
    return true;
  }

  async search(query: string, source: string | undefined, limit: number): Promise<QueueTrack[]> {
    this.assertEnabled();
    const shoukaku = await this.ensureShoukaku();
    const node = shoukaku.getIdealNode();
    if (!node) throw new Error('No Lavalink server is connected right now.');
    const result = await node.rest.resolve(this.toIdentifier(query, source));
    if (!result || result.loadType === 'empty') return [];
    if (result.loadType === 'error') throw new Error(`Search failed: ${result.data.message ?? 'unknown error'}`);
    const tracks = result.loadType === 'track' ? [result.data] : result.loadType === 'playlist' ? result.data.tracks : result.data;
    return tracks.slice(0, limit).map((track) => toQueueTrack(track, null));
  }

  async play(
    guild: Guild,
    channelId: string,
    query: string,
    source: string | undefined,
    requestedBy: string | null,
    next: boolean,
  ): Promise<PlayResult> {
    this.assertEnabled();
    const state = await this.join(guild, channelId);
    const shoukaku = await this.ensureShoukaku();
    const node = shoukaku.getIdealNode();
    if (!node) throw new Error('No Lavalink server is connected right now.');
    const result = await node.rest.resolve(this.toIdentifier(query, source));
    if (!result || result.loadType === 'empty') throw new Error('No result for this search.');
    if (result.loadType === 'error') throw new Error(`Could not load this track: ${result.data.message ?? 'unknown error'}`);

    let tracks: Track[];
    let playlist: PlayResult['playlist'];
    if (result.loadType === 'playlist') {
      tracks = result.data.tracks;
      playlist = { name: result.data.info.name, tracks: tracks.length };
    } else if (result.loadType === 'track') {
      tracks = [result.data];
    } else {
      tracks = result.data.slice(0, 1);
    }
    if (tracks.length === 0) throw new Error('No result for this search.');

    const queued = tracks.map((track) => toQueueTrack(track, requestedBy));
    const added = state.queue.add(queued, { next });
    if (added === 0) throw new Error('The queue is full.');
    clearTimeout(state.idleTimer);
    const idle = state.queue.current === null;
    if (idle) {
      await this.startNext(guild.id, state, 'finished');
    }
    // Si la piste est devenue la piste courante, son rang est 0 ; sinon son rang dans la file.
    const first = queued[0]!;
    const position = state.queue.current === first ? 0 : state.queue.upcoming.indexOf(first) + 1;
    if (playlist) playlist = { ...playlist, tracks: added };
    return { track: toTrackInfo(first), queued: position > 0, position, ...(playlist ? { playlist } : {}) };
  }

  /** Démarre la piste suivante (ou arme le départ du salon si la file est vide). */
  private async startNext(guildId: string, state: GuildState, reason: 'finished' | 'skip'): Promise<QueueTrack | null> {
    const next = state.queue.advance(reason);
    if (!next) {
      await state.player.stopTrack().catch(() => undefined);
      this.armIdle(guildId, state);
      return null;
    }
    try {
      await state.player.playTrack({ track: { encoded: next.encoded } });
    } catch (error) {
      this.log('warn', `[music] could not start "${next.title}": ${(error as Error).message}`);
      // Piste illisible : on passe à la suivante au lieu de bloquer la file.
      return this.startNext(guildId, state, 'skip');
    }
    return next;
  }

  async skip(guildId: string): Promise<QueueTrack | null> {
    const state = this.requireState(guildId);
    if (!state.queue.current) throw new Error('Nothing is playing.');
    return this.startNext(guildId, state, 'skip');
  }

  async stop(guildId: string): Promise<void> {
    const state = this.requireState(guildId);
    state.queue.reset();
    await state.player.stopTrack();
    this.armIdle(guildId, state);
  }

  async setPaused(guildId: string, paused: boolean): Promise<void> {
    const state = this.requireState(guildId);
    if (!state.queue.current) throw new Error('Nothing is playing.');
    await state.player.setPaused(paused);
  }

  async seek(guildId: string, positionMs: number): Promise<void> {
    const state = this.requireState(guildId);
    const current = state.queue.current;
    if (!current) throw new Error('Nothing is playing.');
    if (current.isStream) throw new Error('A live stream cannot be seeked.');
    if (!Number.isFinite(positionMs) || positionMs < 0 || positionMs > current.durationMs) {
      throw new Error(`Position must be between 0 and ${current.durationMs} ms.`);
    }
    await state.player.seekTo(Math.floor(positionMs));
  }

  async setVolume(guildId: string, volume: number): Promise<number> {
    const state = this.requireState(guildId);
    if (!Number.isFinite(volume)) throw new Error('Volume must be a number between 0 and 200.');
    state.volume = Math.min(MAX_VOLUME, Math.max(0, Math.round(volume)));
    await state.player.setGlobalVolume(state.volume);
    return state.volume;
  }

  requireState(guildId: string): GuildState {
    this.assertEnabled();
    const state = this.guilds.get(guildId);
    if (!state) throw new Error('The bot is not in a voice channel of this server. Use voice.join() or voice.play() first.');
    return state;
  }

  assertEnabled(): void {
    if (!this.isEnabled()) throw new Error(MUSIC_DISABLED_MESSAGE);
  }

  private toIdentifier(query: string, source: string | undefined): string {
    const text = query.trim();
    if (!text) throw new Error('A search or a URL is required.');
    if (/^https?:\/\//i.test(text)) return text;
    const prefix = SEARCH_PREFIX[(source ?? 'youtube').toLowerCase()];
    if (!prefix) throw new Error(`Unknown source "${source}": use youtube, youtubemusic, soundcloud or spotify.`);
    return `${prefix}:${text}`;
  }

  private wirePlayer(guildId: string, state: GuildState): void {
    const { player, queue } = state;
    player.on('end', (event) => {
      // Seules les fins naturelles font avancer la file : un skip, un stop ou un remplacement l'ont déjà fait.
      if (event.reason !== 'finished' && event.reason !== 'loadFailed') return;
      if (event.track.encoded !== queue.current?.encoded) return;
      void this.startNext(guildId, state, 'finished');
    });
    player.on('stuck', (event) => {
      if (event.track.encoded !== queue.current?.encoded) return;
      this.log('warn', `[music] track stuck, skipping: ${queue.current?.title ?? 'unknown'}`);
      void this.startNext(guildId, state, 'skip');
    });
    player.on('exception', (event) => {
      this.log('warn', `[music] track error: ${event.exception.message ?? 'unknown'}`);
    });
    player.on('closed', (event) => {
      this.log('debug', `[music] voice socket closed (${event.code})`);
      // 4014 : expulsé du salon. La session ne sert plus à rien.
      if (event.code === 4014 || event.code === 4006) void this.leave(guildId);
    });
  }

  private armIdle(guildId: string, state: GuildState): void {
    clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => {
      if (!state.queue.current) void this.leave(guildId);
    }, IDLE_LEAVE_MS);
    state.idleTimer.unref?.();
  }

  private checkAlone(guild: Guild): void {
    const state = this.guilds.get(guild.id);
    if (!state) return;
    const channel = guild.channels.cache.get(state.channelId);
    const humans = channel?.isVoiceBased() ? channel.members.filter((member) => !member.user.bot).size : undefined;
    clearTimeout(state.aloneTimer);
    if (humans === 0) {
      state.aloneTimer = setTimeout(() => void this.leave(guild.id), ALONE_LEAVE_MS);
      state.aloneTimer.unref?.();
    }
  }
}

/** Serveur public le moins chargé tant qu'il tient la charge, sinon un serveur personnel (voir `pickBest`). */
function pickNode(nodes: Map<string, Node>): Node | undefined {
  const candidates = [...nodes.values()].map((node) => ({
    node,
    group: node.group,
    connected: node.state === Constants.State.CONNECTED,
    stats: node.stats,
  }));
  return pickBest(candidates)?.node;
}

/**
 * Objet `voice` des scripts, lié au serveur (et à la personne) du déclencheur. Les lectures sont synchrones,
 * les actions asynchrones (`await voice.play(...)`). Désactivée, elle répond une erreur claire.
 */
export class VoiceApi {
  constructor(
    private readonly manager: MusicManager,
    private readonly context: VoiceContext,
  ) {}

  /** Vrai si la musique est utilisable pour ce bot (Premium + réglage). */
  get enabled(): boolean {
    return this.manager.isEnabled();
  }

  private guild(): Guild {
    this.manager.assertEnabled();
    const guild = this.context.guild;
    if (!guild) throw new Error('voice can only be used in a server.');
    return guild;
  }

  private snapshotState() {
    const guild = this.context.guild;
    return guild && this.manager.isEnabled() ? this.manager.state(guild.id) : undefined;
  }

  /** Salon vocal de la personne qui a lancé le script, ou `null`. */
  private async memberChannelId(guild: Guild): Promise<string | null> {
    const userId = this.context.userId;
    if (!userId) return null;
    const cached = guild.voiceStates.cache.get(userId)?.channelId;
    if (cached) return cached;
    const fetched = await guild.voiceStates.fetch(userId).catch(() => null);
    return fetched?.channelId ?? null;
  }

  private async targetChannel(guild: Guild, channelId?: string): Promise<string> {
    const explicit = channelId?.trim();
    if (explicit) return explicit;
    const own = await this.memberChannelId(guild);
    if (own) return own;
    const current = this.manager.state(guild.id);
    if (current) return current.channelId;
    throw new Error('Join a voice channel first, or pass a channelId.');
  }

  async join(channelId?: string): Promise<{ channelId: string }> {
    const guild = this.guild();
    const target = await this.targetChannel(guild, channelId);
    const state = await this.manager.join(guild, target);
    return { channelId: state.channelId };
  }

  async leave(): Promise<boolean> {
    return this.manager.leave(this.guild().id);
  }

  async search(query: string, options: { limit?: number; source?: string } = {}): Promise<TrackInfo[]> {
    this.guild();
    const limit = Math.min(MAX_SEARCH_RESULTS, Math.max(1, Math.floor(options.limit ?? 5)));
    return (await this.manager.search(String(query), options.source, limit)).map(toTrackInfo);
  }

  async play(
    query: string,
    options: { channelId?: string; source?: string; next?: boolean } = {},
  ): Promise<PlayResult> {
    const guild = this.guild();
    const channelId = await this.targetChannel(guild, options.channelId);
    return this.manager.play(guild, channelId, String(query), options.source, this.context.userId ?? null, options.next === true);
  }

  async pause(): Promise<void> {
    await this.manager.setPaused(this.guild().id, true);
  }

  async resume(): Promise<void> {
    await this.manager.setPaused(this.guild().id, false);
  }

  /** Passe à la piste suivante ; renvoie la nouvelle piste, ou `null` si la file est terminée. */
  async skip(): Promise<TrackInfo | null> {
    const next = await this.manager.skip(this.guild().id);
    return next ? toTrackInfo(next) : null;
  }

  /** Arrête la lecture et vide la file ; le bot reste dans le salon (voice.leave() pour le quitter). */
  async stop(): Promise<void> {
    await this.manager.stop(this.guild().id);
  }

  /** Se place à `position` dans la piste en cours : en millisecondes par défaut, `'seconds'` en second argument. */
  async seek(position: number, unit: 'ms' | 'seconds' = 'ms'): Promise<void> {
    const factor = unit === 'seconds' ? 1000 : 1;
    await this.manager.seek(this.guild().id, Number(position) * factor);
  }

  /** Volume de 0 à 200 (100 = normal) ; renvoie la valeur appliquée. */
  async setVolume(volume: number): Promise<number> {
    return this.manager.setVolume(this.guild().id, Number(volume));
  }

  getVolume(): number {
    return this.snapshotState()?.volume ?? 100;
  }

  /** `off`, `track` (répète la piste) ou `queue` (répète la file). */
  setLoopMode(mode: LoopMode): LoopMode {
    const state = this.manager.requireState(this.guild().id);
    if (!isLoopMode(mode)) throw new Error('Loop mode must be "off", "track" or "queue".');
    state.queue.loop = mode;
    return mode;
  }

  getLoopMode(): LoopMode {
    return this.snapshotState()?.queue.loop ?? 'off';
  }

  getQueue(): QueueInfo {
    const state = this.snapshotState();
    if (!state) {
      return { connected: false, channelId: null, current: null, upcoming: [], loop: 'off', volume: 100, paused: false };
    }
    const current = state.queue.current;
    return {
      connected: true,
      channelId: state.channelId,
      current: current ? { ...toTrackInfo(current), positionMs: Math.floor(state.player.position) } : null,
      upcoming: state.queue.upcoming.map(toTrackInfo),
      loop: state.queue.loop,
      volume: state.volume,
      paused: state.player.paused,
    };
  }

  /** Piste en cours (avec sa position en ms), ou `null`. */
  nowPlaying(): (TrackInfo & { positionMs: number }) | null {
    return this.getQueue().current;
  }

  isConnected(): boolean {
    return this.snapshotState() !== undefined;
  }

  isPlaying(): boolean {
    const state = this.snapshotState();
    return Boolean(state?.queue.current) && !state?.player.paused;
  }

  isPaused(): boolean {
    return this.snapshotState()?.player.paused === true;
  }

  /** Retire la piste `position` (à partir de 1) de la file ; renvoie la piste retirée ou `null`. */
  remove(position: number): TrackInfo | null {
    const removed = this.manager.requireState(this.guild().id).queue.remove(Number(position));
    return removed ? toTrackInfo(removed) : null;
  }

  /** Vide les pistes à venir (la piste en cours continue) ; renvoie le nombre retiré. */
  clear(): number {
    return this.manager.requireState(this.guild().id).queue.clear();
  }

  shuffle(): void {
    this.manager.requireState(this.guild().id).queue.shuffle();
  }
}

export type { LavalinkCandidate };
