import type { ScriptExecutionContext, ScriptLogger } from './script-context.js';
import { ScriptDirectRuntime } from './script-direct-runtime.js';
import type { ScriptRuntime } from './script-runtime.js';

export interface ScriptExecutorOptions {
  sandboxed?: boolean;
  memoryLimitMb?: number;
}

export class ScriptExecutor {
  private runtime: ScriptRuntime | null = null;
  private isolateRuntimePromise: Promise<ScriptRuntime> | null = null;
  readonly sandboxed: boolean;
  private readonly memoryLimitMb: number;

  constructor(
    private readonly defaultTimeoutMs: number,
    options: ScriptExecutorOptions = {},
  ) {
    this.sandboxed = options.sandboxed ?? false;
    this.memoryLimitMb = options.memoryLimitMb ?? 128;
    if (!this.sandboxed) {
      this.runtime = new ScriptDirectRuntime();
    }
  }

  private loadIsolateRuntime(): Promise<ScriptRuntime> {
    if (!this.isolateRuntimePromise) {
      this.isolateRuntimePromise = import('./script-isolate-runtime.js').then(
        ({ ScriptIsolateRuntime }) => new ScriptIsolateRuntime(this.memoryLimitMb),
      );
    }
    return this.isolateRuntimePromise;
  }

  private async ensureRuntime(): Promise<ScriptRuntime> {
    if (this.runtime) {
      return this.runtime;
    }
    this.runtime = await this.loadIsolateRuntime();
    return this.runtime;
  }

  async execute(
    script: string,
    context: ScriptExecutionContext,
    logger: ScriptLogger,
    timeoutMs = this.defaultTimeoutMs,
  ): Promise<unknown> {
    const runtime = this.sandboxed ? await this.ensureRuntime() : this.runtime!;
    return runtime.execute(script, context, logger, timeoutMs);
  }

  dispose(): void {
    this.runtime?.dispose();
  }
}
