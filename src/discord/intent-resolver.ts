export const PRIVILEGED_INTENT_KEYS = new Set([
  'Guild Members',
  'Guild Presence',
  'Message Content',
]);

export const EVENT_TO_INTENT_KEYS: Record<string, string[]> = {
  guildCreate: ['Guilds'],
  guildUpdate: ['Guilds'],
  guildDelete: ['Guilds'],
  channelCreate: ['Guilds'],
  channelUpdate: ['Guilds'],
  channelDelete: ['Guilds'],
  channelPinsUpdate: ['Guilds'],
  threadCreate: ['Guilds'],
  threadUpdate: ['Guilds'],
  threadDelete: ['Guilds'],
  threadListSync: ['Guilds'],
  threadMemberUpdate: ['Guilds'],
  threadMembersUpdate: ['Guilds'],
  stageInstanceCreate: ['Guilds'],
  stageInstanceUpdate: ['Guilds'],
  stageInstanceDelete: ['Guilds'],
  guildMemberAdd: ['Guild Members'],
  guildMemberUpdate: ['Guild Members'],
  guildMemberRemove: ['Guild Members'],
  guildAuditLogCreate: ['Guild Moderation'],
  guildBanAdd: ['Guild Moderation'],
  guildBanRemove: ['Guild Moderation'],
  guildEmojisUpdate: ['Guild Expressions'],
  guildStickersUpdate: ['Guild Expressions'],
  soundboardSoundCreate: ['Guild Expressions'],
  soundboardSoundUpdate: ['Guild Expressions'],
  soundboardSoundDelete: ['Guild Expressions'],
  soundboardSoundsUpdate: ['Guild Expressions'],
  guildIntegrationsUpdate: ['Guild Integrations'],
  integrationCreate: ['Guild Integrations'],
  integrationUpdate: ['Guild Integrations'],
  integrationDelete: ['Guild Integrations'],
  webhooksUpdate: ['Guild Webhooks'],
  inviteCreate: ['Guild Invites'],
  inviteDelete: ['Guild Invites'],
  voiceStateUpdate: ['Guild Voice States'],
  voiceChannelEffectSend: ['Guild Voice States'],
  presenceUpdate: ['Guild Presence'],
  messageCreate: ['Guild Messages'],
  messageUpdate: ['Guild Messages'],
  messageDelete: ['Guild Messages'],
  messageBulkDelete: ['Guild Messages'],
  messageReactionAdd: ['Guild Message Reactions'],
  messageReactionRemove: ['Guild Message Reactions'],
  messageReactionRemoveAll: ['Guild Message Reactions'],
  messageReactionRemoveEmoji: ['Guild Message Reactions'],
  typingStart: ['Guild Message Typing'],
  guildScheduledEventCreate: ['Guild Scheduled Events'],
  guildScheduledEventUpdate: ['Guild Scheduled Events'],
  guildScheduledEventDelete: ['Guild Scheduled Events'],
  guildScheduledEventUserAdd: ['Guild Scheduled Events'],
  guildScheduledEventUserRemove: ['Guild Scheduled Events'],
  autoModerationRuleCreate: ['Auto Moderation Configuration'],
  autoModerationRuleUpdate: ['Auto Moderation Configuration'],
  autoModerationRuleDelete: ['Auto Moderation Configuration'],
  autoModerationActionExecution: ['Auto Moderation Execution'],
  messagePollVoteAdd: ['Guild Message Polls'],
  messagePollVoteRemove: ['Guild Message Polls'],
};

export function resolveRequiredIntentKeys(options: {
  eventNames: string[];
  hasLegacyCommands?: boolean;
  approvedPrivilegedIntents?: Set<string>;
  warnings?: string[];
}): Set<string> {
  const required = new Set<string>();
  const approvedPrivileged = options.approvedPrivilegedIntents ?? new Set<string>();
  const warnings = options.warnings;

  for (const event of options.eventNames) {
    const trimmed = event.trim();
    if (!trimmed) {
      continue;
    }
    const intents = EVENT_TO_INTENT_KEYS[trimmed];
    if (intents) {
      for (const intent of intents) {
        required.add(intent);
      }
    }
  }

  if (options.hasLegacyCommands) {
    required.add('Guild Messages');
    required.add('Message Content');
  }

  const resolved = new Set<string>();
  for (const key of required) {
    if (PRIVILEGED_INTENT_KEYS.has(key)) {
      if (approvedPrivileged.has(key)) {
        resolved.add(key);
      } else {
        warnings?.push(
          `Intent "${key}" is required by your event workflows but is not ` +
            'approved in the Discord Developer Portal. ' +
            'The related events will not be received.',
        );
      }
    } else {
      resolved.add(key);
    }
  }

  return resolved;
}
