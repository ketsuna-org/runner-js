import type { CommandHandler, JsBotConfig } from '../config/js-bot-config.js';
import {
  commandHandlerSchema,
  parseJsBotConfig,
  validateJsBotConfig,
} from '../config/js-bot-config.js';
import path from 'node:path';
import type { RunnerEnv } from '../config/env.js';
import { BotStore } from './bot-store.js';
import { BotSupervisor, type BotSupervisorOptions, type ManagedBotState } from './bot-supervisor.js';
import type { DiscordRestSnapshot } from '../discord/rest-observability.js';
import type { LogStore } from './log-store.js';
import type { ScheduledSnapshot } from './scheduled-tasks.js';
import { normalizeScopedStorageKey, toScopedReferenceKey } from './variable-keys.js';
import { mergeScopedVariableDefinitions } from './scoped-context.js';
import {
  applyWorkflowToConfig,
  hotSyncIncomplete,
  removeWorkflowFromConfig,
} from './workflow-projection.js';
import type { VariableDatabase } from './variable-database.js';
import { resolveVariableStore } from './resolve-variable-store.js';
import type { VariableStoreEnv } from './resolve-variable-store.js';

export interface RunnerBotRuntimeState {
  botId: string;
  botName: string;
  state: string;
  lastSeenAt: string | null;
  lastError: string | null;
  baselineRssBytes: number | null;
  heapUsedBytes: number | null;
  guildCount: number | null;
  pid: number | null;
  discordRest?: DiscordRestSnapshot;
  /** Tâches planifiées (prochaine échéance, dernier résultat) ; seulement dans le statut d'UN bot qui tourne. */
  scheduled?: ScheduledSnapshot;
}

/** 501 avant toute écriture : le Manager retombe sur une synchro complète (voir hotSyncIncomplete). */
function assertHotSyncComplete(
  config: JsBotConfig,
  workflowName: string,
  workflow: Record<string, unknown> | null,
): void {
  if (hotSyncIncomplete(config, workflowName, workflow)) {
    const error = new Error(
      'Workflow hot-sync cannot refresh inbound webhooks; use a full sync.',
    ) as Error & { statusCode: number };
    error.statusCode = 501;
    throw error;
  }
}

export class RuntimeController {
  readonly botStore: BotStore;
  readonly variableStore: VariableDatabase;
  private readonly processManager: BotSupervisor;

  static async create(
    dataDir: string,
    logStore: LogStore,
    env: VariableStoreEnv & Pick<RunnerEnv, 'poolMaxBots'>,
  ): Promise<RuntimeController> {
    const variableStore = await resolveVariableStore(dataDir, env);
    return new RuntimeController(dataDir, logStore, variableStore, env.poolMaxBots);
  }

  constructor(
    dataDir: string,
    logStore: LogStore,
    variableStore: VariableDatabase,
    maxBots = 1,
    createRunner?: BotSupervisorOptions['createRunner'],
  ) {
    this.botStore = new BotStore(path.join(dataDir, 'synced-bots'));
    this.variableStore = variableStore;
    this.processManager = new BotSupervisor({
      botStore: this.botStore,
      logStore,
      variableStore,
      maxBots,
      createRunner,
      stateDir: path.join(dataDir, 'run-state'),
    });
  }

  setMaxBots(maxBots: number): void {
    this.processManager.setMaxBots(maxBots);
  }

  get isRunning(): boolean {
    return this.processManager.runningCount > 0;
  }

  get runningCount(): number {
    return this.processManager.runningCount;
  }

  isBotRunning(botId: string): boolean {
    return this.processManager.isRunning(botId);
  }

  async syncBot(botId: string, botName: string, rawConfig: Record<string, unknown>): Promise<void> {
    const config = parseJsBotConfig(rawConfig);
    // A stored file we can no longer read (truncated, older schema) must not block replacing it with the
    // new, valid config: treat it as absent.
    const existing = await this.botStore.load(botId).catch(() => null);
    if (existing) {
      config.scopedVariableDefinitions = mergeScopedVariableDefinitions(
        config.scopedVariableDefinitions,
        existing.config.scopedVariableDefinitions,
      );
    }
    validateJsBotConfig(config);
    await this.botStore.save(botId, botName, config);
    this.processManager.clearTokenInvalid(botId);
  }

