import { describe, expect, it } from 'vitest';

import {
  appendCappedText,
  buildWorkerNodeOptions,
  evaluateWorkerRssRestart,
  parsePositiveIntEnv,
  readResponseBodyCapped,
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

describe('evaluateWorkerRssRestart', () => {
  it('does nothing when threshold is disabled', () => {
    expect(
      evaluateWorkerRssRestart({
        rssMb: 999,
        thresholdMb: 0,
        consecutiveOver: 5,
        requiredConsecutive: 3,
        uptimeMs: 60 * 60 * 1000,
        minUptimeMs: 10 * 60 * 1000,
      }),
    ).toEqual({ shouldRestart: false, nextConsecutiveOver: 0 });
  });

  it('resets streak when RSS drops below threshold', () => {
    expect(
      evaluateWorkerRssRestart({
        rssMb: 100,
        thresholdMb: 400,
        consecutiveOver: 2,
        requiredConsecutive: 3,
        uptimeMs: 60 * 60 * 1000,
        minUptimeMs: 10 * 60 * 1000,
      }),
    ).toEqual({ shouldRestart: false, nextConsecutiveOver: 0 });
  });

  it('increments streak but does not restart before min uptime', () => {
    expect(
      evaluateWorkerRssRestart({
        rssMb: 500,
        thresholdMb: 400,
        consecutiveOver: 2,
        requiredConsecutive: 3,
        uptimeMs: 5 * 60 * 1000,
        minUptimeMs: 10 * 60 * 1000,
      }),
    ).toEqual({ shouldRestart: false, nextConsecutiveOver: 3 });
  });

  it('restarts after sustained high RSS past min uptime', () => {
    expect(
      evaluateWorkerRssRestart({
        rssMb: 500,
        thresholdMb: 400,
        consecutiveOver: 2,
        requiredConsecutive: 3,
        uptimeMs: 15 * 60 * 1000,
        minUptimeMs: 10 * 60 * 1000,
      }),
    ).toEqual({ shouldRestart: true, nextConsecutiveOver: 3 });
  });

  it('does not restart before required consecutive checks', () => {
    expect(
      evaluateWorkerRssRestart({
        rssMb: 500,
        thresholdMb: 400,
        consecutiveOver: 1,
        requiredConsecutive: 3,
        uptimeMs: 15 * 60 * 1000,
        minUptimeMs: 10 * 60 * 1000,
      }),
    ).toEqual({ shouldRestart: false, nextConsecutiveOver: 2 });
  });
});

describe('appendCappedText', () => {
  it('keeps content under maxBytes without trimming when short', () => {
    expect(appendCappedText('aa', 'bb', 10)).toBe('aa\nbb');
  });

  it('trims from the front when over budget', () => {
    const result = appendCappedText('aaaaaaaa', 'bbbb', 8);
    expect(result.length).toBe(8);
    expect(result.endsWith('bbbb')).toBe(true);
  });

  it('returns empty string when maxBytes is 0', () => {
    expect(appendCappedText('hello', 'world', 0)).toBe('');
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

describe('buildWorkerNodeOptions', () => {
  it('injects max-old-space-size when enabled', () => {
    expect(buildWorkerNodeOptions(undefined, 512)).toBe('--max-old-space-size=512');
    expect(buildWorkerNodeOptions('--enable-source-maps', 256)).toBe(
      '--enable-source-maps --max-old-space-size=256',
    );
  });

  it('replaces an existing max-old-space-size flag', () => {
    expect(buildWorkerNodeOptions('--max-old-space-size=1024 --trace-warnings', 256)).toBe(
      '--max-old-space-size=256 --trace-warnings',
    );
  });

  it('returns existing options unchanged when disabled', () => {
    expect(buildWorkerNodeOptions(undefined, 0)).toBeUndefined();
    expect(buildWorkerNodeOptions('--trace-warnings', 0)).toBe('--trace-warnings');
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
