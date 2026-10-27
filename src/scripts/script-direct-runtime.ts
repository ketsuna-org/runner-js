import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { runnerPackageRoot } from '../config/env.js';
import { createCappedFetch } from '../runtime/memory-hygiene.js';
import { sanitizeConfigForScript } from './script-config-sanitize.js';
import type { ScriptExecutionContext, ScriptLogger } from './script-context.js';
import { compileAsyncBody, createScriptFunctions } from './script-functions.js';
import type { CompiledBody } from './script-functions.js';
import type { ScriptRunLifecycle, ScriptRuntime } from './script-runtime.js';

const moduleRequire = createRequire(pathToFileURL(path.join(runnerPackageRoot(), 'package.json')));

function createConsoleProxy(logger: ScriptLogger): Console {
  return {
    log: (...args: unknown[]) => logger.log(...args),
    info: (...args: unknown[]) => logger.info(...args),
    warn: (...args: unknown[]) => logger.warn(...args),
    error: (...args: unknown[]) => logger.error(...args),
    debug: (...args: unknown[]) => logger.debug(...args),
  } as Console;
}

const cappedFetch = createCappedFetch(globalThis.fetch.bind(globalThis));

const tokenSafeClientProxies = new WeakMap<object, unknown>();

/** Prevent direct-mode scripts from reading Discord/API tokens. */
export function createTokenSafeClientProxy(client: ScriptExecutionContext['client']): unknown {
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

/**
 * Paramètres de portée d'un script, dans l'ordre. `fn` (bibliothèque de fonctions du bot) est toujours le
 * DERNIER : les valeurs des autres sont dans `scopeValues`, partagé avec les fonctions appelées.
 */
export const SCOPE_PARAM_NAMES = [
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
  'sql',
  'pgsql',
  'mongo',
  'voice',
  'console',
  'fetch',
  'require',
  'setTimeout',
  'clearTimeout',
  'fn',
] as const;

const SCRIPT_CACHE_MAX = 500;
const compiledScriptCache = new Map<string, CompiledBody>();

function getOrCompileScript(trimmedScript: string, logger: ScriptLogger): CompiledBody {
  let compiled = compiledScriptCache.get(trimmedScript);
  if (!compiled) {
    // Un script qui déclare déjà `const fn` est recompilé sans le global `fn` (il garde sa propre liaison).
    compiled = compileAsyncBody(SCOPE_PARAM_NAMES, [], trimmedScript);
    if (compiled.shadowsFn) {
      logger.warn(
        'The script declares its own "fn" binding: the functions library (fn.name(...)) is not available in this script.',
      );
    }
    if (compiledScriptCache.size >= SCRIPT_CACHE_MAX) {
      const oldest = compiledScriptCache.keys().next().value;
      if (oldest !== undefined) {
        compiledScriptCache.delete(oldest);
      }
    }
    compiledScriptCache.set(trimmedScript, compiled);
  }
  return compiled;
}

export class ScriptDirectRuntime implements ScriptRuntime {
  async execute(
    script: string,
    context: ScriptExecutionContext,
    logger: ScriptLogger,
    timeoutMs: number,
    lifecycle?: ScriptRunLifecycle,
  ): Promise<unknown> {
    const trimmed = script.trim();
    if (!trimmed) {
      return undefined;
    }

    const compiled = getOrCompileScript(trimmed, logger);
    // Même tableau pour le script et pour les fonctions du bot qu'il appelle (même portée ambiante).
    const scopeValues: unknown[] = [
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
      context.sql,
      context.pgsql,
      context.mongo,
      context.voice,
      createConsoleProxy(logger),
      // Bounded: the node hosts EVERY bot of the process, so an unbounded
      // script-side download is not a mistake local to the bot that made it.
      cappedFetch,
      moduleRequire,
      setTimeout,
      clearTimeout,
    ];
    const functions = createScriptFunctions({
      jsFunctions: context.config?.jsFunctions,
      scopeNames: SCOPE_PARAM_NAMES,
      scopeValues,
      warn: (message) => logger.warn(message),
    });
    const execution = compiled.run(scopeValues, functions.fn, []);
    if (lifecycle?.onSettled) {
      const settled = lifecycle.onSettled;
      execution.then(settled, settled);
    }

    let timeoutTimer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        execution,
        new Promise<never>((_, reject) => {
          timeoutTimer = setTimeout(() => {
            // Le script continue en arrière-plan (la course ne l'annule pas) : ses `fn.x()` tardifs sont refusés.
            functions.expire();
            lifecycle?.onTimeout?.();
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
