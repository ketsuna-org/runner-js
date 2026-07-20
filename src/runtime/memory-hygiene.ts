/** Default RSS threshold (MB) before a worker soft-restarts. 0 = disabled. */
export const DEFAULT_WORKER_RSS_RESTART_MB = 350;
/** Consecutive checks above threshold required before restart. */
export const DEFAULT_WORKER_RSS_RESTART_CHECKS = 3;
/** Minimum worker uptime before an RSS soft-restart is allowed. */
export const DEFAULT_WORKER_RSS_RESTART_MIN_UPTIME_MS = 5 * 60 * 1000;
/** Max bytes retained per worker stderr buffer in the parent process. */
export const DEFAULT_WORKER_STDERR_MAX_BYTES = 16 * 1024;
/** Default V8 old-space heap cap (MB) for bot workers. 0 = disabled. */
export const DEFAULT_WORKER_MAX_HEAP_MB = 512;
/** Max bytes allowed for script-side fetch() response bodies. */
export const MAX_FETCH_BODY_BYTES = 10 * 1024 * 1024;

export interface WorkerRssRestartDecision {
  shouldRestart: boolean;
  nextConsecutiveOver: number;
}

/**
 * Pure decision helper for worker RSS soft-restart.
 * Returns whether to exit (and let the parent auto-restart) and the updated streak.
 */
export function evaluateWorkerRssRestart(input: {
  rssMb: number;
  thresholdMb: number;
  consecutiveOver: number;
  requiredConsecutive: number;
  uptimeMs: number;
  minUptimeMs: number;
}): WorkerRssRestartDecision {
  const {
    rssMb,
    thresholdMb,
    consecutiveOver,
    requiredConsecutive,
    uptimeMs,
    minUptimeMs,
  } = input;

  if (thresholdMb <= 0) {
    return { shouldRestart: false, nextConsecutiveOver: 0 };
  }

  if (rssMb < thresholdMb) {
    return { shouldRestart: false, nextConsecutiveOver: 0 };
  }

  const nextConsecutiveOver = consecutiveOver + 1;
  if (uptimeMs < minUptimeMs) {
    return { shouldRestart: false, nextConsecutiveOver };
  }

  if (nextConsecutiveOver < requiredConsecutive) {
    return { shouldRestart: false, nextConsecutiveOver };
  }

  return { shouldRestart: true, nextConsecutiveOver };
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

/** Appends stderr text while keeping only the last `maxBytes` characters. */
export function appendCappedText(
  previous: string,
  chunk: string,
  maxBytes: number,
): string {
  if (maxBytes <= 0) {
    return '';
  }
  const combined = previous.length > 0 ? `${previous}\n${chunk}` : chunk;
  if (combined.length <= maxBytes) {
    return combined;
  }
  return combined.slice(combined.length - maxBytes);
}

/**
 * Builds NODE_OPTIONS for a worker, injecting --max-old-space-size when enabled.
 * Preserves any existing parent NODE_OPTIONS (without duplicating the flag).
 */
export function buildWorkerNodeOptions(
  existingNodeOptions: string | undefined,
  maxHeapMb: number,
): string | undefined {
  const existing = (existingNodeOptions ?? '').trim();
  if (maxHeapMb <= 0) {
    return existing.length > 0 ? existing : undefined;
  }

  const flag = `--max-old-space-size=${maxHeapMb}`;
  if (existing.includes('--max-old-space-size')) {
    return existing.replace(/--max-old-space-size=\d+/g, flag);
  }
  return existing.length > 0 ? `${existing} ${flag}` : flag;
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
