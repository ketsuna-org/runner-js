import ivm from 'isolated-vm';

import type { JsBotConfig } from '../config/js-bot-config.js';
import type { ScriptDb } from './script-db.js';
import type { ScriptExecutionContext, ScriptLogger } from './script-context.js';

export interface HostObjectSpec {
  id: string;
  snapshot: Record<string, unknown>;
  methods: string[];
  target: unknown;
}

export interface HostBridgeBundle {
  bridgeRef: ivm.Reference<{
    invoke: (targetId: string, method: string, args: unknown[]) => Promise<unknown>;
  }>;
  objectSpecs: HostObjectSpec[];
  release: () => void;
  clearTimers: () => void;
}

const INTERACTION_METHODS = [
  'reply',
  'deferReply',
  'editReply',
  'followUp',
  'respond',
  'update',
  'deferUpdate',
  'fetchReply',
  'deleteReply',
  'showModal',
  'isButton',
  'isChatInputCommand',
  'isAutocomplete',
  'isModalSubmit',
  'isRepliable',
] as const;

const INTERACTION_OPTIONS_METHODS = [
  'getString',
  'getInteger',
  'getNumber',
  'getBoolean',
  'getUser',
  'getMember',
  'getRole',
  'getChannel',
  'getAttachment',
  'getMentionable',
  'getSubcommand',
  'getSubcommandGroup',
  'getFocused',
] as const;

const MESSAGE_METHODS = [
  'reply',
  'react',
  'delete',
  'edit',
  'fetch',
  'pin',
  'unpin',
] as const;

const CLIENT_METHODS = [
  'fetchWebhook',
  'fetchInvites',
] as const;

const DB_METHODS = ['get', 'set', 'delete', 'has', 'list', 'reset'] as const;
const DB_GLOBAL_METHODS = ['get', 'set', 'delete', 'has'] as const;
const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;

export function buildHostBridge(
  context: ScriptExecutionContext,
  logger: ScriptLogger,
): HostBridgeBundle {
  const targets = new Map<string, unknown>();
  const objectSpecs: HostObjectSpec[] = [];
  const timers = new Set<NodeJS.Timeout>();

  const register = (spec: HostObjectSpec) => {
    targets.set(spec.id, spec.target);
    objectSpecs.push(spec);
  };

  if (context.client) {
    register({
      id: 'client',
      target: context.client,
      snapshot: {
        user: snapshotUser(context.client.user),
        readyAt: context.client.readyTimestamp,
        uptime: context.client.uptime,
      },
      methods: [...CLIENT_METHODS],
    });
  }

  if (context.interaction) {
    const interaction = context.interaction;
    register({
      id: 'interaction',
      target: interaction,
      snapshot: {
        id: interaction.id,
        type: interaction.type,
        commandName: 'commandName' in interaction ? interaction.commandName : undefined,
        customId: 'customId' in interaction ? interaction.customId : undefined,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        user: snapshotUser(interaction.user),
        member: snapshotMember(interaction.member),
        guild: snapshotGuild(interaction.guild),
        channel: snapshotChannel(interaction.channel),
        createdTimestamp: interaction.createdTimestamp,
        replied: 'replied' in interaction ? interaction.replied : undefined,
        deferred: 'deferred' in interaction ? interaction.deferred : undefined,
      },
      methods: [...INTERACTION_METHODS],
    });

    if ('options' in interaction && interaction.options) {
      register({
        id: 'interaction.options',
        target: interaction.options,
        snapshot: {},
        methods: [...INTERACTION_OPTIONS_METHODS],
      });
    }
  }

  if (context.message) {
    const message = context.message;
    register({
      id: 'message',
      target: message,
      snapshot: {
        id: message.id,
        content: message.content,
        guildId: message.guildId,
        channelId: message.channelId,
        author: snapshotUser(message.author),
        member: snapshotMember(message.member),
        guild: snapshotGuild(message.guild),
        channel: snapshotChannel(message.channel),
        createdTimestamp: message.createdTimestamp,
        pinned: message.pinned,
        system: message.system,
      },
      methods: [...MESSAGE_METHODS],
    });
  }

  if (context.member) {
    register({
      id: 'member',
      target: context.member,
      snapshot: snapshotMember(context.member) ?? {},
      methods: [],
    });
  }

  if (context.guild) {
    register({
      id: 'guild',
      target: context.guild,
      snapshot: snapshotGuild(context.guild) ?? {},
      methods: [],
    });
  }

  if (context.channel) {
    register({
      id: 'channel',
      target: context.channel,
      snapshot: snapshotChannel(context.channel) ?? {},
      methods: [],
    });
  }

  if (context.db) {
    registerDbTargets(context.db, register);
  }

  register({
    id: 'console',
    target: logger,
    snapshot: {},
    methods: [...CONSOLE_METHODS],
  });

  targets.set('__fetch', fetch);
  targets.set('__setTimeout', (callback: ivm.Reference<(...args: unknown[]) => unknown>, ms = 0) => {
    return new Promise<void>((resolve) => {
      const handle = setTimeout(() => {
        void callback
          .apply(undefined, [], { result: { promise: true } })
          .catch(() => undefined)
          .finally(() => resolve());
      }, Number(ms) || 0);
      timers.add(handle);
    });
  });
  targets.set('__clearTimeout', (handle: NodeJS.Timeout) => {
    clearTimeout(handle);
    timers.delete(handle);
  });

  const bridgeRef = new ivm.Reference({
    invoke: async (targetId: string, method: string, args: unknown[]) => {
      const target = targets.get(targetId);
      if (target == null) {
        throw new Error(`Host bridge target "${targetId}" is not available.`);
      }

      if (targetId === '__fetch') {
        const response = await fetch(...(args as Parameters<typeof fetch>));
        return copyHostValue(await responseToPlain(response));
      }

      if (typeof target === 'function') {
        return copyHostValue(await (target as (...fnArgs: unknown[]) => unknown)(...args));
      }

      const record = target as Record<string, unknown>;
      const fn = record[method];
      if (typeof fn !== 'function') {
        throw new Error(`Host bridge method "${targetId}.${method}" is not available.`);
      }

      return copyHostValue(await fn.apply(target, args));
    },
  });

  return {
    bridgeRef,
    objectSpecs,
    release: () => {
      for (const handle of timers) {
        clearTimeout(handle);
      }
      timers.clear();
      targets.clear();
      bridgeRef.release();
    },
    clearTimers: () => {
      for (const handle of timers) {
        clearTimeout(handle);
      }
      timers.clear();
    },
  };
}

