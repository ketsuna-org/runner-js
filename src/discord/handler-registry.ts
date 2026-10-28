import {
  Events,
  PermissionsBitField,
  type Channel,
  type Client,
  type Guild,
  type GuildMember,
  type Interaction,
  type Message,
} from 'discord.js';

import {
  commandAllowsNoPrefix,
  commandTriggerType,
  supportsSlash,
  supportsPrefix,
  resolveCommandPrefix,
  resolveCommandPrefixes,
  type CommandHandler,
  type EventHandler,
  type InboundWebhookHandler,
  type JsBotConfig,
} from '../config/js-bot-config.js';
import { createInteractionMessageCompat } from './hybrid-message-compat.js';
import {
  NO_PREFIX_MAX_PER_WINDOW,
  NO_PREFIX_USER_COOLDOWN_MS,
  NO_PREFIX_WINDOW_MS,
  PrefixResolver,
  mentionsWithoutUser,
  observePrefixVariableWrites,
  parseInvocation,
  prefixVariableStorageKey,
  type InvocationSource,
  type MessageInvocation,
} from './message-invocation.js';
import { ScheduledTasks, type ScheduledTaskEntry, type TaskRunOutcome } from '../runtime/scheduled-tasks.js';
import type { ScriptExecutor } from '../scripts/script-executor.js';
import type { ScriptRunLifecycle } from '../scripts/script-runtime.js';
import type { ScriptLogger } from '../scripts/script-context.js';
import {
  normalizeScriptMember,
  resolveScriptGuildChannel,
  withScriptView,
} from '../scripts/script-member.js';
import { ScriptDb } from '../scripts/script-db.js';
import { buildScriptVariables, type ScopedExecutionContext } from '../runtime/scoped-context.js';
import type { VariableDatabase } from '../runtime/variable-database.js';
import type { DatabaseHandles } from '../runtime/database-manager.js';
import type { MusicManager } from '../runtime/music/music-manager.js';
import {
  collectAutocompleteBindings,
  filterStaticAutocompleteChoices,
  findAutocompleteBinding,
  resolveInteractionOptionPath,
  type AutocompleteBinding,
} from './command-options.js';

type HandlerDisposer = () => void;

export interface HandlerRegistryOptions {
  /**
   * L'intent Message Content est réellement actif sur la connexion (approuvé au portail ET demandé).
   * Sans lui, les commandes sans préfixe sont désactivées (avertissement unique) ; la mention continue de
   * marcher, Discord fournit le contenu des messages qui mentionnent le bot. Faux si non précisé.
   */
  messageContentAvailable?: boolean;
  /** Horloge injectable (cache de la variable de préfixe, garde-fous sans préfixe). */
  now?: () => number;
  /**
   * Planificateur des tâches `scheduled`, fourni par le propriétaire du client (le runner) : il survit au
   * remontage du registre et à la reconnexion. Sans lui, le registre crée le sien et l'arrête dans `clear()`.
   */
  scheduler?: ScheduledTasks;
  /** Musique du bot, fournie par le runner (global `voice` des scripts) ; absente = `voice` indéfini. */
  music?: MusicManager;
}

const NO_PREFIX_MAX_TRACKED_COOLDOWNS = 2_000;

export class HandlerRegistry {
  private readonly disposers: HandlerDisposer[] = [];
  private readonly scheduler: ScheduledTasks;
  private readonly ownsScheduler: boolean;
  private readonly prefixMap = new Map<string, CommandHandler>();
  private readonly noPrefixMap = new Map<string, CommandHandler>();
  private readonly commandMap = new Map<string, CommandHandler>();
  private readonly webhookMap = new Map<string, InboundWebhookHandler>();
  private readonly inFlightInteractions = new Set<string>();
  private readonly handledInteractions = new Set<string>();
  private autocompleteBindings: AutocompleteBinding[] = [];
  private readonly scriptLogger: ScriptLogger;
  private databaseHandles?: DatabaseHandles;
  private readonly music?: MusicManager;
  private readonly variableStore: VariableDatabase;
  private readonly prefixResolver: PrefixResolver;
  private readonly messageContentAvailable: boolean;
  private readonly now: () => number;
  /** Préfixes de la configuration (`prefix` + `prefixes`), recalculés à chaque `mount()`. */
  private staticPrefixes: string[] = [];
  /** Commandes qui déclarent `noPrefix`, que le bot l'autorise ou non (sert à expliquer l'inaction). */
  private noPrefixDeclared = 0;
  private warnedNoPrefixOptIn = false;
  private warnedNoPrefixIntent = false;
  private noPrefixWindowStart = Number.NEGATIVE_INFINITY;
  private noPrefixWindowCount = 0;
  private warnedNoPrefixRate = false;
  private readonly noPrefixCooldowns = new Map<string, number>();

