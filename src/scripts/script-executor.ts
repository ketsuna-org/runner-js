import { parsePositiveIntEnv } from '../runtime/memory-hygiene.js';
import type { ScriptExecutionContext, ScriptLogger } from './script-context.js';
import { ScriptDirectRuntime } from './script-direct-runtime.js';
import type { ScriptRuntime } from './script-runtime.js';

/** Recycle isolate after this many script executions (sandbox only). */
export const DEFAULT_ISOLATE_MAX_EXECUTIONS = 200;
/** Recycle isolate after this age even if execution count is low. */
export const DEFAULT_ISOLATE_MAX_AGE_MS = 15 * 60 * 1000;
/** Dispose the isolate after this long without a script execution. 0 = disabled. */
export const DEFAULT_ISOLATE_IDLE_DISPOSE_MS = 5 * 60 * 1000;
/** Default per-isolate V8 heap cap (MB). */
export const DEFAULT_ISOLATE_MEMORY_LIMIT_MB = 128;

/** Resolves the isolate heap cap, honoring BOT_CREATOR_ISOLATE_MEMORY_MB. */
export function resolveIsolateMemoryLimitMb(
  raw: string | undefined = process.env.BOT_CREATOR_ISOLATE_MEMORY_MB,
): number {
  const parsed = parsePositiveIntEnv(raw, DEFAULT_ISOLATE_MEMORY_LIMIT_MB);
  return parsed > 0 ? parsed : DEFAULT_ISOLATE_MEMORY_LIMIT_MB;
}

export interface ScriptExecutorOptions {
  sandboxed?: boolean;
  /** Per-isolate heap cap in MB. Defaults to BOT_CREATOR_ISOLATE_MEMORY_MB or 128. */
  memoryLimitMb?: number;
  /** Max script runs before recycling the isolate. Default 200. */
  isolateMaxExecutions?: number;
  /** Max isolate lifetime in ms before recycling. Default 15 minutes. */
  isolateMaxAgeMs?: number;
  /** Dispose the isolate after this long with no executions. Default 5 minutes, 0 = disabled. */
  isolateIdleDisposeMs?: number;
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
  private lastActivityMs: number | null = null;
  readonly sandboxed: boolean;
  private readonly memoryLimitMb: number;
  private readonly isolateMaxExecutions: number;
  private readonly isolateMaxAgeMs: number;
  private readonly isolateIdleDisposeMs: number;

  constructor(
    private readonly defaultTimeoutMs: number,
    options: ScriptExecutorOptions = {},
  ) {
    this.sandboxed = options.sandboxed ?? false;
    this.memoryLimitMb = options.memoryLimitMb ?? resolveIsolateMemoryLimitMb();
    this.isolateMaxExecutions = options.isolateMaxExecutions ?? DEFAULT_ISOLATE_MAX_EXECUTIONS;
    this.isolateMaxAgeMs = options.isolateMaxAgeMs ?? DEFAULT_ISOLATE_MAX_AGE_MS;
    this.isolateIdleDisposeMs =
      options.isolateIdleDisposeMs ?? DEFAULT_ISOLATE_IDLE_DISPOSE_MS;
    if (!this.sandboxed) {
      this.runtime = new ScriptDirectRuntime();
    }
  }

  private loadIsolateRuntime(): Promise<ScriptRuntime> {
    if (!this.isolateRuntimePromise) {
      this.isolateRuntimePromise = import('./script-isolate-runtime.js').then(
        ({ ScriptIsolateRuntime }) => {
          this.isolateCreatedAtMs = Date.now();
          this.lastActivityMs = Date.now();
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

  /**
   * Disposes the sandbox isolate when it has been idle long enough (or when
   * `force` is set, e.g. under process memory pressure). The isolate is
   * lazily recreated on the next execution. Returns whether it was disposed.
   */
  disposeIdleIsolate(force = false): boolean {
    if (!this.sandboxed || !this.runtime || this.inFlight > 0) {
      return false;
    }
    if (!force) {
      if (this.isolateIdleDisposeMs <= 0) {
        return false;
      }
      const idleMs = Date.now() - (this.lastActivityMs ?? 0);
      if (idleMs < this.isolateIdleDisposeMs) {
        return false;
      }
    }
    this.dispose();
    return true;
  }

  /** Heap used by the sandbox isolate, or null when no isolate exists. */
  getHeapUsedBytes(): number | null {
    if (!this.sandboxed) {
      return null;
    }
    return this.runtime?.getHeapUsedBytes?.() ?? null;
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
      this.lastActivityMs = Date.now();
      // Recycle after the last concurrent run finishes so busy bots still reclaim.
      if (this.sandboxed) {
        this.maybeRecycleIsolate(logger);
      }
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