  async startBot(botId: string, botName = ''): Promise<void> {
    await this.processManager.startBot(botId, botName);
  }

  async stopBot(botId: string): Promise<void> {
    await this.processManager.stopBot(botId);
  }

  async reloadBot(botId: string, rawConfig?: Record<string, unknown>): Promise<boolean> {
    if (rawConfig) {
      const entry = await this.botStore.load(botId);
      if (!entry) {
        throw new Error(`Bot "${botId}" is not synced.`);
      }
      const config = parseJsBotConfig(rawConfig);
      config.scopedVariableDefinitions = mergeScopedVariableDefinitions(
        config.scopedVariableDefinitions,
        entry.config.scopedVariableDefinitions,
      );
      validateJsBotConfig(config);
      await this.botStore.save(botId, entry.name, config);
    }

    return this.processManager.reloadBot(botId);
  }

  async upsertCommand(
    botId: string,
    rawCommand: Record<string, unknown>,
    commandId?: string,
  ): Promise<CommandHandler> {
    await this.requireBotEntry(botId);
    const parsed = commandHandlerSchema.parse({
      ...rawCommand,
      id: (commandId ?? rawCommand.id ?? '').toString().trim() || (rawCommand.name ?? '').toString().trim(),
    });

    await this.botStore.updateConfig(botId, (config) => {
      const existingCommands = config.commands ?? [];
      // L'identifiant d'abord : renommer B en « a » alors qu'une commande A porte
      // déjà ce nom remplaçait A (match par nom) et laissait B en double. Avec
      // l'id prioritaire, la collision de noms est refusée par la validation.
      const byId = existingCommands.findIndex((c) => c.id === parsed.id);
      const index =
        byId >= 0
          ? byId
          : existingCommands.findIndex(
              (c) => c.name.toLowerCase() === parsed.name.toLowerCase(),
            );
      const nextCommands = [...existingCommands];
      if (index >= 0) {
        nextCommands[index] = parsed;
      } else {
        nextCommands.push(parsed);
      }
      return {
        ...config,
        commands: nextCommands,
      };
    });

    if (this.isBotRunning(botId)) {
      await this.processManager.upsertCommand(botId, parsed);
    }

    return parsed;
  }

  async deleteCommand(botId: string, commandId: string): Promise<void> {
    await this.requireBotEntry(botId);
    const normalizedId = commandId.trim();
    if (!normalizedId) {
      throw new Error('Missing command ID.');
    }

    await this.botStore.updateConfig(botId, (config) => {
      const nextCommands = (config.commands ?? []).filter(
        (c) => c.id !== normalizedId && c.name.toLowerCase() !== normalizedId.toLowerCase(),
      );
      return {
        ...config,
        commands: nextCommands,
      };
    });

    if (this.isBotRunning(botId)) {
      await this.processManager.deleteCommand(botId, normalizedId);
    }
  }

  /**
   * Hot-sync d'UN workflow (route du Manager). Le workflow est projeté dans `events`/`scheduled`
   * comme à la synchro complète, persisté, puis le bot est rechargé s'il tourne. Le rechargement
   * réutilise le client Discord tant que ni le jeton ni les intents effectifs ne changent ; un
   * nouvel événement qui exige un intent absent provoque la reconnexion que ce rechargement fait
   * déjà pour toute autre modification.
   */
  async upsertWorkflow(
    botId: string,
    workflowName: string,
    workflow: Record<string, unknown>,
  ): Promise<void> {
    await this.botStore.updateConfig(botId, (config) => {
      assertHotSyncComplete(config, workflowName, workflow);
      return applyWorkflowToConfig(config, workflowName, workflow);
    });
    await this.reloadBotIfRunning(botId);
  }

