/**
 * Compteurs de messages par salon (`bc.activity.messageCount`, parité avec `$channelMessageCount`).
 * On ne garde que l'heure, le salon et si l'auteur est humain : jamais le texte. En mémoire, bornés.
 */
const MAX_PER_CHANNEL = 2000;
const MAX_CHANNELS_PER_BOT = 500;
const RETENTION_MS = 24 * 60 * 60 * 1000;

type Entry = { at: number; human: boolean };
const events = new Map<string, Map<string, Entry[]>>();

export function recordChannelMessage(botId: string, channelId: string, human: boolean, at = Date.now()): void {
  if (!botId || !channelId) return;
  let channels = events.get(botId);
  if (!channels) {
    channels = new Map();
    events.set(botId, channels);
  }
  if (!channels.has(channelId) && channels.size >= MAX_CHANNELS_PER_BOT) {
    const first = channels.keys().next().value;
    if (first !== undefined) channels.delete(first);
  }
  let list = channels.get(channelId);
  if (!list) {
    list = [];
    channels.set(channelId, list);
  }
  list.push({ at, human });
  const oldest = at - RETENTION_MS;
  let drop = 0;
  while (drop < list.length - 1 && list[drop].at < oldest) drop++;
  if (list.length - drop > MAX_PER_CHANNEL) drop = list.length - MAX_PER_CHANNEL;
  if (drop > 0) list.splice(0, drop);
}

export function countChannelMessages(
  botId: string,
  channelId: string,
  windowMinutes = 60,
  humansOnly = false,
  now = Date.now(),
): number {
  const list = events.get(botId)?.get(channelId);
  if (!list) return 0;
  if (!Number.isFinite(windowMinutes) || windowMinutes < 1) throw new Error('The minutes must be a positive integer.');
  const since = now - Math.min(windowMinutes * 60_000, RETENTION_MS);
  let total = 0;
  for (let i = list.length - 1; i >= 0 && list[i].at >= since; i--) {
    if (!humansOnly || list[i].human) total++;
  }
  return total;
}

export function clearChannelActivity(botId?: string): void {
  if (botId === undefined) events.clear();
  else events.delete(botId);
}
