import {
  type JsBotConfig,
  parseJsBotConfig,
  validateJsBotConfig,
} from '../config/js-bot-config.js';

export interface RunnerBotEntry {
  id: string;
  name: string;
  syncedAt: string;
  config: JsBotConfig;
}

export class BotStore {
  private readonly entries = new Map<string, RunnerBotEntry>();

  async save(botId: string, botName: string, config: JsBotConfig): Promise<void> {
    validateJsBotConfig(config);
    this.entries.set(botId, {
      id: botId,
      name: botName.trim() || botId,
      syncedAt: new Date().toISOString(),
      config,
    });
  }

  async load(botId: string): Promise<RunnerBotEntry | null> {
    const entry = this.entries.get(botId);
    if (!entry) {
      return null;
    }

    return {
      ...entry,
      config: parseJsBotConfig(entry.config),
    };
  }

  async listAll(): Promise<RunnerBotEntry[]> {
    const entries = [...this.entries.values()].map((entry) => ({
      ...entry,
      config: parseJsBotConfig(entry.config),
    }));
    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  async updateConfig(
    botId: string,
    transform: (config: JsBotConfig) => JsBotConfig,
  ): Promise<RunnerBotEntry> {
    const entry = await this.load(botId);
    if (!entry) {
      const error = new Error(`Bot "${botId}" not found.`) as Error & {
        statusCode: number;
      };
      error.statusCode = 404;
      throw error;
    }

    const nextConfig = transform(entry.config);
    validateJsBotConfig(nextConfig);
    const nextEntry: RunnerBotEntry = {
      ...entry,
      config: nextConfig,
      syncedAt: new Date().toISOString(),
    };
    this.entries.set(botId, nextEntry);
    return nextEntry;
  }
}
