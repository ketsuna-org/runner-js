import type { JsBotConfig } from '../config/js-bot-config.js';
import { parseJsBotConfig, validateJsBotConfig } from '../config/js-bot-config.js';
import path from 'node:path';
import { BotStore } from './bot-store.js';
import { BotProcessManager, type ManagedWorkerState } from './bot-process-manager.js';
import type { LogStore } from './log-store.js';
import { normalizeScopedStorageKey, toScopedReferenceKey } from './variable-keys.js';
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
}

export class RuntimeController {
  readonly botStore: BotStore;
  readonly variableStore: VariableDatabase;
  private readonly processManager: BotProcessManager;

  static async create(
    dataDir: string,
    logStore: LogStore,
    env: VariableStoreEnv,
  ): Promise<RuntimeController> {
    const variableStore = await resolveVariableStore(dataDir, env);
    return new RuntimeController(dataDir, logStore, variableStore);
  }

  constructor(dataDir: string, logStore: LogStore, variableStore: VariableDatabase) {
    this.botStore = new BotStore(path.join(dataDir, 'synced-bots'));
    this.variableStore = variableStore;
    this.processManager = new BotProcessManager({
      dataDir,
      botStore: this.botStore,
      logStore,
    });
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
      validateJsBotConfig(config);
      await this.botStore.save(botId, entry.name, config);
    }

    return this.processManager.reloadBot(botId);
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
    valueType = 'string',
  ): Promise<void> {
    const normalizedKey = normalizeScopedStorageKey(key);
    const normalizedScope = scope.trim();
    if (!normalizedKey || !normalizedScope) {
      throw new Error('Missing scoped variable definition.');
    }

    await this.botStore.updateConfig(botId, (config) => {
      const defs = config.scopedVariableDefinitions.map((entry) => ({ ...entry }));
      const next = {
        key: normalizedKey,
        scope: normalizedScope,
        defaultValue,
        valueType,
      };
      const index = defs.findIndex(
        (entry) =>
          normalizeScopedStorageKey(String(entry.key ?? '')) === normalizedKey &&
          String(entry.scope ?? '').trim() === normalizedScope,
      );
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
    return this.toRuntimeState(this.processManager.getState(botId));
  }

  aggregateWorkerRssBytes(): number {
    return this.processManager.listStates().reduce((sum, state) => {
      return sum + (state.rssBytes ?? 0);
    }, 0);
  }

  private toRuntimeState(state: ManagedWorkerState): RunnerBotRuntimeState {
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
    };
  }

  async dispose(): Promise<void> {
    await this.processManager.dispose();
    await this.variableStore.dispose?.();
  }
}
