import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { runnerPackageRoot } from '../config/env.js';
import { sanitizeConfigForScript } from './script-host-bridge.js';
import type { ScriptExecutionContext, ScriptLogger } from './script-context.js';
import type { ScriptRuntime } from './script-runtime.js';

const moduleRequire = createRequire(pathToFileURL(path.join(runnerPackageRoot(), 'package.json')));

const AsyncFunction = Object.getPrototypeOf(async function () {
  /* noop */
}).constructor as new (
  ...args: string[]
) => (...values: unknown[]) => Promise<unknown>;

function createConsoleProxy(logger: ScriptLogger): Console {
  return {
    log: (...args: unknown[]) => logger.log(...args),
    info: (...args: unknown[]) => logger.info(...args),
    warn: (...args: unknown[]) => logger.warn(...args),
    error: (...args: unknown[]) => logger.error(...args),
    debug: (...args: unknown[]) => logger.debug(...args),
  } as Console;
}

/** Prevent direct-mode scripts from reading Discord/API tokens. */
function createTokenSafeClientProxy(client: ScriptExecutionContext['client']): unknown {
  if (client == null || typeof client !== 'object') {
    return client;
  }
  return new Proxy(client as object, {
    get(target, property, receiver) {
      if (property === 'token') {
        return undefined;
      }
      const value = Reflect.get(target, property, receiver);
      if (typeof value === 'function') {
        return value.bind(target);
      }
      return value;
    },
    set(target, property, value, receiver) {
      if (property === 'token') {
        throw new Error('Cannot set "token" on client.');
      }
      return Reflect.set(target, property, value, receiver);
    },
    ownKeys(target) {
      return Reflect.ownKeys(target).filter((key) => key !== 'token');
    },
    getOwnPropertyDescriptor(target, property) {
      if (property === 'token') {
        return undefined;
      }
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
  });
}

export class ScriptDirectRuntime implements ScriptRuntime {
  async execute(
    script: string,
    context: ScriptExecutionContext,
    logger: ScriptLogger,
    timeoutMs: number,
  ): Promise<unknown> {
    const trimmed = script.trim();
    if (!trimmed) {
      return undefined;
    }

    const scope = {
      client: createTokenSafeClientProxy(context.client),
      config: sanitizeConfigForScript(context.config),
      variables: context.variables,
      interaction: context.interaction,
      message: context.message,
      member: context.member,
      guild: context.guild,
      channel: context.channel,
      webhook: context.webhook ?? null,
      // ScriptDb uses #private fields; config/store are not enumerable.
      db: context.db,
      console: createConsoleProxy(logger),
      fetch: globalThis.fetch.bind(globalThis),
      require: moduleRequire,
      setTimeout,
      clearTimeout,
    };

    const scopeKeys = Object.keys(scope);
    const scopeValues = Object.values(scope);
    const fn = new AsyncFunction(...scopeKeys, trimmed);
    const execution = fn(...scopeValues);

    return Promise.race([
      execution,
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Script execution timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  }

  dispose(): void {
    // No persistent resources in direct mode.
  }
}
