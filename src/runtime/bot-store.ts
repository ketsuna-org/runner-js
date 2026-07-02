import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

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
  running: boolean;
}

export class BotStore {
  constructor(private readonly dataDir: string) {}

  private safeBotId(botId: string): string {
    return botId.replace(/[^\w-]/g, '_');
  }

  private fileForBot(botId: string): string {
    return path.join(this.dataDir, this.safeBotId(botId), 'config.json');
  }

  async save(botId: string, botName: string, config: JsBotConfig): Promise<void> {
    validateJsBotConfig(config);
    const filePath = this.fileForBot(botId);
    await mkdir(path.dirname(filePath), { recursive: true });

    const entry: RunnerBotEntry = {
      id: botId,
      name: botName.trim() || botId,
      syncedAt: new Date().toISOString(),
      config,
      running: false,
    };

    await writeFile(filePath, JSON.stringify(entry, null, 2), 'utf8');
  }

  async load(botId: string): Promise<RunnerBotEntry | null> {
    try {
      const raw = await readFile(this.fileForBot(botId), 'utf8');
      const parsed = JSON.parse(raw) as RunnerBotEntry;
      return {
        ...parsed,
        config: parseJsBotConfig(parsed.config),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async listAll(): Promise<RunnerBotEntry[]> {
    try {
      const dirs = await readdir(this.dataDir, { withFileTypes: true });
      const entries: RunnerBotEntry[] = [];

      for (const dir of dirs) {
        if (!dir.isDirectory()) {
          continue;
        }

        const configPath = path.join(this.dataDir, dir.name, 'config.json');
        try {
          const raw = await readFile(configPath, 'utf8');
          const parsed = JSON.parse(raw) as RunnerBotEntry;
          entries.push({
            ...parsed,
            config: parseJsBotConfig(parsed.config),
          });
        } catch {
          // skip invalid entries
        }
      }

      return entries.sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  async setRunning(botId: string, running: boolean): Promise<void> {
    const entry = await this.load(botId);
    if (!entry) {
      return;
    }
    entry.running = running;
    await writeFile(this.fileForBot(botId), JSON.stringify(entry, null, 2), 'utf8');
  }
}
