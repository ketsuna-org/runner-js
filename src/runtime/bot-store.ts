import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
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
}

interface BotStoreMeta {
  id: string;
  name: string;
  syncedAt: string;
}

interface PersistedBotEntry {
  id: string;
  name: string;
  syncedAt: string;
  config: JsBotConfig;
}

export class BotStore {
  private readonly meta = new Map<string, BotStoreMeta>();
  private hydrated = false;

  constructor(private readonly storeDir: string) {}

  private safeBotId(botId: string): string {
    return botId.replace(/[^\w-]/g, '_');
  }

  private fileForBot(botId: string): string {
    return path.join(this.storeDir, `${this.safeBotId(botId)}.json`);
  }

  private async ensureHydrated(): Promise<void> {
    if (this.hydrated) {
      return;
    }
    this.hydrated = true;
    try {
      await mkdir(this.storeDir, { recursive: true });
      const files = await readdir(this.storeDir);
      for (const file of files) {
        if (!file.endsWith('.json')) {
          continue;
        }
        try {
          const raw = await readFile(path.join(this.storeDir, file), 'utf8');
          const parsed = JSON.parse(raw) as Partial<PersistedBotEntry>;
          const id = typeof parsed.id === 'string' ? parsed.id.trim() : '';
          if (!id || !parsed.config) {
            continue;
          }
          this.meta.set(id, {
            id,
            name: typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : id,
            syncedAt:
              typeof parsed.syncedAt === 'string' && parsed.syncedAt.length > 0
                ? parsed.syncedAt
                : new Date().toISOString(),
          });
        } catch {
          // Skip corrupt entries.
        }
      }
    } catch {
      // Fresh store directory.
    }
  }

  async save(botId: string, botName: string, config: JsBotConfig): Promise<void> {
    validateJsBotConfig(config);
    await this.ensureHydrated();
    await mkdir(this.storeDir, { recursive: true });

    const entry: PersistedBotEntry = {
      id: botId,
      name: botName.trim() || botId,
      syncedAt: new Date().toISOString(),
      config,
    };
    await writeFile(this.fileForBot(botId), JSON.stringify(entry), 'utf8');
    this.meta.set(botId, {
      id: entry.id,
      name: entry.name,
      syncedAt: entry.syncedAt,
    });
  }

  async load(botId: string): Promise<RunnerBotEntry | null> {
    await this.ensureHydrated();
    try {
      const raw = await readFile(this.fileForBot(botId), 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedBotEntry>;
      if (!parsed.config) {
        return null;
      }
      const entry: RunnerBotEntry = {
        id: typeof parsed.id === 'string' && parsed.id.trim() ? parsed.id.trim() : botId,
        name:
          typeof parsed.name === 'string' && parsed.name.trim()
            ? parsed.name.trim()
            : botId,
        syncedAt:
          typeof parsed.syncedAt === 'string' && parsed.syncedAt.length > 0
            ? parsed.syncedAt
            : new Date().toISOString(),
        config: parseJsBotConfig(parsed.config),
      };
      this.meta.set(botId, {
        id: entry.id,
        name: entry.name,
        syncedAt: entry.syncedAt,
      });
      return entry;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.meta.delete(botId);
        return null;
      }
      throw error;
    }
  }

  async listAll(): Promise<RunnerBotEntry[]> {
    await this.ensureHydrated();
    const entries: RunnerBotEntry[] = [];
    for (const botId of this.meta.keys()) {
      const entry = await this.load(botId);
      if (entry) {
        entries.push(entry);
      }
    }
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
    await this.save(botId, entry.name, nextConfig);
    const next = await this.load(botId);
    if (!next) {
      throw new Error(`Bot "${botId}" disappeared after update.`);
    }
    return next;
  }
}