  async deleteWorkflow(botId: string, workflowName: string): Promise<void> {
    await this.botStore.updateConfig(botId, (config) => {
      assertHotSyncComplete(config, workflowName, null);
      return removeWorkflowFromConfig(config, workflowName);
    });
    await this.reloadBotIfRunning(botId);
  }

  async triggerInboundWebhook(
    botId: string,
    pathKey: string,
    payload: unknown,
    headers: Record<string, string>,
  ): Promise<void> {
    await this.processManager.triggerInboundWebhook(botId, pathKey, payload, headers);
  }

  async drainAllBots(): Promise<number> {
    return this.processManager.drainAll();
  }

  async requireBotEntry(botId: string) {
    const entry = await this.botStore.load(botId);
    if (!entry) {
      const error = new Error(`Bot "${botId}" not found.`) as Error & {
        statusCode: number;
      };
      error.statusCode = 404;
      throw error;
    }
    return entry;
  }

  async getMergedGlobalVariables(botId: string): Promise<Record<string, unknown>> {
    const entry = await this.requireBotEntry(botId);
    const runtime = await this.variableStore.getGlobalVariables(botId);
    return { ...entry.config.globalVariables, ...runtime };
  }

  async upsertGlobalVariable(botId: string, key: string, value: unknown): Promise<void> {
    const normalizedKey = key.trim();
    if (!normalizedKey) {
      throw new Error('Missing variable key.');
    }

    await this.botStore.updateConfig(botId, (config) => ({
      ...config,
      globalVariables: {
        ...config.globalVariables,
        [normalizedKey]: value,
      },
    }));
    await this.variableStore.setGlobalVariable(botId, normalizedKey, value);
    await this.reloadBotIfRunning(botId);
  }

  async removeGlobalVariable(botId: string, key: string): Promise<void> {
    const normalizedKey = key.trim();
    if (!normalizedKey) {
      throw new Error('Missing variable key.');
    }

    await this.botStore.updateConfig(botId, (config) => {
      const nextGlobals = { ...config.globalVariables };
      delete nextGlobals[normalizedKey];
      return { ...config, globalVariables: nextGlobals };
    });
    await this.variableStore.removeGlobalVariable(botId, normalizedKey);
    await this.reloadBotIfRunning(botId);
  }

  async renameGlobalVariable(botId: string, oldKey: string, newKey: string): Promise<void> {
    const normalizedOldKey = oldKey.trim();
    const normalizedNewKey = newKey.trim();
    if (!normalizedOldKey || !normalizedNewKey) {
      throw new Error('Missing variable key.');
    }

    await this.botStore.updateConfig(botId, (config) => {
      const nextGlobals = { ...config.globalVariables };
      if (!(normalizedOldKey in nextGlobals)) {
        return config;
      }
      nextGlobals[normalizedNewKey] = nextGlobals[normalizedOldKey];
      delete nextGlobals[normalizedOldKey];
      return { ...config, globalVariables: nextGlobals };
    });

    const runtime = await this.variableStore.getGlobalVariables(botId);
    if (normalizedOldKey in runtime) {
      await this.variableStore.renameGlobalVariable(
        botId,
        normalizedOldKey,
        normalizedNewKey,
      );
    }
    await this.reloadBotIfRunning(botId);
  }

  async upsertScopedVariableDefinition(
    botId: string,
    key: string,
    scope: string,
    defaultValue: unknown,
    valueType?: string,
  ): Promise<void> {
    const normalizedKey = normalizeScopedStorageKey(key);
    const normalizedScope = scope.trim();
    if (!normalizedKey || !normalizedScope) {
      throw new Error('Missing scoped variable definition.');
    }

    await this.botStore.updateConfig(botId, (config) => {
      const defs = config.scopedVariableDefinitions.map((entry) => ({ ...entry }));
      const index = defs.findIndex(
        (entry) =>
          normalizeScopedStorageKey(String(entry.key ?? '')) === normalizedKey &&
          String(entry.scope ?? '').trim() === normalizedScope,
      );
      // Un client qui ne connaît pas le type (le Studio) ne doit pas rétrograder
      // un nombre ou un booléen en chaîne en éditant sa valeur par défaut.
      const previousType = index >= 0 ? String(defs[index]!.valueType ?? '') : '';
      const next = {
        key: normalizedKey,
        scope: normalizedScope,
        defaultValue,
        valueType: valueType ?? (previousType || 'string'),
      };
      if (index >= 0) {
        defs[index] = next;
      } else {
        defs.push(next);
      }
      return { ...config, scopedVariableDefinitions: defs };
    });
    await this.reloadBotIfRunning(botId);
  }

