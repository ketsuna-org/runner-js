import type { ScriptExecutionContext, ScriptLogger } from './script-context.js';
import { ScriptDirectRuntime } from './script-direct-runtime.js';
import type { ScriptRuntime } from './script-runtime.js';

export class ScriptExecutor {
  private runtime: ScriptRuntime;

  constructor(private readonly defaultTimeoutMs: number) {
    this.runtime = new ScriptDirectRuntime();
  }

  /** Process V8 heap used bytes (1 bot = 1 process). */
  getHeapUsedBytes(): number {
    return process.memoryUsage().heapUsed;
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
