import path from 'node:path';

import { JsonVariableStore } from './json-variable-store.js';
import { ManagedVariableStore } from './managed-variable-store.js';
import { SqliteVariableStore } from './sqlite-variable-store.js';
import type { VariableDatabase } from './variable-database.js';

export interface VariableStoreEnv {
  managedRunnerApi: string;
  managedRunnerToken: string;
}

export function resolveVariablesDir(dataDir: string): string {
  return path.join(dataDir, 'variables');
}

export async function resolveVariableStore(
  dataDir: string,
  env: VariableStoreEnv,
): Promise<VariableDatabase> {
  const managedApi = env.managedRunnerApi.trim();
  const managedToken = env.managedRunnerToken.trim();
  if (managedApi && managedToken) {
    return new ManagedVariableStore({ baseUrl: managedApi, token: managedToken });
  }

  const variablesDir = resolveVariablesDir(dataDir);
  try {
    const sqlite = new SqliteVariableStore(variablesDir);
    await sqlite.init();
    return sqlite;
  } catch (error) {
    console.warn('[VariableStore] SQLite init failed, falling back to JSON:', error);
    return new JsonVariableStore(variablesDir);
  }
}
