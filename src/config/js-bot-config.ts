import { z } from 'zod';

const handlerBaseSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean().default(true),
  script: z.string(),
});

export const commandHandlerSchema = handlerBaseSchema.extend({
  type: z.literal('command').default('command'),
  name: z.string().min(1).max(32),
  description: z.string().default(''),
  options: z.array(z.record(z.unknown())).default([]),
});

export const eventHandlerSchema = handlerBaseSchema.extend({
  type: z.literal('event').default('event'),
  name: z.string().min(1),
});

export const scheduledHandlerSchema = handlerBaseSchema.extend({
  type: z.literal('scheduled').default('scheduled'),
  name: z.string().min(1).optional(),
  everyMinutes: z.number().int().positive(),
});

export const inboundWebhookHandlerSchema = handlerBaseSchema.extend({
  type: z.literal('inboundWebhook').default('inboundWebhook'),
  path: z.string().min(1),
  secret: z.string().default(''),
});

export const presenceSchema = z
  .object({
    status: z.enum(['online', 'idle', 'dnd', 'invisible']).default('online'),
    activities: z
      .array(
        z.object({
          type: z
            .enum(['playing', 'streaming', 'listening', 'watching', 'competing'])
            .default('playing'),
          name: z.string(),
          url: z.string().optional(),
        }),
      )
      .default([]),
  })
  .optional();

export const jsBotConfigSchema = z.object({
  token: z.string().min(1),
  intents: z.record(z.boolean()).default({}),
  prefix: z.string().optional(),
  autoRestart: z.boolean().default(true),
  presence: presenceSchema,
  commands: z.array(commandHandlerSchema).default([]),
  events: z.array(eventHandlerSchema).default([]),
  scheduled: z.array(scheduledHandlerSchema).default([]),
  inboundWebhooks: z.array(inboundWebhookHandlerSchema).default([]),
  globalVariables: z.record(z.unknown()).default({}),
  scopedVariableDefinitions: z.array(z.record(z.unknown())).default([]),
  scriptTimeoutMs: z.number().int().positive().default(30_000),
});

export type CommandHandler = z.infer<typeof commandHandlerSchema>;
export type EventHandler = z.infer<typeof eventHandlerSchema>;
export type ScheduledHandler = z.infer<typeof scheduledHandlerSchema>;
export type InboundWebhookHandler = z.infer<typeof inboundWebhookHandlerSchema>;
export type JsBotConfig = z.infer<typeof jsBotConfigSchema>;

export const botSyncPayloadSchema = z.object({
  botId: z.string().min(1),
  botName: z.string().default(''),
  config: z.record(z.unknown()),
});

export function parseJsBotConfig(raw: unknown): JsBotConfig {
  return jsBotConfigSchema.parse(raw);
}

export function validateJsBotConfig(config: JsBotConfig): void {
  jsBotConfigSchema.parse(config);

  const commandNames = new Set<string>();
  for (const command of config.commands) {
    const key = command.name.trim().toLowerCase();
    if (commandNames.has(key)) {
      throw new Error(`Duplicate command name: ${command.name}`);
    }
    commandNames.add(key);
  }

  const eventNames = new Set<string>();
  for (const event of config.events) {
    const key = event.name.trim();
    if (eventNames.has(key)) {
      throw new Error(`Duplicate event handler: ${event.name}`);
    }
    eventNames.add(key);
  }

  const webhookPaths = new Set<string>();
  for (const webhook of config.inboundWebhooks) {
    const key = webhook.path.trim().toLowerCase();
    if (webhookPaths.has(key)) {
      throw new Error(`Duplicate inbound webhook path: ${webhook.path}`);
    }
    webhookPaths.add(key);
  }
}