  constructor(
    private readonly client: Client,
    private config: JsBotConfig,
    private readonly botId: string,
    private readonly executor: ScriptExecutor,
    variableStore: VariableDatabase,
    private readonly emitLog: (level: 'info' | 'warn' | 'error' | 'debug', message: string) => void,
    databaseHandles?: DatabaseHandles,
    options: HandlerRegistryOptions = {},
  ) {
    this.databaseHandles = databaseHandles;
    this.music = options.music;
    this.messageContentAvailable = options.messageContentAvailable === true;
    this.now = options.now ?? Date.now;
    this.prefixResolver = new PrefixResolver({
      botId,
      store: variableStore,
      getConfig: () => this.config,
      now: this.now,
      onError: (message) => this.emitLog('warn', message),
    });
    // Les scripts écrivent par cette enveloppe : changer la variable de préfixe (db.guild.set…) vide le cache.
    this.variableStore = observePrefixVariableWrites(
      variableStore,
      () => prefixVariableStorageKey(this.config.prefixVariable),
      () => this.prefixResolver.invalidate(),
    );
    this.scriptLogger = {
      log: (...args: unknown[]) => this.emitLog('info', args.map(String).join(' ')),
      info: (...args: unknown[]) => this.emitLog('info', args.map(String).join(' ')),
      warn: (...args: unknown[]) => this.emitLog('warn', args.map(String).join(' ')),
      error: (...args: unknown[]) => this.emitLog('error', args.map(String).join(' ')),
      debug: (...args: unknown[]) => this.emitLog('debug', args.map(String).join(' ')),
    };
    this.ownsScheduler = options.scheduler === undefined;
    this.scheduler =
      options.scheduler ??
      new ScheduledTasks({
        run: (entry) => this.runScheduled(entry),
        // Un client sans `isReady` (EventEmitter de test) compte comme prêt.
        isReady: () => {
          const isReady = (this.client as { isReady?: () => boolean }).isReady;
          return typeof isReady === 'function' ? isReady.call(this.client) : true;
        },
        log: (level, message) => this.emitLog(level, message),
      });
  }

  mount(): void {
    this.unmountRoutes();
    this.staticPrefixes = resolveCommandPrefixes(this.config);

    for (const command of this.config.commands ?? []) {
      if (command.enabled === false) {
        continue;
      }
      this.addCommand(command);
    }
    this.warnIfNoPrefixCannotWork();

    for (const event of this.config.events ?? []) {
      if (event.enabled === false) {
        continue;
      }
      this.attachEvent(event);
    }

    for (const webhook of this.config.inboundWebhooks ?? []) {
      if (webhook.enabled === false) {
        continue;
      }
      this.webhookMap.set(webhook.path.trim().toLowerCase(), webhook);
    }

    // Réconciliation, pas recréation : une tâche inchangée garde son timer (un rechargement ne remet rien à zéro).
    this.scheduler.reconcile(this.config.scheduled);
    const onClientReady = () => this.scheduler.markReady();
    this.client.once(Events.ClientReady, onClientReady);
    this.disposers.push(() => this.client.off(Events.ClientReady, onClientReady));

    const onInteraction = async (interaction: Interaction) => {
      if (interaction.isAutocomplete()) {
        await this.handleAutocomplete(interaction);
        return;
      }

      // Slash + context-menu commands share the command map by name.
      if (!interaction.isChatInputCommand() && !interaction.isContextMenuCommand()) {
        return;
      }

      if (!this.tryAcquireInteraction(interaction.id)) {
        return;
      }

      const handler = this.commandMap.get(interaction.commandName.trim().toLowerCase());
      if (!handler) {
        this.releaseInteraction(interaction.id);
        return;
      }

      try {
        await this.runScript(handler.script, {
          interaction,
          guild: interaction.guild,
          member: interaction.member,
          channel: interaction.channel,
          // Hybrid command run from slash: give `message.reply(...)` & co. a target.
          compatMessage:
            interaction.isChatInputCommand() && commandTriggerType(handler) === 'hybrid'
              ? createInteractionMessageCompat(interaction)
              : undefined,
        });
      } finally {
        this.releaseInteraction(interaction.id);
      }
    };

    this.client.on(Events.InteractionCreate, onInteraction);
    this.disposers.push(() => this.client.off(Events.InteractionCreate, onInteraction));

    {
      const onMessage = (message: Message) => this.handleMessage(message);

      this.client.on(Events.MessageCreate, onMessage);
      this.disposers.push(() => this.client.off(Events.MessageCreate, onMessage));
    }
  }

