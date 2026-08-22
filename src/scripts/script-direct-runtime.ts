import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { runnerPackageRoot } from '../config/env.js';
import { sanitizeConfigForScript } from './script-config-sanitize.js';
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

const tokenSafeClientProxies = new WeakMap<object, unknown>();

/** Prevent direct-mode scripts from reading Discord/API tokens. */
function createTokenSafeClientProxy(client: ScriptExecutionContext['client']): unknown {
  if (client == null || typeof client !== 'object') {
    return client;
  }
  const cached = tokenSafeClientProxies.get(client);
  if (cached) {
    return cached;
  }
  const proxy = new Proxy(client as object, {
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
  tokenSafeClientProxies.set(client, proxy);
  return proxy;
}

const SCOPE_PARAM_NAMES = [
  'client',
  'config',
  'variables',
  'interaction',
  'message',
  'member',
  'guild',
  'channel',
  'webhook',
  'db',
  'console',
  'fetch',
  'require',
  'setTimeout',
  'clearTimeout',
] as const;

type CompiledScriptFn = (...args: unknown[]) => Promise<unknown>;
const SCRIPT_CACHE_MAX = 500;
const compiledScriptCache = new Map<string, CompiledScriptFn>();

function getOrCompileScript(trimmedScript: string): CompiledScriptFn {
  let fn = compiledScriptCache.get(trimmedScript);
  if (!fn) {
    fn = new AsyncFunction(...SCOPE_PARAM_NAMES, trimmedScript) as CompiledScriptFn;
    if (compiledScriptCache.size >= SCRIPT_CACHE_MAX) {
      const oldest = compiledScriptCache.keys().next().value;
      if (oldest !== undefined) {
        compiledScriptCache.delete(oldest);
      }
    }
    compiledScriptCache.set(trimmedScript, fn);
  }
  return fn;
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

    const fn = getOrCompileScript(trimmed);
    const execution = fn(
      createTokenSafeClientProxy(context.client),
      sanitizeConfigForScript(context.config),
      context.variables,
      context.interaction,
      context.message,
      context.member,
      context.guild,
      context.channel,
      context.webhook ?? null,
      context.db,
      createConsoleProxy(logger),
      globalThis.fetch.bind(globalThis),
      moduleRequire,
      setTimeout,
      clearTimeout,
    );

    let timeoutTimer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        execution,
        new Promise<never>((_, reject) => {
          timeoutTimer = setTimeout(() => {
            reject(new Error(`Script execution timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer);
      }
    }
  }

  dispose(): void {
    // No persistent resources in direct mode.
  }
}
