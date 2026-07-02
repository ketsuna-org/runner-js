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
};

export function applyPresence(client: Client, config: JsBotConfig): void {
  if (!config.presence || !client.user) {
    return;
  }

  const activities = (config.presence.activities ?? []).map((activity) => ({
    name: activity.name,
    type: ACTIVITY_TYPE_MAP[activity.type] ?? ActivityType.Playing,
    url: activity.url,
  }));

  client.user.setPresence({
    status: config.presence.status as PresenceStatusData,
    activities,
  });
}