  /**
   * Test réel d'une commande à préfixe : le Manager fait écrire le bot lui-même dans le salon de test réglé
   * par son propriétaire, avec une marque (`nonce` commençant par `bctest:`). Les trois conditions sont requises ;
   * les réponses du bot n'ont pas la marque, donc pas de boucle.
   */
  private isSelfTestMessage(message: Message): boolean {
    const testChannel = this.config.testChannelId;
    return (
      typeof testChannel === 'string' &&
      testChannel !== '' &&
      message.author?.id === this.client.user?.id &&
      message.channelId === testChannel &&
      typeof message.nonce === 'string' &&
      message.nonce.startsWith('bctest:')
    );
  }

  /**
   * Route un message vers une commande : préfixe (statique ou variable), mention du bot placée en tête
   * (`mentionAsPrefix`), puis nom seul (`noPrefix`, double opt-in). Voir `parseInvocation`.
   */
  private async handleMessage(message: Message): Promise<void> {
    if (!message || message.webhookId || message.system) {
      return;
    }
    if (message.author?.bot && !this.isSelfTestMessage(message)) {
      return;
    }
    if (typeof message.content !== 'string' || !message.content) {
      return;
    }
    if (this.prefixMap.size === 0) {
      return;
    }

    const guildId = message.guildId ?? message.guild?.id ?? null;
    const prefixes = await this.prefixResolver.resolve(guildId, this.staticPrefixes);
    const invocation = parseInvocation(message.content, {
      botId: this.client.user?.id ?? null,
      prefixes,
      mentionEnabled: this.config.mentionAsPrefix === true,
      noPrefixEnabled: this.noPrefixMap.size > 0 && this.messageContentAvailable && guildId !== null,
    });
    if (!invocation) {
      return;
    }

    const handler = (invocation.source === 'noPrefix' ? this.noPrefixMap : this.prefixMap).get(invocation.name);
    if (!handler) {
      return;
    }
    if (invocation.source === 'noPrefix' && !this.passNoPrefixCooldown(message.author?.id, handler)) {
      return;
    }
    if (!(await this.memberMeetsDefaultPermissions(handler, message, invocation.source))) {
      return;
    }
    // Le plafond du bot ne compte que les exécutions réelles : une tentative refusée par la permission de la
    // commande ne doit pas priver les autres membres de leurs commandes sans préfixe.
    if (invocation.source === 'noPrefix' && !this.takeNoPrefixSlot()) {
      return;
    }

    await this.runScript(handler.script, {
      message,
      guild: message.guild,
      member: message.member,
      channel: message.channel,
      invocation,
    });
  }

  /**
   * `default_member_permissions` de la commande appliqué aux trois routes (préfixe, mention, sans préfixe).
   * Refus silencieux, journal debug ; sans membre résolvable (message
   * privé) ou avec une valeur illisible, la commande est refusée plutôt qu'ouverte à tous.
   */
  private async memberMeetsDefaultPermissions(
    command: CommandHandler,
    message: Message,
    source: InvocationSource,
  ): Promise<boolean> {
    const required = requiredMemberPermissions(command);
    if (required === null) {
      return true;
    }
    const member = normalizeScriptMember(await resolveScriptMember(message, message.member ?? null));
    const permissions = (member as { permissions?: { has?: (bits: bigint) => boolean } } | null)?.permissions;
    const allowed =
      typeof permissions?.has === 'function' &&
      (required === 0n
        ? permissions.has(PermissionsBitField.Flags.Administrator)
        : permissions.has(required));
    if (!allowed) {
      this.emitLog(
        'debug',
        `Command ${command.name} refused for user ${message.author?.id ?? 'unknown'}: missing default member permissions (${source} route)`,
      );
    }
    return allowed;
  }

  /**
   * Garde-fous du sans-préfixe (n'importe quel message qui s'écrit comme un nom de commande peut déclencher),
   * en deux temps. D'abord le délai par (utilisateur, commande), posé dès la tentative : il ne pénalise que
   * l'auteur du message. Puis, une fois la permission de la commande contrôlée, `takeNoPrefixSlot` : plafond
   * d'exécutions par fenêtre pour tout le bot. L'excédent est ignoré.
   */
  private passNoPrefixCooldown(userId: string | undefined, command: CommandHandler): boolean {
    const now = this.now();
    const cooldownKey = `${userId ?? ''}:${command.id}`;
    const last = this.noPrefixCooldowns.get(cooldownKey);
    if (last !== undefined && now - last < NO_PREFIX_USER_COOLDOWN_MS) {
      return false;
    }
    this.noPrefixCooldowns.set(cooldownKey, now);
    if (this.noPrefixCooldowns.size > NO_PREFIX_MAX_TRACKED_COOLDOWNS) {
      for (const [key, at] of this.noPrefixCooldowns) {
        if (now - at >= NO_PREFIX_USER_COOLDOWN_MS) this.noPrefixCooldowns.delete(key);
      }
      if (this.noPrefixCooldowns.size > NO_PREFIX_MAX_TRACKED_COOLDOWNS) {
        this.noPrefixCooldowns.clear();
      }
    }
    return true;
  }

