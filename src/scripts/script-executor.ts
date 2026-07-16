import type { ScriptExecutionContext, ScriptLogger } from './script-context.js';
import { ScriptDirectRuntime } from './script-direct-runtime.js';
import type { ScriptRuntime } from './script-runtime.js';

/** Recycle isolate after this many script executions (sandbox only). */
export const DEFAULT_ISOLATE_MAX_EXECUTIONS = 200;
/** Recycle isolate after this age even if execution count is low. */
export const DEFAULT_ISOLATE_MAX_AGE_MS = 15 * 60 * 1000;

export interface ScriptExecutorOptions {
  sandboxed?: boolean;
  memoryLimitMb?: number;
  /** Max script runs before recycling the isolate. Default 200. */
  isolateMaxExecutions?: number;
  /** Max isolate lifetime in ms before recycling. Default 15 minutes. */
  isolateMaxAgeMs?: number;
}

export function shouldRecycleIsolate(
  executionCount: number,
  ageMs: number,
  maxExecutions: number,
  maxAgeMs: number,
): boolean {
  if (maxExecutions > 0 && executionCount >= maxExecutions) {
    return true;
  }
  if (maxAgeMs > 0 && ageMs >= maxAgeMs) {
    return true;
  }
  return false;
}

export class ScriptExecutor {
  private runtime: ScriptRuntime | null = null;
  private isolateRuntimePromise: Promise<ScriptRuntime> | null = null;
  private executionCount = 0;
  private inFlight = 0;
  private isolateCreatedAtMs: number | null = null;
  readonly sandboxed: boolean;
  private readonly memoryLimitMb: number;
  private readonly isolateMaxExecutions: number;
  private readonly isolateMaxAgeMs: number;

  constructor(
    private readonly defaultTimeoutMs: number,
    options: ScriptExecutorOptions = {},
  ) {
    this.sandboxed = options.sandboxed ?? false;
    this.memoryLimitMb = options.memoryLimitMb ?? 128;
    this.isolateMaxExecutions = options.isolateMaxExecutions ?? DEFAULT_ISOLATE_MAX_EXECUTIONS;
    this.isolateMaxAgeMs = options.isolateMaxAgeMs ?? DEFAULT_ISOLATE_MAX_AGE_MS;
    if (!this.sandboxed) {
      this.runtime = new ScriptDirectRuntime();
    }
  }

  private loadIsolateRuntime(): Promise<ScriptRuntime> {
    if (!this.isolateRuntimePromise) {
      this.isolateRuntimePromise = import('./script-isolate-runtime.js').then(
        ({ ScriptIsolateRuntime }) => {
          this.isolateCreatedAtMs = Date.now();
          this.executionCount = 0;
          return new ScriptIsolateRuntime(this.memoryLimitMb);
        },
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

  private maybeRecycleIsolate(logger: ScriptLogger): void {
    if (!this.sandboxed || !this.runtime || this.inFlight > 0) {
      return;
    }

    const ageMs =
      this.isolateCreatedAtMs != null ? Date.now() - this.isolateCreatedAtMs : 0;
    if (
      !shouldRecycleIsolate(
        this.executionCount,
        ageMs,
        this.isolateMaxExecutions,
        this.isolateMaxAgeMs,
      )
    ) {
      return;
    }

    const reason =
      this.isolateMaxExecutions > 0 && this.executionCount >= this.isolateMaxExecutions
        ? `${this.executionCount} executions`
        : `${Math.round(ageMs / 1000)}s age`;
    logger.info(`[ScriptRuntime] Recycled isolate after ${reason}`);
    this.dispose();
  }

  async execute(
    script: string,
    context: ScriptExecutionContext,
    logger: ScriptLogger,
    timeoutMs = this.defaultTimeoutMs,
  ): Promise<unknown> {
    if (this.sandboxed) {
      this.maybeRecycleIsolate(logger);
    }

    const runtime = this.sandboxed ? await this.ensureRuntime() : this.runtime!;
    this.inFlight += 1;
    try {
      const result = await runtime.execute(script, context, logger, timeoutMs);
      if (this.sandboxed) {
        this.executionCount += 1;
      }
      return result;
    } finally {
      this.inFlight = Math.max(0, this.inFlight - 1);
    }
  }

  dispose(): void {
    this.runtime?.dispose();
    this.runtime = null;
    this.isolateRuntimePromise = null;
    this.executionCount = 0;
    this.inFlight = 0;
    this.isolateCreatedAtMs = null;
  }
}