  async deleteScopedVariableDefinition(
    botId: string,
    key: string,
    scope?: string,
    purgeStoredValues = false,
  ): Promise<void> {
    const normalizedKey = normalizeScopedStorageKey(key);
    const normalizedScope = scope?.trim() ?? '';
    if (!normalizedKey) {
      throw new Error('Missing scoped variable key.');
    }

    const entry = await this.requireBotEntry(botId);
    const scopesToPurge = new Set<string>();
    if (purgeStoredValues) {
      if (normalizedScope) {
        scopesToPurge.add(normalizedScope);
      } else {
        for (const def of entry.config.scopedVariableDefinitions) {
          if (normalizeScopedStorageKey(String(def.key ?? '')) === normalizedKey) {
            const defScope = String(def.scope ?? '').trim();
            if (defScope) {
              scopesToPurge.add(defScope);
            }
          }
        }
      }
    }

    await this.botStore.updateConfig(botId, (config) => {
      const defs = config.scopedVariableDefinitions.filter((entry) => {
        const matchesKey =
          normalizeScopedStorageKey(String(entry.key ?? '')) === normalizedKey;
        if (!matchesKey) {
          return true;
        }
        if (!normalizedScope) {
          return false;
        }
        return String(entry.scope ?? '').trim() !== normalizedScope;
      });
      return { ...config, scopedVariableDefinitions: defs };
    });

    if (purgeStoredValues) {
      for (const scopeName of scopesToPurge) {
        await this.purgeScopedValuesForKey(botId, scopeName, normalizedKey);
      }
    }

    await this.reloadBotIfRunning(botId);
  }

  private async reloadBotIfRunning(botId: string): Promise<void> {
    if (!this.isBotRunning(botId)) {
      return;
    }
    await this.processManager.reloadBot(botId);
  }

  private async purgeScopedValuesForKey(
    botId: string,
    scope: string,
    storageKey: string,
  ): Promise<void> {
    await this.variableStore.removeAllScopedValuesForKey(botId, scope, storageKey);
    const legacyKey = toScopedReferenceKey(storageKey);
    if (legacyKey !== storageKey) {
      await this.variableStore.removeAllScopedValuesForKey(botId, scope, legacyKey);
    }
  }

  listRuntimeStates(): RunnerBotRuntimeState[] {
    return this.processManager.listStates().map((state) => this.toRuntimeState(state));
  }

  runtimeStateForBot(botId: string): RunnerBotRuntimeState {
    const state = this.toRuntimeState(this.processManager.getState(botId));
    const scheduled = this.processManager.getScheduledSnapshot(botId);
    return scheduled ? { ...state, scheduled } : state;
  }

  aggregateWorkerRssBytes(): number {
    return this.processManager.listStates().reduce((sum, state) => {
      return sum + (state.rssBytes ?? 0);
    }, 0);
  }

  private toRuntimeState(state: ManagedBotState): RunnerBotRuntimeState {
    return {
      botId: state.botId,
      botName: state.botName,
      state: state.state,
      lastSeenAt: state.lastSeenAt,
      lastError: state.lastError,
      baselineRssBytes: state.rssBytes,
      heapUsedBytes: state.heapUsedBytes,
      guildCount: state.guildCount,
      pid: state.pid,
      discordRest: state.discordRest,
    };
  }

  async dispose(): Promise<void> {
    await this.processManager.dispose();
    await this.variableStore.dispose?.();
  }
}
