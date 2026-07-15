import {
  ActionRowBuilder,
  ActivityType,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  ComponentType,
  ContextMenuCommandBuilder,
  EmbedBuilder,
  MentionableSelectMenuBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  RoleSelectMenuBuilder,
  SlashCommandBuilder,
  SlashCommandSubcommandBuilder,
  SlashCommandSubcommandGroupBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
} from 'discord.js';

import type { ModuleRegistry } from './script-host-modules.js';

const DENIED_DISCORD_JS_EXPORTS = [
  'Client',
  'ShardingManager',
  'WebhookClient',
  'REST',
] as const;

const BUILDER_EXPORTS = [
  { name: 'EmbedBuilder', Class: EmbedBuilder, prefix: 'djs-embed' },
  { name: 'AttachmentBuilder', Class: AttachmentBuilder, prefix: 'djs-attachment' },
  { name: 'ActionRowBuilder', Class: ActionRowBuilder, prefix: 'djs-action-row' },
  { name: 'ButtonBuilder', Class: ButtonBuilder, prefix: 'djs-button' },
  { name: 'StringSelectMenuBuilder', Class: StringSelectMenuBuilder, prefix: 'djs-string-select' },
  { name: 'UserSelectMenuBuilder', Class: UserSelectMenuBuilder, prefix: 'djs-user-select' },
  { name: 'ChannelSelectMenuBuilder', Class: ChannelSelectMenuBuilder, prefix: 'djs-channel-select' },
  { name: 'RoleSelectMenuBuilder', Class: RoleSelectMenuBuilder, prefix: 'djs-role-select' },
  { name: 'MentionableSelectMenuBuilder', Class: MentionableSelectMenuBuilder, prefix: 'djs-mentionable-select' },
  { name: 'ModalBuilder', Class: ModalBuilder, prefix: 'djs-modal' },
  { name: 'TextInputBuilder', Class: TextInputBuilder, prefix: 'djs-text-input' },
  { name: 'SlashCommandBuilder', Class: SlashCommandBuilder, prefix: 'djs-slash-command' },
  {
    name: 'SlashCommandSubcommandBuilder',
    Class: SlashCommandSubcommandBuilder,
    prefix: 'djs-slash-subcommand',
  },
  {
    name: 'SlashCommandSubcommandGroupBuilder',
    Class: SlashCommandSubcommandGroupBuilder,
    prefix: 'djs-slash-subcommand-group',
  },
  { name: 'ContextMenuCommandBuilder', Class: ContextMenuCommandBuilder, prefix: 'djs-context-menu' },
] as const;

type BuilderClass = new (...args: unknown[]) => object;

function denyDiscordJsExport(name: string): never {
  throw new Error(
    `discord.js export "${name}" is not allowed in sandbox scripts. Use the global client object for bot connectivity.`,
  );
}

function serializeDiscordJsConstants(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map((entry) => serializeDiscordJsConstants(entry));
  }
  if (value != null && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      output[key] = serializeDiscordJsConstants(entry);
    }
    return output;
  }
  return value;
}

export function getDiscordJsModuleConstants(): Record<string, unknown> {
  return serializeDiscordJsConstants({
    ChannelType,
    ButtonStyle,
    ComponentType,
    TextInputStyle,
    PermissionFlagsBits,
    ActivityType,
  }) as Record<string, unknown>;
}

export function buildDiscordJsModule(wrapHostResult: ModuleRegistry['wrapHostResult']) {
  const exports: Record<string, unknown> = {};

  for (const entry of BUILDER_EXPORTS) {
    const Builder = entry.Class as BuilderClass;
    exports[entry.name] = (...args: unknown[]) =>
      wrapHostResult(new Builder(...args), entry.prefix, [], () => ({}));
  }

  for (const denied of DENIED_DISCORD_JS_EXPORTS) {
    exports[denied] = () => denyDiscordJsExport(denied);
  }

  return exports;
}

export function getDiscordJsBuilderFunctionNames(): string[] {
  return BUILDER_EXPORTS.map((entry) => entry.name);
}

export function getDiscordJsDeniedFunctionNames(): string[] {
  return [...DENIED_DISCORD_JS_EXPORTS];
}
