import type { LavalinkServer } from '../../config/js-bot-config.js';

/** Liste publique communautaire : la même que l'application et le runner Dart. */
export const PUBLIC_LAVALINK_LIST_URL = 'https://lavalink-list.ajieblogs.eu.org/All';

const LIST_TTL_MS = 5 * 60_000;
const PROBE_TIMEOUT_MS = 2_500;
/** Nombre de serveurs publics gardés (les plus rapides) : au-delà, seuls des connexions inutiles. */
const MAX_PUBLIC_NODES = 3;

export interface LavalinkCandidate extends LavalinkServer {
  label: string;
  group: 'public' | 'custom';
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

let cachedList: { at: number; entries: LavalinkCandidate[] } | null = null;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Entrées v4 de la liste publique (les v3 ne parlent pas le protocole REST `/v4`). */
export function parsePublicList(raw: unknown): LavalinkCandidate[] {
  if (!Array.isArray(raw)) return [];
  const out: LavalinkCandidate[] = [];
  for (const item of raw) {
    const entry = asRecord(item);
    if (!entry) continue;
    const version = String(entry.version ?? 'v4').trim().toLowerCase();
    const host = String(entry.host ?? '').trim();
    if (version !== 'v4' || !host) continue;
    const port = Number.parseInt(String(entry.port ?? '2333'), 10);
    out.push({
      host,
      port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 2333,
      password: String(entry.password ?? ''),
      secure: entry.secure === true,
      label: String(entry.identifier ?? '') || host,
      group: 'public',
    });
  }
  return out;
}

export async function fetchPublicList(fetchImpl: FetchLike = fetch, now: () => number = Date.now): Promise<LavalinkCandidate[]> {
  if (cachedList && now() - cachedList.at < LIST_TTL_MS) {
    return cachedList.entries;
  }
  try {
    const response = await fetchImpl(PUBLIC_LAVALINK_LIST_URL, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS * 2) });
    if (!response.ok) return cachedList?.entries ?? [];
    const entries = parsePublicList(await response.json());
    cachedList = { at: now(), entries };
    return entries;
  } catch {
    return cachedList?.entries ?? [];
  }
}

export function resetPublicListCache(): void {
  cachedList = null;
}

/** Latence (ms) du serveur, ou null s'il ne répond pas dans le budget : `GET /version` authentifié. */
export async function probeNode(
  candidate: LavalinkServer,
  fetchImpl: FetchLike = fetch,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<number | null> {
  const started = performance.now();
  try {
    const url = `${candidate.secure ? 'https' : 'http'}://${candidate.host}:${candidate.port}/version`;
    const response = await fetchImpl(url, {
      headers: { Authorization: candidate.password },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok ? performance.now() - started : null;
  } catch {
    return null;
  }
}

/**
 * Serveurs à utiliser : les publics joignables les plus rapides, puis les serveurs personnels (repli, gardés
 * sans sondage : l'utilisateur les a choisis). Ne lève jamais ; liste vide = musique indisponible.
 */
export async function selectNodes(
  custom: LavalinkServer[],
  fetchImpl: FetchLike = fetch,
): Promise<LavalinkCandidate[]> {
  const personal: LavalinkCandidate[] = custom.map((server) => ({
    ...server,
    label: server.host,
    group: 'custom',
  }));
  const publicEntries = await fetchPublicList(fetchImpl);
  const probes = publicEntries.map(async (entry) => ({ entry, ms: await probeNode(entry, fetchImpl) }));
  // Chaque sondage porte son propre délai : le total reste borné sans minuterie supplémentaire.
  const settled = await Promise.all(probes);
  const alive = settled
    .filter((probe): probe is { entry: LavalinkCandidate; ms: number } => probe.ms !== null)
    .sort((a, b) => a.ms - b.ms)
    .slice(0, MAX_PUBLIC_NODES)
    .map((probe) => probe.entry);
  return [...alive, ...personal];
}

/** Statistiques d'un nœud telles que Lavalink les publie (tout est facultatif tant que le nœud n'en a pas envoyé). */
export interface NodeLoad {
  playingPlayers?: number;
  cpu?: { systemLoad?: number } | null;
  frameStats?: { deficit?: number; nulled?: number } | null;
}

/** Au-delà, un serveur saute déjà (images perdues, processeur saturé) : on lui préfère un autre. */
export const DEGRADED_PENALTY = 400;

/**
 * Pénalité de charge d'un nœud, la formule de Lavalink : joueurs en lecture, charge système, images
 * manquantes (`deficit`) et nulles (`nulled`). Plus c'est bas, mieux c'est ; un nœud sans statistiques vaut 0.
 */
export function nodePenalty(stats: NodeLoad | null | undefined): number {
  if (!stats) return 0;
  let penalty = stats.playingPlayers ?? 0;
  const load = stats.cpu?.systemLoad ?? 0;
  penalty += Math.pow(1.05, 100 * load) * 10 - 10;
  const frames = stats.frameStats;
  if (frames) {
    penalty += Math.pow(1.03, (500 * (frames.deficit ?? 0)) / 3000) * 300 - 300;
    penalty += (Math.pow(1.03, (500 * (frames.nulled ?? 0)) / 3000) * 300 - 300) * 2;
  }
  return penalty;
}

interface Pickable {
  group?: string;
  connected: boolean;
  stats?: NodeLoad | null;
}

/**
 * Choix du nœud : le serveur public le moins chargé tant qu'il n'est pas dégradé, sinon le serveur personnel
 * (celui de l'utilisateur, gardé en repli), sinon le moins mauvais des publics.
 */
export function pickBest<T extends Pickable>(nodes: T[]): T | undefined {
  const live = nodes.filter((node) => node.connected);
  const byPenalty = (a: T, b: T) => nodePenalty(a.stats) - nodePenalty(b.stats);
  const publicNodes = live.filter((node) => node.group === 'public').sort(byPenalty);
  const healthy = publicNodes.filter((node) => nodePenalty(node.stats) < DEGRADED_PENALTY);
  if (healthy.length > 0) return healthy[0];
  const personal = live.filter((node) => node.group !== 'public').sort(byPenalty);
  return personal[0] ?? publicNodes[0];
}