  /** Prend une place dans la fenêtre d'exécutions sans préfixe du bot ; faux (avec un seul avertissement) si elle est pleine. */
  private takeNoPrefixSlot(): boolean {
    const now = this.now();
    if (now - this.noPrefixWindowStart >= NO_PREFIX_WINDOW_MS) {
      this.noPrefixWindowStart = now;
      this.noPrefixWindowCount = 0;
      this.warnedNoPrefixRate = false;
    }
    if (this.noPrefixWindowCount >= NO_PREFIX_MAX_PER_WINDOW) {
      if (!this.warnedNoPrefixRate) {
        this.warnedNoPrefixRate = true;
        this.emitLog(
          'warn',
          `No-prefix commands rate limited: more than ${NO_PREFIX_MAX_PER_WINDOW} runs in ${NO_PREFIX_WINDOW_MS / 1000}s, extra messages are ignored.`,
        );
      }
      return false;
    }
    this.noPrefixWindowCount += 1;
    return true;
  }

  /** Une seule explication par registre quand des commandes `noPrefix` existent mais ne peuvent pas servir. */
  private warnIfNoPrefixCannotWork(): void {
    if (this.noPrefixDeclared === 0) {
      return;
    }
    if (this.config.allowNoPrefixCommands !== true) {
      if (!this.warnedNoPrefixOptIn) {
        this.warnedNoPrefixOptIn = true;
        this.emitLog(
          'warn',
          'Ignoring no-prefix commands: allowNoPrefixCommands is not enabled for this bot.',
        );
      }
      return;
    }
    if (!this.messageContentAvailable && !this.warnedNoPrefixIntent) {
      this.warnedNoPrefixIntent = true;
      this.emitLog(
        'warn',
        'Ignoring no-prefix commands: the Message Content intent is not available for this bot (enable it in the Discord Developer Portal).',
      );
    }
  }

  updateConfig(config: JsBotConfig, databaseHandles?: DatabaseHandles): void {
    this.config = config;
    if (databaseHandles !== undefined) {
      this.databaseHandles = databaseHandles;
    }
    this.mount();
  }

  /**
   * Une variable vient d'être écrite HORS des scripts (API du runner : Manager, MCP, application). Si c'est la
   * variable de préfixe, la lecture mémorisée est oubliée pour que le nouveau préfixe serve tout de suite, comme
   * pour une écriture par script (`observePrefixVariableWrites`). `storageKey` : avec ou sans `bc_`.
   */
  notifyVariableWrite(storageKey: string): void {
    const watched = prefixVariableStorageKey(this.config.prefixVariable);
    if (watched !== null && prefixVariableStorageKey(storageKey) === watched) {
      this.prefixResolver.invalidate();
    }
  }

  upsertCommand(command: CommandHandler): void {
    this.deleteCommand(command.id, command.name);

    if (command.enabled === false) {
      return;
    }

    this.addCommand(command);
  }

  /**
   * Mots qui déclenchent la commande hors slash : `prefixName` / `legacyPrefixOverride`, sinon le nom, puis les
   * alias. Un nom principal remplace une entrée existante, un alias ne remplace jamais. Mêmes mots pour la
   * route préfixe, la route mention et la route sans préfixe.
   */
  private registerTriggerWords(map: Map<string, CommandHandler>, command: CommandHandler): void {
    const primaryName = command.name.trim().toLowerCase();
    const prefixName = command.prefixName ||
      String(command.data?.legacyPrefixOverride ?? command.legacyPrefixOverride ?? '') || primaryName;
    map.set(prefixName.trim().toLowerCase(), command);
    const aliases = command.aliases.length ? command.aliases :
      command.legacyAliases ?? (Array.isArray(command.data?.legacyAliases) ? command.data.legacyAliases : []);
    for (const alias of aliases) {
      if (typeof alias !== 'string') continue;
      const cleanAlias = alias.trim().toLowerCase();
      if (cleanAlias && !map.has(cleanAlias)) map.set(cleanAlias, command);
    }
  }

  private addCommand(command: CommandHandler): void {
    const primaryName = command.name.trim().toLowerCase();
    if (supportsPrefix(command)) {
      this.registerTriggerWords(this.prefixMap, command);
      if (commandAllowsNoPrefix(command)) {
        this.noPrefixDeclared += 1;
        if (this.config.allowNoPrefixCommands === true) {
          this.registerTriggerWords(this.noPrefixMap, command);
        }
      }
    }
    if (supportsSlash(command)) {
      this.commandMap.set(primaryName, command);
      this.autocompleteBindings.push(...collectAutocompleteBindings(primaryName,
        (command.options ?? []).filter((option): option is Record<string, unknown> =>
          typeof option === 'object' && option !== null)));
    }
  }

