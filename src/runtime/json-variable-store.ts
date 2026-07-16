import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { VariableDatabase } from './variable-database.js';

interface BotVariableData {
  global: Record<string, unknown>;
  scoped: Record<string, Record<string, Record<string, unknown>>>;
}

interface CachedBotVariableData {
  mtimeMs: number;
  data: BotVariableData;
}

export class JsonVariableStore implements VariableDatabase {
  private readonly cache = new Map<string, CachedBotVariableData>();

  constructor(private readonly variablesDir: string) {}

  private safeBotId(botId: string): string {
    return botId.replace(/[^\w-]/g, '_');
  }

  private fileForBot(botId: string): string {
    return path.join(this.variablesDir, `${this.safeBotId(botId)}.json`);
  }

  private emptyData(): BotVariableData {
    return { global: {}, scoped: {} };
  }

  private cloneData(data: BotVariableData): BotVariableData {
    return {
      global: { ...data.global },
      scoped: Object.fromEntries(
        Object.entries(data.scoped).map(([scope, keys]) => [
          scope,
          Object.fromEntries(
            Object.entries(keys).map(([key, contexts]) => [key, { ...contexts }]),
          ),
        ]),
      ),
    };
  }

  private async read(botId: string): Promise<BotVariableData> {
    const filePath = this.fileForBot(botId);
    try {
      const fileStat = await stat(filePath);
      const cached = this.cache.get(botId);
      if (cached && cached.mtimeMs === fileStat.mtimeMs) {
        return this.cloneData(cached.data);
      }

      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<BotVariableData>;
      const data: BotVariableData = {
        global:
          parsed.global && typeof parsed.global === 'object'
            ? (parsed.global as Record<string, unknown>)
            : {},
        scoped:
          parsed.scoped && typeof parsed.scoped === 'object'
            ? (parsed.scoped as Record<string, Record<string, Record<string, unknown>>>)
            : {},
      };
      this.cache.set(botId, { mtimeMs: fileStat.mtimeMs, data: this.cloneData(data) });
      return data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.cache.delete(botId);
        return this.emptyData();
      }
      throw error;
    }
  }

  private async write(botId: string, data: BotVariableData): Promise<void> {
    await mkdir(this.variablesDir, { recursive: true });
    const filePath = this.fileForBot(botId);
    await writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
    const fileStat = await stat(filePath);
    this.cache.set(botId, { mtimeMs: fileStat.mtimeMs, data: this.cloneData(data) });
  }

  async getGlobalVariables(botId: string): Promise<Record<string, unknown>> {
    const data = await this.read(botId);
    return { ...data.global };
  }

  async setGlobalVariable(botId: string, key: string, value: unknown): Promise<void> {
    const data = await this.read(botId);
    data.global[key] = value;
    await this.write(botId, data);
  }

  async removeGlobalVariable(botId: string, key: string): Promise<void> {
    const data = await this.read(botId);
    delete data.global[key];
    await this.write(botId, data);
  }

  async renameGlobalVariable(botId: string, oldKey: string, newKey: string): Promise<void> {
    const data = await this.read(botId);
    if (!(oldKey in data.global)) {
      return;
    }
    data.global[newKey] = data.global[oldKey];
    delete data.global[oldKey];
    await this.write(botId, data);
  }

  async setScopedVariable(
    botId: string,
    scope: string,
    contextId: string,
    key: string,
    value: unknown,
  ): Promise<void> {
    const data = await this.read(botId);
    const scopeBucket = data.scoped[scope] ?? {};
    const keyBucket = scopeBucket[key] ?? {};
    keyBucket[contextId] = value;
    scopeBucket[key] = keyBucket;
    data.scoped[scope] = scopeBucket;
    await this.write(botId, data);
  }

  async getScopedVariable(
    botId: string,
    scope: string,
    contextId: string,
    key: string,
  ): Promise<unknown> {
    const data = await this.read(botId);
    return data.scoped[scope]?.[key]?.[contextId];
  }

  async listContextIds(
    botId: string,
    scope: string,
    searchKey: string,
  ): Promise<string[]> {
    const data = await this.read(botId);
    const keyBucket = data.scoped[scope]?.[searchKey];
    if (!keyBucket) {
      return [];
    }
    return Object.keys(keyBucket).sort();
  }

  async removeScopedVariable(
    botId: string,
    scope: string,
    contextId: string,
    key: string,
  ): Promise<void> {
    const data = await this.read(botId);
    const keyBucket = data.scoped[scope]?.[key];
    if (!keyBucket) {
      return;
    }
    delete keyBucket[contextId];
    if (Object.keys(keyBucket).length === 0) {
      delete data.scoped[scope]?.[key];
    }
    await this.write(botId, data);
  }

  async removeAllScopedValuesForKey(botId: string, scope: string, key: string): Promise<void> {
    const data = await this.read(botId);
    if (!data.scoped[scope]) {
      return;
    }
    delete data.scoped[scope][key];
    if (Object.keys(data.scoped[scope]).length === 0) {
      delete data.scoped[scope];
    }
    await this.write(botId, data);
  }
}
