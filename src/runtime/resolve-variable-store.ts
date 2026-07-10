import path from 'node:path';

import { JsonVariableStore } from './json-variable-store.js';
import { LibsqlVariableStore } from './libsql-variable-store.js';
import { ManagedVariableStore } from './managed-variable-store.js';
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
    console.info('[VariableStore] Using managed store (Manager API)');
    return new ManagedVariableStore({ baseUrl: managedApi, token: managedToken });
  }

  const variablesDir = resolveVariablesDir(dataDir);
  try {
    const libsql = new LibsqlVariableStore(variablesDir);
    await libsql.init();
    console.info(`[VariableStore] Using local libsql store at ${libsql.dbPath}`);
    return libsql;
  } catch (error) {
    console.warn('[VariableStore] libsql init failed, falling back to JSON:', error);
    console.info(`[VariableStore] Using JSON fallback at ${variablesDir}`);
    return new JsonVariableStore(variablesDir);
  }
}