  deleteCommand(commandId?: string, commandName?: string): void {
    const cleanName = commandName?.trim().toLowerCase();
    const cleanId = commandId?.trim();

    for (const map of [this.commandMap, this.prefixMap, this.noPrefixMap]) {
      for (const [key, cmd] of map.entries()) {
        const matchesId = Boolean(cleanId && cmd.id === cleanId);
        const matchesName = Boolean(cleanName && cmd.name.trim().toLowerCase() === cleanName);
        const matchesAlias = Boolean(
          cleanName && (cmd.aliases ?? []).some((alias) => alias.trim().toLowerCase() === cleanName),
        );
        if (matchesId || matchesName || matchesAlias) map.delete(key);
      }
    }
    this.autocompleteBindings = this.autocompleteBindings.filter((binding) => {
      if (cleanName && binding.commandName.trim().toLowerCase() === cleanName) {
        return false;
      }
      return true;
    });
  }

  getWebhookHandler(pathKey: string): InboundWebhookHandler | undefined {
    return this.webhookMap.get(pathKey.trim().toLowerCase());
  }

  async triggerWebhook(
    pathKey: string,
    payload: unknown,
    headers: Record<string, string>,
  ): Promise<boolean> {
    const handler = this.getWebhookHandler(pathKey);
    if (!handler) {
      return false;
    }

    await this.runScript(handler.script, {
      webhook: { path: pathKey, payload, headers },
    });
    return true;
  }

  /**
   * Arrêt complet : démontage des routes ET des tâches planifiées du registre. Un planificateur fourni par le
   * propriétaire du client n'est pas touché ici (il survit à la reconnexion ; son propriétaire l'arrête).
   */
  clear(): void {
    this.unmountRoutes();
    if (this.ownsScheduler) {
      this.scheduler.stop();
    }
  }

  /** Planificateur utilisé par ce registre (diagnostic, tests). */
  getScheduler(): ScheduledTasks {
    return this.scheduler;
  }

  /** Démontage des routes (écouteurs, cartes de commandes) sans toucher aux tâches planifiées : sert à `mount()`. */
  private unmountRoutes(): void {
    for (const dispose of this.disposers) {
      dispose();
    }
    this.disposers.length = 0;

    this.commandMap.clear();
    this.prefixMap.clear();
    this.noPrefixMap.clear();
    this.noPrefixDeclared = 0;
    this.webhookMap.clear();
    this.autocompleteBindings = [];
    this.prefixResolver.invalidate();
  }

  private async handleAutocomplete(interaction: Interaction): Promise<void> {
    if (!interaction.isAutocomplete()) {
      return;
    }

    const focused = interaction.options.getFocused(true);
    const optionPath = resolveInteractionOptionPath(interaction);
    const binding = findAutocompleteBinding(
      interaction.commandName.trim().toLowerCase(),
      optionPath,
      focused.name,
      this.autocompleteBindings,
    );

    if (!binding) {
      await interaction.respond([]).catch(() => undefined);
      return;
    }

    const mode = String(binding.config.mode ?? 'javascript').trim().toLowerCase();
    if (mode === 'static') {
      const choices = filterStaticAutocompleteChoices(
        binding.config,
        String(focused.value ?? ''),
      );
      await interaction.respond(choices);
      return;
    }

    if (mode === 'javascript') {
      const script = String(binding.config.jsScript ?? '').trim();
      if (!script) {
        await interaction.respond([]).catch(() => undefined);
        return;
      }

      try {
        await this.runScript(script, { interaction });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.emitLog('error', `Autocomplete script failed: ${message}`);
        await interaction.respond([]).catch(() => undefined);
      }
      return;
    }

    this.emitLog(
      'warn',
      `Autocomplete mode "${mode}" is not supported by the JavaScript runner.`,
    );
    await interaction.respond([]).catch(() => undefined);
  }

  private attachEvent(handler: EventHandler): void {
    const eventName = handler.name.trim();
    const listener = async (...args: unknown[]) => {
      const context = resolveEventExecutionContext(args);

      if (context.interaction?.isChatInputCommand() || context.interaction?.isContextMenuCommand()) {
        const slashHandler = this.commandMap.get(
          context.interaction.commandName.trim().toLowerCase(),
        );
        if (slashHandler) {
          return;
        }
      }

      if (handler.customIdFilter && !interactionMatchesCustomId(context.interaction, handler.customIdFilter)) {
        return;
      }

      if (context.message && this.isPrefixCommandMessage(context.message)) {
        return;
      }

      await this.runScript(handler.script, {
        message: context.message,
        interaction: context.interaction,
        guild: context.guild,
        member: context.member,
        channel: context.channel,
        webhook: undefined,
      });
    };

    this.client.on(eventName, listener);
    this.disposers.push(() => this.client.off(eventName, listener));
  }

