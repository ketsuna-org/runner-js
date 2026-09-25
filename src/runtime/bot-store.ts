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
  private readonly memoryConfigs = new Map<string, JsBotConfig>();
  private hydrated = false;

  constructor(private readonly storeDir: string) {}

  private safeBotId(botId: string): string {
    return botId.replace(/[^\w-]/g, '_');
  }

  private fileForBot(botId: string): string {
    return path.join(this.storeDir, `${this.safeBotId(botId)}.json`);
  }

  private sanitizeForStorage(config: JsBotConfig): JsBotConfig {
    const { token: _token, databaseConfig, inboundWebhooks, ...safeConfig } = config;
    return {
      ...safeConfig,
      token: '',
      databaseConfig: databaseConfig ? { type: databaseConfig.type || 'none' } : { type: 'none' },
      inboundWebhooks: (inboundWebhooks ?? []).map(({ secret: _secret, ...wh }) => ({
        ...wh,
        secret: '',
      })),
    };
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

    // Store complete runtime config in volatile RAM
    this.memoryConfigs.set(botId, config);

    // Persist ZERO secrets on disk
    const sanitizedConfig = this.sanitizeForStorage(config);
    const entry: PersistedBotEntry = {
      id: botId,
      name: botName.trim() || botId,
      syncedAt: new Date().toISOString(),
      config: sanitizedConfig,
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
      let config = parseJsBotConfig(parsed.config);
      // Merge with in-memory secrets if active
      const mem = this.memoryConfigs.get(botId);
      if (mem) {
        config = {
          ...config,
          token: mem.token || config.token,
          databaseConfig: mem.databaseConfig || config.databaseConfig,
          // Les secrets de webhook sont retirés du disque par
          // `sanitizeForStorage` et n'étaient PAS restaurés ici : `load()`
          // rendait donc toujours `secret: ''`, ce qui faisait de la vérification
          // de `/inbound/` une vérification morte — n'importe qui pouvait appeler
          // le webhook, avec ou sans secret.
          inboundWebhooks: config.inboundWebhooks.map((webhook) => {
            const source = mem.inboundWebhooks?.find(
              (candidate) =>
                candidate.id === webhook.id ||
                (candidate.path.length > 0 && candidate.path === webhook.path),
            );
            return source && source.secret.length > 0
              ? { ...webhook, secret: source.secret }
              : webhook;
          }),
        };
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
        config,
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
        this.memoryConfigs.delete(botId);
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
