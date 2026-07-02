import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import type { ScriptExecutionContext, ScriptLogger } from './script-context.js';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...fnArgs: unknown[]) => Promise<unknown>;

export class ScriptExecutor {
  private readonly moduleRequire = createRequire(fileURLToPath(import.meta.url));

  constructor(private readonly defaultTimeoutMs: number) {}

  async execute(
    script: string,
    context: ScriptExecutionContext,
    logger: ScriptLogger,
    timeoutMs = this.defaultTimeoutMs,
  ): Promise<unknown> {
    const trimmed = script.trim();
    if (!trimmed) {
      return undefined;
    }

    const runner = new AsyncFunction(
      'client',
      'interaction',
      'message',
      'member',
      'guild',
      'channel',
      'config',
      'variables',
      'db',
      'webhook',
      'require',
      'console',
      'fetch',
      `"use strict";\n${trimmed}`,
    );

    const execution = runner(
      context.client,
      context.interaction,
      context.message,
      context.member ?? null,
      context.guild ?? null,
      context.channel ?? null,
      context.config,
      context.variables,
      context.db ?? null,
      context.webhook ?? null,
      this.moduleRequire,
      logger,
      fetch,
    );

    return await withTimeout(execution, timeoutMs);
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Script execution timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
