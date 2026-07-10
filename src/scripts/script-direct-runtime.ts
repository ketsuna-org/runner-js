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
      client: context.client,
      config: sanitizeConfigForScript(context.config),
      variables: context.variables,
      interaction: context.interaction,
      message: context.message,
      member: context.member,
      guild: context.guild,
      channel: context.channel,
      webhook: context.webhook ?? null,
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
