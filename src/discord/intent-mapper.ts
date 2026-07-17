import { GatewayIntentBits, type GatewayIntentBits as GatewayIntentBitsType } from 'discord.js';

const INTENT_MAP: Record<string, GatewayIntentBitsType> = {
  Guilds: GatewayIntentBits.Guilds,
  'Guild Members': GatewayIntentBits.GuildMembers,
  'Guild Moderation': GatewayIntentBits.GuildModeration,
  'Guild Emojis and Stickers': GatewayIntentBits.GuildEmojisAndStickers,
  'Guild Expressions': GatewayIntentBits.GuildEmojisAndStickers,
  'Guild Integrations': GatewayIntentBits.GuildIntegrations,
  'Guild Webhooks': GatewayIntentBits.GuildWebhooks,
  'Guild Invites': GatewayIntentBits.GuildInvites,
  'Guild Voice States': GatewayIntentBits.GuildVoiceStates,
  'Guild Presence': GatewayIntentBits.GuildPresences,
  'Guild Presences': GatewayIntentBits.GuildPresences,
  'Guild Messages': GatewayIntentBits.GuildMessages,
  'Guild Message Reactions': GatewayIntentBits.GuildMessageReactions,
  'Guild Message Typing': GatewayIntentBits.GuildMessageTyping,
  'Direct Messages': GatewayIntentBits.DirectMessages,
  'Direct Message Reactions': GatewayIntentBits.DirectMessageReactions,
  'Direct Message Typing': GatewayIntentBits.DirectMessageTyping,
  'Message Content': GatewayIntentBits.MessageContent,
  'Guild Scheduled Events': GatewayIntentBits.GuildScheduledEvents,
  'Auto Moderation Configuration': GatewayIntentBits.AutoModerationConfiguration,
  'Auto Moderation Execution': GatewayIntentBits.AutoModerationExecution,
};

export function mapIntents(intentsMap: Record<string, boolean>): GatewayIntentBitsType[] {
  let bits = GatewayIntentBits.Guilds;

  for (const [name, enabled] of Object.entries(intentsMap)) {
    if (!enabled) {
      continue;
    }

    const mapped = INTENT_MAP[name];
    if (mapped !== undefined) {
      bits |= mapped;
    }
  }

  return [bits];
}
