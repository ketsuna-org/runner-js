import type { ScriptExecutionContext, ScriptLogger } from './script-context.js';

export interface ScriptRuntime {
  execute(
    script: string,
    context: ScriptExecutionContext,
    logger: ScriptLogger,
    timeoutMs: number,
  ): Promise<unknown>;
  dispose(): void;
}
