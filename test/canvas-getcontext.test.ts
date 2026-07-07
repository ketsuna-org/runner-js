import { describe, expect, it, vi } from 'vitest';

import { ScriptExecutor } from '../src/scripts/script-executor.js';

describe('canvas getContext', () => {
  it('supports synchronous createCanvas and getContext', async () => {
    const executor = new ScriptExecutor(5000);

    const result = await executor.execute(
      `
        let createCanvasType = 'missing';
        try {
          createCanvasType = typeof require('canvas').createCanvas;
        } catch {}
        if (createCanvasType !== 'function') {
          return { skipped: true };
        }

        const { createCanvas } = require('canvas');
        const canvas = createCanvas(100, 100);
        const ctx = canvas.getContext('2d');
        ctx.fillRect(0, 0, 50, 50);
        return {
          width: canvas.width,
          ctxType: typeof ctx,
          fillRectType: typeof ctx.fillRect,
          ctxIsPromise: ctx != null && typeof ctx.then === 'function',
        };
      `,
      {
        client: {} as never,
        config: { token: 'x' } as never,
        variables: {},
      },
      createLogger(),
    ) as {
      skipped?: boolean;
      width?: number;
      ctxType?: string;
      fillRectType?: string;
      ctxIsPromise?: boolean;
    };

    if (result.skipped) {
      executor.dispose();
      return;
    }

    expect(result.width).toBe(100);
    expect(result.ctxType).toBe('object');
    expect(result.fillRectType).toBe('function');
    expect(result.ctxIsPromise).toBe(false);
    executor.dispose();
  });

  it('works when createCanvas and getContext are awaited', async () => {
    const executor = new ScriptExecutor(5000);

    const result = await executor.execute(
      `
        let createCanvasType = 'missing';
        try {
          createCanvasType = typeof require('canvas').createCanvas;
        } catch {}
        if (createCanvasType !== 'function') {
          return { skipped: true };
        }

        const { createCanvas } = require('canvas');
        const canvas = await createCanvas(100, 100);
        const ctx = await canvas.getContext('2d');
        ctx.fillRect(0, 0, 50, 50);
        return {
          width: canvas.width,
          ctxType: typeof ctx,
          fillRectType: typeof ctx.fillRect,
        };
      `,
      {
        client: {} as never,
        config: { token: 'x' } as never,
        variables: {},
      },
      createLogger(),
    ) as {
      skipped?: boolean;
      width?: number;
      ctxType?: string;
      fillRectType?: string;
    };

    if (result.skipped) {
      executor.dispose();
      return;
    }

    expect(result.width).toBe(100);
    expect(result.ctxType).toBe('object');
    expect(result.fillRectType).toBe('function');
    executor.dispose();
  });
});

function createLogger() {
  return {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}