  private isPrefixCommandMessage(message: Message): boolean {
    const prefix = resolveCommandPrefix(this.config);
    if (!prefix || message.author.bot || !message.content.startsWith(prefix)) {
      return false;
    }

    const withoutPrefix = message.content.slice(prefix.length).trim();
    const commandName = withoutPrefix.split(/\s+/)[0]?.toLowerCase();
    if (!commandName) {
      return false;
    }

    return this.commandMap.has(commandName);
  }

  /**
   * Exécute le script d'une tâche planifiée (appelé par le planificateur). `interaction` et `message` sont
   * indéfinis dans un script planifié. Le timeout propre à la tâche ne dépasse jamais `scriptTimeoutMs`.
   * Le résultat est journalisé par le planificateur, pas ici.
   */
  async runScheduled(entry: ScheduledTaskEntry): Promise<TaskRunOutcome> {
    const limit = this.config.scriptTimeoutMs;
    const timeoutMs =
      entry.timeoutMs === undefined ? limit : limit === undefined ? entry.timeoutMs : Math.min(entry.timeoutMs, limit);
    return this.runScript(entry.script, { scheduled: { id: entry.id } }, { timeoutMs });
  }

  private async runScript(
    script: string,
    partial: {
      /** Tâche planifiée qui exécute le script (nommée dans les journaux). */
      scheduled?: { id: string };
      interaction?: Interaction;
      message?: Message;
      /** Script-only `message` stand-in (hybrid slash); never used for scoping. */
      compatMessage?: unknown;
      /** Comment le message a invoqué la commande ; exposé en `message.invocation`. */
      invocation?: MessageInvocation;
      guild?: Message['guild'] | Interaction['guild'] | null;
      member?: Message['member'] | Interaction['member'] | null;
      channel?: Message['channel'] | Interaction['channel'] | null;
      webhook?: { path: string; payload: unknown; headers: Record<string, string> };
    },
    options: { timeoutMs?: number } = {},
  ): Promise<TaskRunOutcome> {
    const startedAt = Date.now();
    // Le timeout ne tue pas le script : `settled` dit au planificateur quand il se termine vraiment.
    let timedOut = false;
    let markSettled!: () => void;
    const scriptSettled = new Promise<void>((resolve) => {
      markSettled = resolve;
    });
    const lifecycle: ScriptRunLifecycle = {
      onTimeout: () => {
        timedOut = true;
      },
      onSettled: () => markSettled(),
    };

    // Cache minimal : guilde / salon peuvent manquer (threads évincés, guilde
    // indisponible). Résolus à la demande (cache d'abord, un fetch sinon).
    const origin = partial.interaction ?? partial.message;
    const resolved = await resolveScriptGuildChannel(this.client, {
      guild: partial.guild ?? origin?.guild ?? null,
      channel: partial.channel ?? origin?.channel ?? null,
      guildId: origin?.guildId,
      channelId: origin?.channelId,
    });
    const scriptGuild = (resolved.guild ?? null) as Interaction['guild'];
    const scriptChannel = (resolved.channel ?? null) as Interaction['channel'];
    const member = normalizeScriptMember(
      await upgradeInteractionMember(
        this.client,
        partial.interaction,
        await resolveScriptMember(partial.message, partial.member ?? null),
        origin?.guildId ? scriptGuild : undefined,
      ),
    );
    const scopedCtx: ScopedExecutionContext = {
      interaction: partial.interaction,
      message: partial.message,
      guild: scriptGuild,
      member,
      channel: scriptChannel,
    };

    try {
      const variables = await buildScriptVariables(
        this.botId,
        this.config,
        this.variableStore,
        scopedCtx,
      );
      const db = new ScriptDb(
        this.botId,
        this.config,
        this.variableStore,
        scopedCtx,
        variables,
      );

      await this.executor.execute(
        script,
        {
          client: this.client,
          config: this.config,
          variables,
          db,
          sql: this.databaseHandles?.sql,
          pgsql: this.databaseHandles?.pgsql,
          mongo: this.databaseHandles?.mongo,
          voice: this.music?.forContext({
            guild: scriptGuild as Guild | null,
            userId:
              partial.interaction?.user?.id ??
              partial.message?.author?.id ??
              (partial.compatMessage as { author?: { id?: string } } | undefined)?.author?.id ??
              null,
          }),
          // Vues « script » : `member` normalisé (PermissionsBitField), `guild`
          // et `channel` résolus, même hors cache.
          interaction: partial.interaction
            ? withScriptView(partial.interaction, {
                member,
                guild: scriptGuild,
                channel: scriptChannel,
              })
            : undefined,
          message: (partial.message
            ? withScriptView(partial.message, {
                member,
                guild: scriptGuild,
                channel: scriptChannel,
                invocation: partial.invocation,
                // La mention d'en-tête n'est qu'un déclencheur : les scripts ne la voient pas dans `mentions`.
                mentions:
                  partial.invocation?.source === 'mention' && this.client.user?.id && partial.message.mentions
                    ? mentionsWithoutUser(partial.message.mentions, this.client.user.id)
                    : undefined,
              })
            : partial.compatMessage
              ? withScriptView(partial.compatMessage as object, {
                  member,
                  guild: scriptGuild,
                  channel: scriptChannel,
                })
              : undefined) as Message | undefined,
          guild: scriptGuild,
          member,
          channel: scriptChannel as never,
          webhook: partial.webhook,
        },
        this.scriptLogger,
        options.timeoutMs ?? this.config.scriptTimeoutMs,
        lifecycle,
      );
      return { ok: true, ms: Date.now() - startedAt };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failure: TaskRunOutcome = {
        ok: false,
        ms: Date.now() - startedAt,
        error: message,
        stack: error instanceof Error ? error.stack : undefined,
        settled: timedOut ? scriptSettled : undefined,
      };
      if (
        isUnknownInteractionError(message) &&
        partial.interaction?.isRepliable() &&
        (partial.interaction.replied || partial.interaction.deferred)
      ) {
        this.emitLog(
          'debug',
          `Ignored duplicate interaction response for ${partial.interaction.id}`,
        );
        return failure;
      }
      // Une tâche planifiée est journalisée par le planificateur, en une seule ligne (tâche, planification,
      // durée, pile) : pas de seconde ligne ici.
      if (partial.scheduled) {
        return failure;
      }
      // Sans la source ni la pile, « Handler script failed: x is not a function »
      // ne dit ni quelle commande, ni quelle ligne.
      const source = describeScriptSource(partial);
      const stack = error instanceof Error && error.stack ? `\n${error.stack}` : '';
      this.emitLog('error', `Handler script failed (${source}): ${message}${stack}`);
      await notifyScriptFailure(partial.interaction);
      return failure;
    }
  }