export function sanitizeConfigForScript(config: JsBotConfig): Record<string, unknown> {
  const { token: _token, ...safeConfig } = config;
  return copyHostValue(safeConfig) as Record<string, unknown>;
}

function registerDbTargets(
  db: ScriptDb,
  register: (spec: HostObjectSpec) => void,
): void {
  register({
    id: 'db',
    target: db,
    snapshot: {},
    methods: [...DB_METHODS],
  });
  register({
    id: 'db.global',
    target: db.global,
    snapshot: {},
    methods: [...DB_GLOBAL_METHODS],
  });
}

function snapshotUser(user: unknown): Record<string, unknown> | null {
  if (!user || typeof user !== 'object') {
    return null;
  }

  const value = user as Record<string, unknown>;
  return copyHostValue({
    id: value.id,
    username: value.username,
    tag: value.tag,
    globalName: value.globalName,
    bot: value.bot,
    discriminator: value.discriminator,
    avatar: value.avatar,
    displayAvatarURL: typeof value.displayAvatarURL === 'function' ? value.displayAvatarURL() : undefined,
  }) as Record<string, unknown>;
}

function snapshotMember(member: unknown): Record<string, unknown> | null {
  if (!member || typeof member !== 'object') {
    return null;
  }

  const value = member as Record<string, unknown>;
  return copyHostValue({
    id: value.id,
    nickname: value.nickname,
    displayName: typeof value.displayName === 'string' ? value.displayName : undefined,
    user: snapshotUser(value.user),
    joinedAt: value.joinedAt instanceof Date ? value.joinedAt.toISOString() : value.joinedAt,
  }) as Record<string, unknown>;
}

function snapshotGuild(guild: unknown): Record<string, unknown> | null {
  if (!guild || typeof guild !== 'object') {
    return null;
  }

  const value = guild as Record<string, unknown>;
  return copyHostValue({
    id: value.id,
    name: value.name,
    icon: value.icon,
    memberCount: value.memberCount,
    ownerId: value.ownerId,
  }) as Record<string, unknown>;
}

function snapshotChannel(channel: unknown): Record<string, unknown> | null {
  if (!channel || typeof channel !== 'object') {
    return null;
  }

  const value = channel as Record<string, unknown>;
  return copyHostValue({
    id: value.id,
    name: value.name,
    type: value.type,
    guildId: value.guildId,
  }) as Record<string, unknown>;
}

async function responseToPlain(response: Response): Promise<Record<string, unknown>> {
  const bodyText = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    url: response.url,
    headers: Object.fromEntries(response.headers.entries()),
    body: bodyText,
  };
}

function copyHostValue(value: unknown): unknown {
  if (value == null) {
    return value;
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (Buffer.isBuffer(value)) {
    return value.toString('base64');
  }

  if (Array.isArray(value)) {
    return value.map((entry) => copyHostValue(entry));
  }

  if (typeof value === 'object') {
    if (typeof (value as { toJSON?: () => unknown }).toJSON === 'function') {
      try {
        return copyHostValue((value as { toJSON: () => unknown }).toJSON());
      } catch {
        // Fall through to manual copy.
      }
    }

    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (typeof entry === 'function') {
        continue;
      }
      try {
        output[key] = copyHostValue(entry);
      } catch {
        // Skip non-serializable fields.
      }
    }
    return output;
  }

  return String(value);
}
