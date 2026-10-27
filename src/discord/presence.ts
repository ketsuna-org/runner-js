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
const rotationTimers = new WeakMap<Client, ReturnType<typeof setTimeout>>();

export function stopPresenceRotation(client: Client): void {
  const timer = rotationTimers.get(client);
  if (timer) {
    clearTimeout(timer);
    rotationTimers.delete(client);
  }
}

function nextDelayMs(activity: PresenceActivity): number {
  const min = activity.minIntervalSeconds ?? activity.maxIntervalSeconds ?? DEFAULT_ROTATION_SECONDS;
  const max = Math.max(min, activity.maxIntervalSeconds ?? min);
  // Discord rate-limits presence updates (about 5 per 20s): never go below 15s.
  return Math.max(15, min + Math.random() * (max - min)) * 1000;
}

type PresenceActivity = NonNullable<NonNullable<JsBotConfig['presence']>['activities']>[number];

export function applyPresence(client: Client, config: JsBotConfig): void {
  stopPresenceRotation(client);
  if (!config.presence || !client.user) {
    return;
  }

  const status = config.presence.status as PresenceStatusData;
  const list = config.presence.activities ?? [];
  const toDiscord = (activity: PresenceActivity) =>
    activity.type === 'custom'
      ? // Statut personnalisé: Discord n'affiche que `state`, `name` est requis mais ignoré.
        { name: 'Custom Status', type: ActivityType.Custom, state: activity.name }
      : {
          name: activity.name,
          type: ACTIVITY_TYPE_MAP[activity.type] ?? ActivityType.Playing,
          url: activity.url,
        };

  if (list.length <= 1) {
    client.user.setPresence({ status, activities: list.map(toDiscord) });
    return;
  }

  let index = 0;
  const step = (): void => {
    if (!client.user) {
      return;
    }
    const current = list[index % list.length];
    client.user.setPresence({ status, activities: [toDiscord(current)] });
    index += 1;
    const timer = setTimeout(step, nextDelayMs(current));
    timer.unref?.();
    rotationTimers.set(client, timer);
  };
  step();
}
