import {
  ActivityType,
  type ActivityType as ActivityTypeEnum,
  type Client,
  type PresenceStatusData,
} from 'discord.js';

import type { JsBotConfig } from '../config/js-bot-config.js';

const ACTIVITY_TYPE_MAP: Record<string, ActivityTypeEnum> = {
  playing: ActivityType.Playing,
  streaming: ActivityType.Streaming,
  listening: ActivityType.Listening,
  watching: ActivityType.Watching,
  competing: ActivityType.Competing,
  custom: ActivityType.Custom,
};

const DEFAULT_ROTATION_SECONDS = 60;
// Discord limits presence updates (about 5 per 20s): a dynamic text is refreshed at this pace at most.
const DYNAMIC_REFRESH_MS = 30_000;
const MAX_ACTIVITY_TEXT = 128;
const rotationTimers = new WeakMap<Client, ReturnType<typeof setTimeout>>();
// Marks the presence run that owns the client: a newer run (or a stop) invalidates the older one.
const activeRuns = new WeakMap<Client, object>();

export function stopPresenceRotation(client: Client): void {
  activeRuns.delete(client);
  const timer = rotationTimers.get(client);
  if (timer) {
    clearTimeout(timer);
    rotationTimers.delete(client);
  }
}

/** Evaluates the `${...}` JavaScript parts of a status text (e.g. `${client.ws.ping} ms`). */
export type PresenceTextEvaluator = (text: string) => Promise<string>;

export function isDynamicPresenceText(text: string): boolean {
  return text.includes('${');
}

/** Builds the script that renders [text] as a template literal; the text itself stays data. */
export function presenceTextScript(text: string): string {
  const escaped = text.replace(/\\/g, '\\\\').replace(/`/g, '\\`');
  return `return \`${escaped}\`;`;
}

function nextDelayMs(activity: PresenceActivity): number {
  const min = activity.minIntervalSeconds ?? activity.maxIntervalSeconds ?? DEFAULT_ROTATION_SECONDS;
  const max = Math.max(min, activity.maxIntervalSeconds ?? min);
  // Discord rate-limits presence updates (about 5 per 20s): never go below 15s.
  return Math.max(15, min + Math.random() * (max - min)) * 1000;
}

type PresenceActivity = NonNullable<NonNullable<JsBotConfig['presence']>['activities']>[number];

export function applyPresence(client: Client, config: JsBotConfig, evaluate?: PresenceTextEvaluator): void {
  stopPresenceRotation(client);
  if (!config.presence || !client.user) {
    return;
  }

  const status = config.presence.status as PresenceStatusData;
  const list = config.presence.activities ?? [];
  const toDiscord = (activity: PresenceActivity, text: string) =>
    activity.type === 'custom'
      ? // Statut personnalisé: Discord n'affiche que `state`, `name` est requis mais ignoré.
        { name: 'Custom Status', type: ActivityType.Custom, state: text }
      : {
          name: text,
          type: ACTIVITY_TYPE_MAP[activity.type] ?? ActivityType.Playing,
          url: activity.url,
        };

  const hasDynamic = (activity: PresenceActivity) => Boolean(evaluate) && isDynamicPresenceText(activity.name);

  // Pas de texte dynamique: envoi immédiat, comme avant.
  if (list.length <= 1 && !list.some(hasDynamic)) {
    client.user.setPresence({ status, activities: list.map((a) => toDiscord(a, a.name)) });
    return;
  }

  const run = {};
  activeRuns.set(client, run);
  let index = 0;
  let lastKey = '';
  const publish = (activity: PresenceActivity, text: string, force: boolean): void => {
    if (!client.user || activeRuns.get(client) !== run) {
      return;
    }
    const key = `${activity.type}|${text}`;
    if (!force && key === lastKey) {
      return;
    }
    lastKey = key;
    client.user.setPresence({ status, activities: [toDiscord(activity, text)] });
  };
  // Texte littéral: envoi synchrone. Texte dynamique (`${...}`): évalué, borné à la limite Discord.
  const send = (activity: PresenceActivity, force: boolean): void => {
    if (!hasDynamic(activity)) {
      publish(activity, activity.name, force);
      return;
    }
    evaluate!(activity.name).then(
      (out) => publish(activity, (out.trim() || activity.name).slice(0, MAX_ACTIVITY_TEXT), force),
      () => publish(activity, activity.name, force),
    );
  };

  const step = (): void => {
    if (!client.user || activeRuns.get(client) !== run) {
      return;
    }
    const current = list[index % list.length];
    index += 1;
    send(current, list.length > 1);
    // Plusieurs statuts: rotation. Un seul statut dynamique: simple rafraîchissement.
    const timer = setTimeout(step, list.length > 1 ? nextDelayMs(current) : DYNAMIC_REFRESH_MS);
    timer.unref?.();
    rotationTimers.set(client, timer);
  };
  step();

  // Un statut dynamique pendant une longue rotation reste à jour entre deux changements.
  if (list.length > 1 && list.some(hasDynamic)) {
    const refresh = setInterval(() => {
      if (activeRuns.get(client) !== run) {
        clearInterval(refresh);
        return;
      }
      const shown = list[(index - 1) % list.length];
      if (hasDynamic(shown)) {
        send(shown, false);
      }
    }, DYNAMIC_REFRESH_MS);
    refresh.unref?.();
  }
}
