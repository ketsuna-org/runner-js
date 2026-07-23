import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PROCESS_RSS_CHECKS,
  DEFAULT_PROCESS_RSS_CRITICAL_MB,
  DEFAULT_PROCESS_RSS_MIN_UPTIME_MS,
  DEFAULT_PROCESS_RSS_SOFT_MB,
  evaluateSustainedRss,
  parsePositiveIntEnv,
  readResponseBodyCapped,
  resolveProcessMemoryPolicy,
} from '../src/runtime/memory-hygiene.js';
import { shouldRecycleIsolate } from '../src/scripts/script-executor.js';

describe('shouldRecycleIsolate', () => {
  it('recycles when execution count reaches the max', () => {
    expect(shouldRecycleIsolate(200, 1000, 200, 15 * 60 * 1000)).toBe(true);
    expect(shouldRecycleIsolate(199, 1000, 200, 15 * 60 * 1000)).toBe(false);
  });

  it('recycles when isolate age reaches the max', () => {
    expect(shouldRecycleIsolate(10, 15 * 60 * 1000, 200, 15 * 60 * 1000)).toBe(true);
    expect(shouldRecycleIsolate(10, 14 * 60 * 1000, 200, 15 * 60 * 1000)).toBe(false);
  });

  it('ignores disabled thresholds (0)', () => {
    expect(shouldRecycleIsolate(999, 999_999, 0, 0)).toBe(false);
  });
});

describe('evaluateSustainedRss', () => {
  it('does nothing when threshold is disabled', () => {
    expect(
      evaluateSustainedRss({
        rssMb: 999,
        thresholdMb: 0,
        consecutiveOver: 5,
        requiredConsecutive: 3,
        uptimeMs: 60 * 60 * 1000,
        minUptimeMs: 10 * 60 * 1000,
      }),
    ).toEqual({ shouldTrigger: false, nextConsecutiveOver: 0 });
  });

  it('resets streak when RSS drops below threshold', () => {
    expect(
      evaluateSustainedRss({
        rssMb: 100,
        thresholdMb: 400,
        consecutiveOver: 2,
        requiredConsecutive: 3,
        uptimeMs: 60 * 60 * 1000,
        minUptimeMs: 10 * 60 * 1000,
      }),
    ).toEqual({ shouldTrigger: false, nextConsecutiveOver: 0 });
  });

  it('increments streak but does not trigger before min uptime', () => {
    expect(
      evaluateSustainedRss({
        rssMb: 500,
        thresholdMb: 400,
        consecutiveOver: 2,
        requiredConsecutive: 3,
        uptimeMs: 5 * 60 * 1000,
        minUptimeMs: 10 * 60 * 1000,
      }),
    ).toEqual({ shouldTrigger: false, nextConsecutiveOver: 3 });
  });

  it('triggers after sustained high RSS past min uptime', () => {
    expect(
      evaluateSustainedRss({
        rssMb: 500,
        thresholdMb: 400,
        consecutiveOver: 2,
        requiredConsecutive: 3,
        uptimeMs: 15 * 60 * 1000,
        minUptimeMs: 10 * 60 * 1000,
      }),
    ).toEqual({ shouldTrigger: true, nextConsecutiveOver: 3 });
  });

  it('does not trigger before required consecutive checks', () => {
    expect(
      evaluateSustainedRss({
        rssMb: 500,
        thresholdMb: 400,
        consecutiveOver: 1,
        requiredConsecutive: 3,
        uptimeMs: 15 * 60 * 1000,
        minUptimeMs: 10 * 60 * 1000,
      }),
    ).toEqual({ shouldTrigger: false, nextConsecutiveOver: 2 });
  });
});

describe('resolveProcessMemoryPolicy', () => {
  it('falls back to defaults with an empty environment', () => {
    expect(resolveProcessMemoryPolicy({})).toEqual({
      softThresholdMb: DEFAULT_PROCESS_RSS_SOFT_MB,
      criticalThresholdMb: DEFAULT_PROCESS_RSS_CRITICAL_MB,
      requiredConsecutive: DEFAULT_PROCESS_RSS_CHECKS,
      minUptimeMs: DEFAULT_PROCESS_RSS_MIN_UPTIME_MS,
    });
  });

  it('honors env overrides and enforces at least one check', () => {
    expect(
      resolveProcessMemoryPolicy({
        BOT_CREATOR_PROCESS_RSS_SOFT_MB: '1200',
        BOT_CREATOR_PROCESS_RSS_CRITICAL_MB: '1600',
        BOT_CREATOR_PROCESS_RSS_CHECKS: '0',
        BOT_CREATOR_PROCESS_RSS_MIN_UPTIME_MS: '60000',
      }),
    ).toEqual({
      softThresholdMb: 1200,
      criticalThresholdMb: 1600,
      requiredConsecutive: 1,
      minUptimeMs: 60_000,
    });
  });
});

describe('parsePositiveIntEnv', () => {
  it('parses valid integers and falls back otherwise', () => {
    expect(parsePositiveIntEnv('400', 100)).toBe(400);
    expect(parsePositiveIntEnv('0', 100)).toBe(0);
    expect(parsePositiveIntEnv('', 100)).toBe(100);
    expect(parsePositiveIntEnv('nope', 100)).toBe(100);
    expect(parsePositiveIntEnv('-5', 100)).toBe(100);
  });
});

describe('readResponseBodyCapped', () => {
  it('rejects early when Content-Length exceeds the limit', async () => {
    const response = new Response('ignored', {
      headers: { 'content-length': '100' },
    });
    await expect(readResponseBodyCapped(response, 50)).rejects.toThrow(
      /Content-Length: 100/,
    );
  });

  it('returns the body when under the limit', async () => {
    const response = new Response('hello world', {
      headers: { 'content-length': '11' },
    });
    await expect(readResponseBodyCapped(response, 100)).resolves.toBe('hello world');
  });

  it('falls back to text() when Response has no body stream', async () => {
    const response = {
      headers: new Headers(),
      body: null,
      text: async () => '{"hello":"world"}',
    } as unknown as Response;
    await expect(readResponseBodyCapped(response, 100)).resolves.toBe('{"hello":"world"}');
  });

  it('cuts off when the streamed body exceeds the limit', async () => {
    const encoder = new TextEncoder();
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled <= 3) {
          controller.enqueue(encoder.encode('abcdefghij'));
          return;
        }
        controller.close();
      },
    });
    const response = new Response(stream);
    await expect(readResponseBodyCapped(response, 25)).rejects.toThrow(
      /exceeds 25 byte limit/,
    );
  });
});
