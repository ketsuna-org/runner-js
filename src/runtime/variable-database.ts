export interface ScopedIndexQueryOptions {
  offset?: number;
  limit?: number;
  descending?: boolean;
}

export interface ScopedIndexQueryResult {
  items: Array<{ contextId: string; key: string; value: unknown }>;
  count: number;
  total: number;
}

export interface VariableDatabase {
  getGlobalVariables(botId: string): Promise<Record<string, unknown>>;
  getGlobalVariable?(botId: string, key: string): Promise<unknown>;
  setGlobalVariable(botId: string, key: string, value: unknown): Promise<void>;
  removeGlobalVariable(botId: string, key: string): Promise<void>;
  renameGlobalVariable(botId: string, oldKey: string, newKey: string): Promise<void>;

  getScopedVariables?(
    botId: string,
    scope: string,
    contextId: string,
  ): Promise<Record<string, unknown>>;
  getScopedVariable(
    botId: string,
    scope: string,
    contextId: string,
    key: string,
  ): Promise<unknown>;
  setScopedVariable(
    botId: string,
    scope: string,
    contextId: string,
    key: string,
    value: unknown,
  ): Promise<void>;
  removeScopedVariable(
    botId: string,
    scope: string,
    contextId: string,
    key: string,
  ): Promise<void>;
  listContextIds(botId: string, scope: string, searchKey: string): Promise<string[]>;
  removeAllScopedValuesForKey(botId: string, scope: string, key: string): Promise<void>;
  deleteAllForBot?(botId: string): Promise<void>;

  queryScopedVariableIndex?(
    botId: string,
    scope: string,
    key: string,
    options?: ScopedIndexQueryOptions,
  ): Promise<ScopedIndexQueryResult>;

  dispose?(): void | Promise<void>;
}
