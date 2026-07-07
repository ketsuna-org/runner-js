import type { ScriptExecutionContext, ScriptLogger } from './script-context.js';
import { ScriptIsolateRuntime } from './script-isolate-runtime.js';

export class ScriptExecutor {
  private readonly runtime: ScriptIsolateRuntime;

  constructor(
    private readonly defaultTimeoutMs: number,
    memoryLimitMb = 128,
  ) {
    this.runtime = new ScriptIsolateRuntime(memoryLimitMb);
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
