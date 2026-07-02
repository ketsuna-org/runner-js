import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

interface BotVariableData {
  global: Record<string, unknown>;
  scoped: Record<string, Record<string, Record<string, unknown>>>;
}

export class VariableStore {
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

  private async read(botId: string): Promise<BotVariableData> {
    try {
      const raw = await readFile(this.fileForBot(botId), 'utf8');
      const parsed = JSON.parse(raw) as Partial<BotVariableData>;
      return {
        global:
          parsed.global && typeof parsed.global === 'object'
            ? (parsed.global as Record<string, unknown>)
            : {},
        scoped:
          parsed.scoped && typeof parsed.scoped === 'object'
            ? (parsed.scoped as Record<string, Record<string, Record<string, unknown>>>)
            : {},
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return this.emptyData();
      }
      throw error;
    }
  }

  private async write(botId: string, data: BotVariableData): Promise<void> {
    await mkdir(this.variablesDir, { recursive: true });
    await writeFile(this.fileForBot(botId), JSON.stringify(data, null, 2), 'utf8');
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
