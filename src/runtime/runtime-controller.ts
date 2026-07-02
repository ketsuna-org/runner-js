import type { JsBotConfig } from '../config/js-bot-config.js';
import { parseJsBotConfig, validateJsBotConfig } from '../config/js-bot-config.js';
import { BotStore } from './bot-store.js';
import { BotProcessManager } from './bot-process-manager.js';
import type { LogStore } from './log-store.js';

export interface RunnerBotRuntimeState {
  botId: string;
  botName: string;
  state: string;
  lastSeenAt: string | null;
  lastError: string | null;
  baselineRssBytes: number | null;
}

export class RuntimeController {
  readonly botStore: BotStore;
  private readonly processManager: BotProcessManager;

  constructor(dataDir: string, logStore: LogStore) {
    this.botStore = new BotStore(dataDir);
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

  listRuntimeStates(): RunnerBotRuntimeState[] {
    return this.processManager.listStates().map((state) => ({
      botId: state.botId,
      botName: state.botName,
      state: state.state,
      lastSeenAt: state.lastSeenAt,
      lastError: state.lastError,
      baselineRssBytes: state.rssBytes,
    }));
  }

  runtimeStateForBot(botId: string): RunnerBotRuntimeState {
    const state = this.processManager.getState(botId);
    return {
      botId: state.botId,
      botName: state.botName,
      state: state.state,
      lastSeenAt: state.lastSeenAt,
      lastError: state.lastError,
      baselineRssBytes: state.rssBytes,
    };
  }

  async dispose(): Promise<void> {
    await this.processManager.dispose();
  }
}
