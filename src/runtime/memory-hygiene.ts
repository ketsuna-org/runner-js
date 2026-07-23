/**
 * Memory policy for the shared bot process.
 *
 * All bots run in a single Node process. When RSS is sustained above the soft
 * threshold, idle script isolates are force-disposed. If RSS stays above the
 * critical threshold, the process exits non-zero so the container
 * orchestrator restarts the node (bots are re-synced by pool bootstrap).
 */

/** Sustained RSS (MB) above which idle isolates are force-disposed. 0 = disabled. */
export const DEFAULT_PROCESS_RSS_SOFT_MB = 768;
/** Sustained RSS (MB) above which the process exits non-zero. 0 = disabled. */
export const DEFAULT_PROCESS_RSS_CRITICAL_MB = 1024;
/** Consecutive checks above a threshold required before acting. */
export const DEFAULT_PROCESS_RSS_CHECKS = 3;
/** Minimum process uptime before RSS actions are allowed. */
export const DEFAULT_PROCESS_RSS_MIN_UPTIME_MS = 5 * 60 * 1000;
/** Max bytes allowed for script-side fetch() response bodies. */
export const MAX_FETCH_BODY_BYTES = 10 * 1024 * 1024;

export interface ProcessMemoryPolicy {
  softThresholdMb: number;
  criticalThresholdMb: number;
  requiredConsecutive: number;
  minUptimeMs: number;
}

export function resolveProcessMemoryPolicy(
  env: NodeJS.ProcessEnv = process.env,
): ProcessMemoryPolicy {
  return {
    softThresholdMb: parsePositiveIntEnv(
      env.BOT_CREATOR_PROCESS_RSS_SOFT_MB,
      DEFAULT_PROCESS_RSS_SOFT_MB,
    ),
    criticalThresholdMb: parsePositiveIntEnv(
      env.BOT_CREATOR_PROCESS_RSS_CRITICAL_MB,
      DEFAULT_PROCESS_RSS_CRITICAL_MB,
    ),
    requiredConsecutive: Math.max(
      1,
      parsePositiveIntEnv(env.BOT_CREATOR_PROCESS_RSS_CHECKS, DEFAULT_PROCESS_RSS_CHECKS),
    ),
    minUptimeMs: parsePositiveIntEnv(
      env.BOT_CREATOR_PROCESS_RSS_MIN_UPTIME_MS,
      DEFAULT_PROCESS_RSS_MIN_UPTIME_MS,
    ),
  };
}

export interface SustainedRssDecision {
  shouldTrigger: boolean;
  nextConsecutiveOver: number;
}

/**
 * Pure decision helper for sustained-RSS thresholds.
 * Returns whether to act and the updated over-threshold streak.
 */
export function evaluateSustainedRss(input: {
  rssMb: number;
  thresholdMb: number;
  consecutiveOver: number;
  requiredConsecutive: number;
  uptimeMs: number;
  minUptimeMs: number;
}): SustainedRssDecision {
  const {
    rssMb,
    thresholdMb,
    consecutiveOver,
    requiredConsecutive,
    uptimeMs,
    minUptimeMs,
  } = input;

  if (thresholdMb <= 0) {
    return { shouldTrigger: false, nextConsecutiveOver: 0 };
  }

  if (rssMb < thresholdMb) {
    return { shouldTrigger: false, nextConsecutiveOver: 0 };
  }

  const nextConsecutiveOver = consecutiveOver + 1;
  if (uptimeMs < minUptimeMs) {
    return { shouldTrigger: false, nextConsecutiveOver };
  }

  if (nextConsecutiveOver < requiredConsecutive) {
    return { shouldTrigger: false, nextConsecutiveOver };
  }

  return { shouldTrigger: true, nextConsecutiveOver };
}

export function parsePositiveIntEnv(
  raw: string | undefined,
  fallback: number,
): number {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) {
    return fallback;
  }
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Reads a fetch Response body with a hard byte cap.
 * Rejects early on Content-Length, otherwise streams until the limit.
 */
export async function readResponseBodyCapped(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const contentLengthHeader = response.headers.get('content-length');
  if (contentLengthHeader) {
    const contentLength = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new Error(
        `fetch: response body exceeds ${maxBytes} byte limit (Content-Length: ${contentLength})`,
      );
    }
  }

  if (!response.body) {
    // Response-like mocks (and some polyfills) expose text() without a ReadableStream body.
    if (typeof response.text === 'function') {
      const text = await response.text();
      const byteLength = new TextEncoder().encode(text).byteLength;
      if (byteLength > maxBytes) {
        throw new Error(`fetch: response body exceeds ${maxBytes} byte limit`);
      }
      return text;
    }
    return '';
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`fetch: response body exceeds ${maxBytes} byte limit`);
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // ignore cancel errors after a failed read
    }
    throw error;
  }

  return chunks.join('');
}
