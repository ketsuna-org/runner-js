import { splitManagedContextId } from './scoped-context-parts.js';
import type {
  ScopedIndexQueryOptions,
  ScopedIndexQueryResult,
  VariableDatabase,
} from './variable-database.js';

interface ManagedVariableStoreOptions {
  baseUrl: string;
  token: string;
}

export class ManagedVariableStore implements VariableDatabase {
  private readonly baseUrl: string;
  readonly #token: string;

  constructor(options: ManagedVariableStoreOptions) {
    const trimmed = options.baseUrl.trim();
    this.baseUrl = trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
    this.#token = options.token.trim();
  }

  private async post(
    botId: string,
    suffix: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    const url = `${this.baseUrl}/bots/${encodeURIComponent(botId)}/variables${suffix}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.#token}`,
      },
      body: JSON.stringify(body),
    });
    if (response.status >= 400) {
      const text = await response.text();
      throw new Error(`[ManagedVariableStore] API error (${suffix}): ${response.status} - ${text}`);
    }
    if (response.status === 204) {
      return null;
    }
    const text = await response.text();
    return text.length > 0 ? JSON.parse(text) : null;
  }

  private async get(
    botId: string,
    suffix: string,
    query: Record<string, string | undefined>,
  ): Promise<unknown> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value != null && value.length > 0) {
        params.set(key, value);
      }
    }
    const queryString = params.toString();
    const url = `${this.baseUrl}/bots/${encodeURIComponent(botId)}/variables${suffix}${
      queryString ? `?${queryString}` : ''
    }`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.#token}`,
        'Cache-Control': 'no-cache',
      },
    });
    if (response.status === 404) {
      return null;
    }
    if (response.status >= 400) {
      const text = await response.text();
      throw new Error(`[ManagedVariableStore] API error (${suffix}): ${response.status} - ${text}`);
    }
    const text = await response.text();
    return text.length > 0 ? JSON.parse(text) : null;
  }

  async getGlobalVariables(botId: string): Promise<Record<string, unknown>> {
    const response = await this.get(botId, '/global/list', {});
    if (Array.isArray(response)) {
      const result: Record<string, unknown> = {};
      for (const item of response) {
        if (item && typeof item === 'object' && 'key' in item) {
          const record = item as { key: unknown; value: unknown };
          result[String(record.key)] = record.value;
        }
      }
      return result;
    }
    if (response && typeof response === 'object') {
      return { ...(response as Record<string, unknown>) };
    }
    return {};
  }

  async getGlobalVariable(botId: string, key: string): Promise<unknown> {
    const response = await this.get(botId, '/global/get', { key });
    if (response && typeof response === 'object' && 'value' in response) {
      return (response as { value: unknown }).value;
    }
    return response;
  }

  async setGlobalVariable(botId: string, key: string, value: unknown): Promise<void> {
    await this.post(botId, '/global/set', { key, value });
  }

  async removeGlobalVariable(botId: string, key: string): Promise<void> {
    await this.post(botId, '/global/remove', { key });
  }

  async renameGlobalVariable(botId: string, oldKey: string, newKey: string): Promise<void> {
    await this.post(botId, '/global/rename', { oldKey, newKey });
  }

  async getScopedVariables(
    botId: string,
    scope: string,
    contextId: string,
  ): Promise<Record<string, unknown>> {
    const { scopeId, scopeAuxId } = splitManagedContextId(scope, contextId);
    const response = await this.get(botId, '/scoped/list', {
      scope,
      scope_id: scopeId,
      scope_aux_id: scopeAuxId,
    });
    if (Array.isArray(response)) {
      const result: Record<string, unknown> = {};
      for (const item of response) {
        if (item && typeof item === 'object' && 'key' in item) {
          const record = item as { key: unknown; value: unknown };
          result[String(record.key)] = record.value;
        }
      }
      return result;
    }
    if (response && typeof response === 'object') {
      return { ...(response as Record<string, unknown>) };
    }
    return {};
  }

  async getScopedVariable(
    botId: string,
    scope: string,
    contextId: string,
    key: string,
  ): Promise<unknown> {
    const { scopeId, scopeAuxId } = splitManagedContextId(scope, contextId);
    const response = await this.get(botId, '/scoped/get', {
      scope,
      scope_id: scopeId,
      scope_aux_id: scopeAuxId,
      key,
    });
    if (response && typeof response === 'object' && 'value' in response) {
      return (response as { value: unknown }).value;
    }
    return response;
  }

  async setScopedVariable(
    botId: string,
    scope: string,
    contextId: string,
    key: string,
    value: unknown,
  ): Promise<void> {
    const { scopeId, scopeAuxId } = splitManagedContextId(scope, contextId);
    await this.post(botId, '/scoped/set', {
      scope,
      scope_id: scopeId,
      scope_aux_id: scopeAuxId,
      key,
      value,
    });
  }

  async removeScopedVariable(
    botId: string,
    scope: string,
    contextId: string,
    key: string,
  ): Promise<void> {
    const { scopeId, scopeAuxId } = splitManagedContextId(scope, contextId);
    await this.post(botId, '/scoped/remove', {
      scope,
      scope_id: scopeId,
      scope_aux_id: scopeAuxId,
      key,
    });
  }

  async listContextIds(
    botId: string,
    scope: string,
    searchKey: string,
  ): Promise<string[]> {
    const response = await this.get(botId, '/scoped/list-contexts', {
      scope,
      search_key: searchKey.trim() || undefined,
    });
    return Array.isArray(response) ? response.map((entry) => String(entry)) : [];
  }

  async removeAllScopedValuesForKey(botId: string, scope: string, key: string): Promise<void> {
    await this.post(botId, '/scoped/delete-by-key', { scope, key });
  }

  async deleteAllForBot(botId: string): Promise<void> {
    await this.post(botId, '/all/delete', {});
  }

  async queryScopedVariableIndex(
    botId: string,
    scope: string,
    key: string,
    options: ScopedIndexQueryOptions = {},
  ): Promise<ScopedIndexQueryResult> {
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 25;
    const descending = options.descending !== false;
    const response = await this.get(botId, '/scoped/query-index', {
      scope,
      key,
      offset: String(offset),
      limit: String(limit),
      descending: String(descending),
    });
    if (!response || typeof response !== 'object') {
      return { items: [], count: 0, total: 0 };
    }
    const record = response as {
      items?: Array<{ contextId?: string; key?: string; value?: unknown }>;
      count?: number;
      total?: number;
    };
    const items = Array.isArray(record.items)
      ? record.items.map((item) => ({
          contextId: String(item.contextId ?? ''),
          key: String(item.key ?? key),
          value: item.value,
        }))
      : [];
    return {
      items,
      count: typeof record.count === 'number' ? record.count : items.length,
      total: typeof record.total === 'number' ? record.total : items.length,
    };
  }
}
