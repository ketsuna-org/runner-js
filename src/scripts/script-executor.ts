import type { ScriptExecutionContext, ScriptLogger } from './script-context.js';
import { ScriptDirectRuntime } from './script-direct-runtime.js';
import { ScriptIsolateRuntime } from './script-isolate-runtime.js';
import type { ScriptRuntime } from './script-runtime.js';

export interface ScriptExecutorOptions {
  sandboxed?: boolean;
  memoryLimitMb?: number;
}

export class ScriptExecutor {
  private readonly runtime: ScriptRuntime;
  readonly sandboxed: boolean;

  constructor(
    private readonly defaultTimeoutMs: number,
    options: ScriptExecutorOptions = {},
  ) {
    this.sandboxed = options.sandboxed ?? false;
    this.runtime = this.sandboxed
      ? new ScriptIsolateRuntime(options.memoryLimitMb ?? 128)
      : new ScriptDirectRuntime();
  }

  async execute(
    script: string,
    context: ScriptExecutionContext,
    logger: ScriptLogger,
    timeoutMs = this.defaultTimeoutMs,
  ): Promise<unknown> {
    return this.runtime.execute(script, context, logger, timeoutMs);
  }

  dispose(): void {
    this.runtime.dispose();
  }
}