  private tryAcquireInteraction(interactionId: string): boolean {
    if (this.inFlightInteractions.has(interactionId) || this.handledInteractions.has(interactionId)) {
      return false;
    }

    this.inFlightInteractions.add(interactionId);
    return true;
  }

  private releaseInteraction(interactionId: string): void {
    this.inFlightInteractions.delete(interactionId);
    this.handledInteractions.add(interactionId);

    if (this.handledInteractions.size > 500) {
      const oldest = this.handledInteractions.keys().next().value;
      if (oldest !== undefined) {
        this.handledInteractions.delete(oldest);
      }
    }
  }
}

/**
 * `default_member_permissions` de la commande (`data.defaultMemberPermissions ?? defaultMemberPermissions`),
 * en champ de bits : `null` = aucune restriction, `0n` = administrateurs seulement (comme Discord). Une valeur
 * illisible ou négative est traitée comme `0n` (fermé par défaut).
 */
function requiredMemberPermissions(command: CommandHandler): bigint | null {
  const raw = command.data?.defaultMemberPermissions ?? command.defaultMemberPermissions;
  if (raw === undefined || raw === null) {
    return null;
  }
  const text = String(raw).trim();
  if (!text) {
    return null;
  }
  try {
    const bits = BigInt(text);
    return bits < 0n ? 0n : bits;
  } catch {
    return 0n;
  }
}

/** Même règle que le moteur Dart : seul un composant ou un formulaire du `customId` demandé passe le filtre. */
function interactionMatchesCustomId(interaction: Interaction | undefined, customId: string): boolean {
  if (!interaction) return false;
  const isComponent = typeof interaction.isMessageComponent === 'function' && interaction.isMessageComponent();
  const isModal = typeof interaction.isModalSubmit === 'function' && interaction.isModalSubmit();
  return (isComponent || isModal) && (interaction as { customId?: string }).customId === customId;
}

function isMessage(value: unknown): value is Message {
  return typeof value === 'object' && value !== null && 'author' in value && 'content' in value;
}

function isInteraction(value: unknown): value is Interaction {
  return (
    typeof value === 'object' &&
    value !== null &&
    ('isChatInputCommand' in value || 'isContextMenuCommand' in value || 'isButton' in value)
  );
}

/**
 * A script that throws used to leave its interaction unanswered: Discord then shows
 * "The application did not respond" (or a "thinking…" that never ends) and the bot's
 * owner has nothing visible to debug from. Answer with a short ephemeral notice; the
 * details stay in the bot logs, never in the channel.
 */
export const SCRIPT_FAILURE_NOTICE =
  '❌ This command failed. The bot owner can read the details in the bot logs.';

