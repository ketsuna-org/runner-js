import { describe, expect, it, vi } from 'vitest';

import { ScriptExecutor } from '../src/scripts/script-executor.js';

describe('ScriptExecutor', () => {
  it('executes async user script with injected context', async () => {
    const executor = new ScriptExecutor(5000);
    const variables: Record<string, unknown> = { count: 1 };
    const client = { tag: 'client' };

    const result = await executor.execute(
      'variables.count = 2; return variables.count;',
      {
        client: client as never,
        config: { token: 'x' } as never,
        variables,
      },
      {
        log: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    );

    expect(result).toBe(2);
    expect(variables.count).toBe(2);
  });

  it('times out long running scripts', async () => {
    const executor = new ScriptExecutor(50);

    await expect(
      executor.execute(
        'await new Promise((resolve) => setTimeout(resolve, 200));',
        {
          client: {} as never,
          config: { token: 'x' } as never,
          variables: {},
        },
        {
          log: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        },
        50,
      ),
    ).rejects.toThrow(/timed out/i);
  });
});
