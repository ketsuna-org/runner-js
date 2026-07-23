import type { ScriptExecutionContext, ScriptLogger } from './script-context.js';

export interface ScriptRuntime {
  execute(
    script: string,
    context: ScriptExecutionContext,
    logger: ScriptLogger,
    timeoutMs: number,
  ): Promise<unknown>;
  /** Heap used by the runtime's isolate, when one exists. */
  getHeapUsedBytes?(): number | null;
  dispose(): void;
}