export async function notifyScriptFailure(interaction: Interaction | undefined): Promise<void> {
  if (!interaction || typeof interaction.isRepliable !== 'function' || !interaction.isRepliable()) {
    return;
  }
  if (typeof interaction.isAutocomplete === 'function' && interaction.isAutocomplete()) {
    return;
  }
  try {
    if (interaction.replied) {
      return;
    }
    if (interaction.deferred) {
      // Sur un bouton ou un menu, `deferUpdate` rend editReply = modifier le message d'origine : l'erreur d'un
      // second script effacerait le menu déjà affiché. Un suivi éphémère le laisse intact.
      if (typeof interaction.isMessageComponent === 'function' && interaction.isMessageComponent()) {
        await interaction.followUp({ content: SCRIPT_FAILURE_NOTICE, ephemeral: true });
        return;
      }
      await interaction.editReply({ content: SCRIPT_FAILURE_NOTICE, embeds: [], components: [] });
      return;
    }
    await interaction.reply({ content: SCRIPT_FAILURE_NOTICE, ephemeral: true });
  } catch {
    // Interaction expired or already answered elsewhere: nothing more to do.
  }
}

function isUnknownInteractionError(message: string): boolean {
  return message.includes('Unknown interaction');
}

/**
 * A slash-command interaction carries a RAW API member (`roles` is an array of
 * ids) when the guild is not cached; `member.roles.add(...)` then throws and a
 * role command silently did nothing. Swap it for a real GuildMember when we can.
 */
export async function upgradeInteractionMember<M>(
  client: { guilds: { fetch: (id: string) => Promise<Guild> } },
  interaction: Interaction | undefined,
  member: M,
  /** Guilde déjà résolue (`null` = introuvable : pas de nouveau fetch). */
  resolvedGuild?: Guild | null,
): Promise<M | GuildMember> {
  const roles = (member as { roles?: unknown } | null)?.roles as
    | { add?: unknown }
    | undefined;
  if (!interaction?.guildId || !member || typeof roles?.add === 'function') {
    return member;
  }
  try {
    const guild =
      resolvedGuild !== undefined
        ? resolvedGuild
        : (interaction.guild ?? (await client.guilds.fetch(interaction.guildId)));
    if (!guild) {
      return member;
    }
    return await guild.members.fetch(interaction.user.id);
  } catch {
    return member;
  }
}

/** Ce qui a déclenché le script, pour les journaux d'erreur. */
export function describeScriptSource(partial: {
  scheduled?: { id: string };
  interaction?: Interaction;
  message?: Message;
  webhook?: { path: string };
}): string {
  const interaction = partial.interaction as { commandName?: string; customId?: string } | undefined;
  if (interaction?.commandName) return `command /${interaction.commandName}`;
  if (interaction?.customId) return `component ${interaction.customId}`;
  if (partial.webhook) return `inbound webhook ${partial.webhook.path}`;
  if (partial.scheduled) return `scheduled task ${partial.scheduled.id}`;
  if (partial.message) return 'message handler';
  return 'event or scheduled handler';
}

export async function resolveScriptMember(
  message: Message | undefined,
  member: Message['member'] | Interaction['member'] | null,
): Promise<Message['member'] | Interaction['member'] | GuildMember | null> {
  if (member) {
    return member;
  }
  if (!message?.guild) {
    return null;
  }
  try {
    return await message.guild.members.fetch(message.author.id);
  } catch {
    return null;
  }
}

function resolveEventExecutionContext(args: unknown[]): {
  message?: Message;
  interaction?: Interaction;
  guild: Guild | Interaction['guild'] | null;
  member: GuildMember | Interaction['member'] | Message['member'] | null;
  channel: Message['channel'] | Interaction['channel'] | null;
} {
  const [first] = args;
  const message = isMessage(first) ? first : undefined;
  const interaction = isInteraction(first) ? first : undefined;
  const guildMember = isGuildMember(first) ? first : undefined;
  const channel = isTextBasedChannel(first) ? first : undefined;
  const guild = isGuild(first) ? first : undefined;

  return {
    message,
    interaction,
    guild: message?.guild ?? interaction?.guild ?? guildMember?.guild ?? guild ?? null,
    member: message?.member ?? interaction?.member ?? guildMember ?? null,
    channel: message?.channel ?? interaction?.channel ?? channel ?? null,
  };
}

function isGuildMember(value: unknown): value is GuildMember {
  return (
    typeof value === 'object' &&
    value !== null &&
    'guild' in value &&
    'user' in value &&
    'id' in value
  );
}

function isTextBasedChannel(value: unknown): value is Message['channel'] {
  return (
    typeof value === 'object' &&
    value !== null &&
    'isTextBased' in value &&
    typeof (value as Channel).isTextBased === 'function' &&
    (value as Channel).isTextBased()
  );
}

function isGuild(value: unknown): value is Guild {
  return typeof value === 'object' && value !== null && 'members' in value && 'id' in value;
}
