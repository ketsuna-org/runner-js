import { z } from 'zod';

function describeType(value: unknown): string {
  return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
}

/** Jamais le contenu de la valeur (une fonction JS ou une variable peut être sensible) : son type seulement. */
function warnIgnored(field: string, reason: string): void {
  console.warn(`[js-bot-config] ${field} ignoré : ${reason}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Champ ajouté après coup à la configuration : OPTIONNEL et TOLÉRANT. Absent ou `null` = non défini ; une
 * valeur du mauvais type est ignorée avec un avertissement au lieu de faire rejeter la configuration
 * entière du bot (ce que fait zod par défaut, et ce que `triggerType` fait déjà pour les valeurs inconnues :
 * c'est pourquoi les nouveautés sont des champs orthogonaux et non de nouvelles valeurs d'enum).
 * La clé reste absente de la sortie quand elle est absente de l'entrée.
 */
function tolerant<T extends z.ZodTypeAny>(field: string, schema: T) {
  return schema
    .nullish()
    .transform((value): z.output<T> | undefined => value ?? undefined)
    .catch((ctx) => {
      warnIgnored(field, `valeur de type ${describeType(ctx.input)} non valide`);
      return undefined;
    });
}

const handlerBaseSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean().default(true),
  script: z.string(),
});

export const commandHandlerSchema = handlerBaseSchema.extend({
  type: z.literal('command').default('command'),
  name: z.string().min(1).max(32),
  description: z.string().default(''),
  /** Discord application command type: chatInput | user | message */
  discordType: z.enum(['chatInput', 'user', 'message']).default('chatInput'),
  triggerType: z.enum(['prefix', 'slash', 'hybrid', 'none']).optional(),
  prefixName: z.string().optional(),
  data: z.record(z.unknown()).optional(),
  legacyModeEnabled: z.boolean().optional(),
  legacyLocalOnly: z.boolean().optional(),
  legacyPrefixOverride: z.string().optional(),
  legacyAliases: z.array(z.string()).optional(),
  /**
   * Invocation sans préfixe (`ping` au lieu de `!ping`). Double opt-in : effective seulement si le bot
   * porte aussi `allowNoPrefixCommands` (voir `commandAllowsNoPrefix`). Lue `data.noPrefix ?? noPrefix`.
   */
  noPrefix: tolerant('commands.noPrefix', z.boolean()),
  options: z.array(z.record(z.unknown())).default([]),
  aliases: z.array(z.string()).default([]),
  /**
   * Discord `default_member_permissions` (a bitfield as text, e.g. "8" for
   * administrator). Optional on purpose: an undeclared permission means "do not
   * touch what Discord already has", which is what keeps a command restricted to
   * administrators from being reopened to everyone at the next registration.
   */
  defaultMemberPermissions: z.union([z.string(), z.number()]).optional(),
  contexts: z.array(z.number().int().min(0).max(2)).max(3).optional(),
  integrationTypes: z.array(z.number().int().min(0).max(1)).max(2).optional(),
});

export const eventHandlerSchema = handlerBaseSchema.extend({
  type: z.literal('event').default('event'),
  name: z.string().min(1),
  /**
   * `customId` du bouton, menu ou formulaire que ce workflow traite (événement `interactionCreate`). Absent ou
   * vide : aucun filtre. Présent : toute autre interaction (autre composant, commande slash) est ignorée.
   */
  customIdFilter: z.string().trim().optional(),
});

/**
 * `everyMinutes` n'est plus requis : une entrée peut ne porter que `cron`. Une entrée sans planification
 * valide n'est PAS rejetée (ce qui ferait tomber la configuration du bot) : le planificateur l'ignore
 * avec un avertissement. `cron` (5 champs ou macro, sans secondes) est prioritaire sur `everyMinutes`.
 */
export const scheduledHandlerSchema = handlerBaseSchema.extend({
  type: z.literal('scheduled').default('scheduled'),
  name: z.string().min(1).optional(),
  everyMinutes: tolerant('scheduled.everyMinutes', z.number().int().positive()),
  cron: tolerant('scheduled.cron', z.string()),
  /** Fuseau IANA de `cron` ; UTC si absent. Sans effet pour `everyMinutes`. */
  timezone: tolerant('scheduled.timezone', z.string()),
  runOnStart: tolerant('scheduled.runOnStart', z.boolean()),
  timeoutMs: tolerant('scheduled.timeoutMs', z.number().int().positive()),
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
            .enum(['playing', 'streaming', 'listening', 'watching', 'competing', 'custom'])
            .default('playing'),
          name: z.string(),
          url: z.string().optional(),
          minIntervalSeconds: z.number().positive().optional(),
          maxIntervalSeconds: z.number().positive().optional(),
        }),
      )
      .default([]),
  })
  .optional();

export const MAX_SCRIPT_TIMEOUT_MS = 15 * 60 * 1000;
export const DEFAULT_SCRIPT_TIMEOUT_MS = MAX_SCRIPT_TIMEOUT_MS;

export const databaseConfigSchema = z
  .object({
    type: z.enum(['none', 'postgres', 'mysql', 'mongo']).default('none'),
    uri: z.string().optional(),
    host: z.string().optional(),
    port: z.union([z.number(), z.string()]).optional(),
    database: z.string().optional(),
    user: z.string().optional(),
    password: z.string().optional(),
    ssl: z.boolean().optional(),
  })
  .nullish()
  .transform((val) => val ?? { type: 'none' as const });

/**
 * Musique (Lavalink), même schéma figé que côté Dart : `enabled` plus des serveurs personnels de repli. Le
 * Manager force `enabled` à faux pour un compte sans Premium ; absent = musique éteinte. Une entrée sans hôte
 * est écartée (jamais de rejet de la configuration entière).
 */
export const lavalinkServerSchema = z.object({
  host: z.string().trim().min(1),
  port: z.coerce.number().int().min(1).max(65535).catch(2333),
  password: z.string().default('youshallnotpass'),
  secure: z.boolean().catch(false),
});

const lavalinkConfigSchema = tolerant(
  'lavalink',
  z.object({
    enabled: z.boolean().catch(false),
    custom_servers: z
      .array(z.unknown())
      .catch([])
      .transform((items) =>
        items.flatMap((item) => {
          const parsed = lavalinkServerSchema.safeParse(item);
          return parsed.success ? [parsed.data] : [];
        }),
      ),
  }),
);

/** Nombre de renommages recopiés dans l'avertissement (le reste est compté). */
const MAX_LOGGED_RENAMES = 20;

/**
 * Plusieurs entrées `scheduled` peuvent porter le même id : le Manager prend `id = workflowName` quand
 * l'id est vide, donc deux déclencheurs d'un même workflow donnent deux entrées de même id, tolérées
 * depuis toujours. Les rejeter ferait échouer la synchro de bots existants ; on suffixe donc les doublons
 * (`id#2`, `id#3`…) pour que les consommateurs (planificateur) disposent de clés uniques, avec un warn.
 */
function dedupeScheduledIds<T extends { id: string }>(entries: T[]): T[] {
  const used = new Set<string>();
  // Prochain suffixe à essayer par id : il ne recule jamais, donc le total reste linéaire même pour des
  // milliers d'entrées de même id (le parse tourne dans le processus qui héberge tous les bots du nœud).
  const nextSuffix = new Map<string, number>();
  const renamed: string[] = [];
  let renamedCount = 0;
  const result = entries.map((entry) => {
    if (!used.has(entry.id)) {
      used.add(entry.id);
      return entry;
    }
    let suffix = nextSuffix.get(entry.id) ?? 2;
    while (used.has(`${entry.id}#${suffix}`)) suffix += 1;
    nextSuffix.set(entry.id, suffix + 1);
    const id = `${entry.id}#${suffix}`;
    used.add(id);
    renamedCount += 1;
    if (renamed.length < MAX_LOGGED_RENAMES) renamed.push(`${entry.id} -> ${id}`);
    return { ...entry, id };
  });
  if (renamedCount > 0) {
    const more = renamedCount > renamed.length ? `, … (${renamedCount - renamed.length} autre(s))` : '';
    console.warn(`[js-bot-config] scheduled : identifiants en double renommés (${renamed.join(', ')}${more})`);
  }
  return result;
}

/** `prefixes` : liste de chaînes ; les éléments d'un autre type sont écartés (la validité de chaque préfixe se juge dans `resolveCommandPrefixes`). */
const prefixesSchema = tolerant(
  'prefixes',
  z.array(z.unknown()).transform((items) => {
    const strings = items.filter((item): item is string => typeof item === 'string');
    if (strings.length !== items.length) {
      warnIgnored('prefixes', `${items.length - strings.length} élément(s) non textuel(s) écarté(s)`);
    }
    return strings;
  }),
);

/** `jsFunctions` : seuls les objets sont gardés ; la validation fine (nom, paramètres, taille) appartient au chargeur de fonctions. */
const jsFunctionsSchema = tolerant(
  'jsFunctions',
  z.array(z.unknown()).transform((items) => {
    const records = items.filter(isRecord);
    if (records.length !== items.length) {
      warnIgnored('jsFunctions', `${items.length - records.length} entrée(s) qui ne sont pas des objets écartée(s)`);
    }
    return records;
  }),
);

export const jsBotConfigSchema = z.object({
  token: z.string().default(''),
  intents: z.record(z.boolean()).default({}),
  prefix: z.string().optional(),
  /** Préfixes supplémentaires (max 5, 1 à 5 caractères sans espace) : voir `resolveCommandPrefixes`. */
  prefixes: prefixesSchema,
  /** Variable (nom, avec ou sans `bc_`) dont la valeur REMPLACE la liste statique de préfixes pour le serveur. */
  prefixVariable: tolerant('prefixVariable', z.string()),
  /** Portée de `prefixVariable` : `guild` si absent. */
  prefixVariableScope: tolerant('prefixVariableScope', z.enum(['guild', 'global'])),
  /** Option à activer avant tout usage de `noPrefix` sur une commande. */
  allowNoPrefixCommands: tolerant('allowNoPrefixCommands', z.boolean()),
  /** `<@bot> commande` se comporte comme un préfixe pour toutes les commandes prefix|hybrid. */
  mentionAsPrefix: tolerant('mentionAsPrefix', z.boolean()),
  /** Salon où le Manager fait tester pour de vrai les commandes à préfixe par le bot lui-même ; vide = inactif. */
  testChannelId: tolerant('testChannelId', z.string()),
  /** Bibliothèque de fonctions JavaScript du bot (global `fn`) ; absent ou null = aucune. */
  jsFunctions: jsFunctionsSchema,
  /** Musique Lavalink (objet `voice` des scripts) ; absent = éteinte. Réservé au Premium (appliqué par le Manager). */
  lavalink: lavalinkConfigSchema,
  autoRestart: z.boolean().default(true),
  presence: presenceSchema,
  databaseConfig: databaseConfigSchema.default({ type: 'none' }),
  commands: z.array(commandHandlerSchema).nullish().transform((value) => value ?? []),
  events: z.array(eventHandlerSchema).nullish().transform((value) => value ?? []),
  scheduled: z
    .array(scheduledHandlerSchema)
    .nullish()
    .transform((value) => dedupeScheduledIds(value ?? [])),
  inboundWebhooks: z
    .array(inboundWebhookHandlerSchema)
    .nullish()
    .transform((value) => value ?? []),
  globalVariables: z.record(z.unknown()).default({}),
  scopedVariableDefinitions: z.array(z.record(z.unknown())).default([]),
  scriptTimeoutMs: z
    .number()
    .int()
    .positive()
    .max(MAX_SCRIPT_TIMEOUT_MS)
    .default(DEFAULT_SCRIPT_TIMEOUT_MS),
});

export type CommandHandler = z.infer<typeof commandHandlerSchema>;
export type EventHandler = z.infer<typeof eventHandlerSchema>;
export type ScheduledHandler = z.infer<typeof scheduledHandlerSchema>;
export type InboundWebhookHandler = z.infer<typeof inboundWebhookHandlerSchema>;
export type LavalinkServer = z.infer<typeof lavalinkServerSchema>;
export type DatabaseConfig = z.infer<typeof databaseConfigSchema>;
export type JsBotConfig = z.infer<typeof jsBotConfigSchema>;

export const botSyncPayloadSchema = z.object({
  botId: z.string().min(1),
  botName: z.string().default(''),
  config: z.record(z.unknown()),
});

const PRESENCE_ACTIVITY_TYPES = new Set(['playing', 'streaming', 'listening', 'watching', 'competing', 'custom']);
const PRESENCE_STATUSES = new Set(['online', 'idle', 'dnd', 'invisible']);

/**
 * Le Manager, le Studio, le Copilot et le MCP enregistrent la présence sous `presenceStatus` et `statuses`
 * (ou `activities`) ; seule l'app écrit `presence`. Sans `presence`, on la dérive de ces clés.
 */
function withDerivedPresence(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return raw;
  }
  const config = raw as Record<string, unknown>;
  if (config.presence != null) {
    return raw;
  }
  const list = Array.isArray(config.activities) ? config.activities : config.statuses;
  const hasStatus = typeof config.presenceStatus === 'string' && PRESENCE_STATUSES.has(config.presenceStatus);
  if (!Array.isArray(list) && !hasStatus) {
    return raw;
  }
  const activities = (Array.isArray(list) ? list : []).flatMap((entry) => {
    if (!entry || typeof entry !== 'object') {
      return [];
    }
    const item = entry as Record<string, unknown>;
    const name = String(item.name ?? item.text ?? '').trim();
    if (!name) {
      return [];
    }
    const type = String(item.type ?? 'playing').trim().toLowerCase();
    const url = typeof item.url === 'string' && item.url.trim() ? item.url.trim() : undefined;
    const positive = (value: unknown): number | undefined => {
      const n = Number(value);
      return Number.isFinite(n) && n > 0 ? n : undefined;
    };
    return [
      {
        type: PRESENCE_ACTIVITY_TYPES.has(type) ? type : 'playing',
        name,
        ...(url ? { url } : {}),
        ...(positive(item.minIntervalSeconds) ? { minIntervalSeconds: positive(item.minIntervalSeconds) } : {}),
        ...(positive(item.maxIntervalSeconds) ? { maxIntervalSeconds: positive(item.maxIntervalSeconds) } : {}),
      },
    ];
  });
  return { ...config, presence: { status: hasStatus ? config.presenceStatus : 'online', activities } };
}

export function parseJsBotConfig(raw: unknown): JsBotConfig {
  return jsBotConfigSchema.parse(withDerivedPresence(raw));
}

export function validateJsBotConfig(config: JsBotConfig): void {
  jsBotConfigSchema.parse(config);

  const commandNames = new Set<string>();
  for (const command of config.commands ?? []) {
    const key = command.name.trim().toLowerCase();
    if (commandNames.has(key)) {
      throw new Error(`Duplicate command name: ${command.name}`);
    }
    commandNames.add(key);
  }

  // Several independent handlers may subscribe to the same Discord event.
  // Their IDs, rather than the event name, distinguish the handlers.
  const eventIds = new Set<string>();
  for (const event of config.events ?? []) {
    if (eventIds.has(event.id)) {
      throw new Error(`Duplicate event handler ID: ${event.id}`);
    }
    eventIds.add(event.id);
  }

  const webhookPaths = new Set<string>();
  for (const webhook of config.inboundWebhooks ?? []) {
    const key = webhook.path.trim().toLowerCase();
    if (webhookPaths.has(key)) {
      throw new Error(`Duplicate inbound webhook path: ${webhook.path}`);
    }
    webhookPaths.add(key);
  }

  // Les entrées `scheduled` ne sont PAS contrôlées ici : des ids en double sont dédupliqués au parse
  // (`dedupeScheduledIds`) et une entrée sans planification valide est ignorée par le planificateur.
  // Les rejeter ferait échouer la synchro de bots qui fonctionnent aujourd'hui.
}

// Invocation mode is independent from Discord's application-command type.
// Historical handlers with no flags supported both routes.
export function commandTriggerType(command: CommandHandler): 'prefix' | 'slash' | 'hybrid' | 'none' {
  if (command.triggerType) return command.triggerType;
  const data = command.data ?? {};
  const declared = data.triggerType;
  if (declared === 'prefix' || declared === 'slash' || declared === 'hybrid' || declared === 'none') return declared;
  if ((data.legacyModeEnabled ?? command.legacyModeEnabled) === true) return 'prefix';
  if ((data.legacyLocalOnly ?? command.legacyLocalOnly) === true || data.localOnly === true) return 'none';
  if ((data.legacyModeEnabled ?? command.legacyModeEnabled) === false) return 'slash';
  return 'hybrid';
}
export function supportsSlash(command: CommandHandler): boolean {
  return ['slash', 'hybrid'].includes(commandTriggerType(command));
}
export function supportsPrefix(command: CommandHandler): boolean {
  return ['prefix', 'hybrid'].includes(commandTriggerType(command));
}

export const DEFAULT_COMMAND_PREFIX = '!';

// Prefix commands must keep working when the config carries no `prefix` (the app only
// writes one once the user saved the bot settings): fall back to the app default `!`
// as soon as a command is explicitly prefix/hybrid, instead of silently ignoring them.
export function resolveCommandPrefix(config: { prefix?: string; commands?: CommandHandler[] }): string {
  const configured = config.prefix?.trim();
  if (configured) return configured;
  const hasExplicitPrefixCommand = (config.commands ?? []).some((command) => {
    if (command.enabled === false) return false;
    const data = command.data ?? {};
    const declared = command.triggerType ?? data.triggerType;
    if (declared === 'prefix' || declared === 'hybrid') return true;
    return (data.legacyModeEnabled ?? command.legacyModeEnabled) === true;
  });
  return hasExplicitPrefixCommand ? DEFAULT_COMMAND_PREFIX : '';
}

/** Un préfixe supplémentaire (ou une entrée de la variable de préfixe) : 1 à 5 points de code, sans espace. */
export const MAX_PREFIX_LENGTH = 5;
/** Nombre maximal de préfixes supplémentaires (`prefixes`, ou entrées de la variable de préfixe). */
export const MAX_PREFIX_ENTRIES = 5;

function codePointLength(value: string): number {
  return Array.from(value).length;
}

/**
 * Entrée de préfixe nettoyée, ou null si elle est invalide (non textuelle, vide, contenant un espace ou un
 * saut de ligne, plus de 5 caractères). La longueur se compte en POINTS DE CODE (un emoji vaut 1), comme le
 * Manager (`[]rune`), et non en unités UTF-16.
 */
export function normalizePrefixEntry(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const entry = raw.trim();
  if (!entry || /\s/u.test(entry)) return null;
  return codePointLength(entry) <= MAX_PREFIX_LENGTH ? entry : null;
}

/**
 * Préfixes statiques effectifs : `[prefix, ...prefixes]` dédupliqués, les plus longs d'abord (`!!` avant `!`
 * pour qu'un message `!!ping` ne soit pas lu comme `!` + `!ping`), jamais de préfixe vide.
 *
 * - `prefix` garde sa lecture historique (rognée, non vide, sans borne de longueur : il n'a jamais été
 *   limité à 5 caractères côté runner) ; seules les entrées de `prefixes` sont validées, et écartées sans
 *   rejet si elles sont invalides (au plus 5 entrées valides et distinctes).
 * - Repli `!` (comme `resolveCommandPrefix`) seulement quand AUCUN préfixe n'est configuré et qu'une commande
 *   prefix|hybrid active existe : `prefix: ''` avec `prefixes: ['?']` donne `['?']`, pas `['?', '!']`.
 *
 * `resolveCommandPrefix` (un seul préfixe) reste inchangée.
 */
export function resolveCommandPrefixes(config: {
  prefix?: string;
  prefixes?: string[];
  commands?: CommandHandler[];
}): string[] {
  const list: string[] = [];
  const seen = new Set<string>();

  const primary = typeof config.prefix === 'string' ? config.prefix.trim() : '';
  if (primary) {
    list.push(primary);
    seen.add(primary);
  }

  let extras = 0;
  for (const raw of Array.isArray(config.prefixes) ? config.prefixes : []) {
    if (extras >= MAX_PREFIX_ENTRIES) break;
    const entry = normalizePrefixEntry(raw);
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    list.push(entry);
    extras += 1;
  }

  if (list.length === 0) {
    const fallback = resolveCommandPrefix({ commands: config.commands });
    return fallback ? [fallback] : [];
  }
  // Tri stable : à longueur égale, l'ordre déclaré est conservé.
  return list.sort((left, right) => codePointLength(right) - codePointLength(left));
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * Vrai si la commande peut être invoquée sans préfixe : prefix|hybrid, activée, et `noPrefix` à vrai
 * (`data.noPrefix ?? noPrefix`, une valeur non booléenne étant ignorée). N'inclut PAS le réglage du bot
 * `allowNoPrefixCommands` (double opt-in) ni la disponibilité de l'intent Message Content : l'appelant les
 * contrôle.
 */
export function commandAllowsNoPrefix(command: CommandHandler): boolean {
  if (command.enabled === false || !supportsPrefix(command)) return false;
  return (readBoolean(command.data?.noPrefix) ?? command.noPrefix) === true;
}
