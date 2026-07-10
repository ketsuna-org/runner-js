import { describe, expect, it, vi } from 'vitest';

import { ScriptExecutor } from '../src/scripts/script-executor.js';

function createDirectExecutor(timeoutMs = 5000): ScriptExecutor {
  return new ScriptExecutor(timeoutMs, { sandboxed: false });
}

describe('ScriptDirectRuntime', () => {
  it('allows require("node:fs")', async () => {
    const executor = createDirectExecutor();
    const result = await executor.execute(
      `
        const fs = require('node:fs');
        return typeof fs.readFileSync;
      `,
      {
        client: {} as never,
        config: { token: 'x' } as never,
        variables: {},
      },
      createLogger(),
    );

    expect(result).toBe('function');
    executor.dispose();
  });

  it('allows require("path")', async () => {
    const executor = createDirectExecutor();
    const result = await executor.execute(
      `
        const path = require('path');
        return path.join('a', 'b');
      `,
      {
        client: {} as never,
        config: { token: 'x' } as never,
        variables: {},
      },
      createLogger(),
    );

    expect(result).toBe('a/b');
    executor.dispose();
  });

  it('persists variable mutations after execution', async () => {
    const executor = createDirectExecutor();
    const variables: Record<string, unknown> = { count: 1 };

    const result = await executor.execute(
      'variables.count = 2; return variables.count;',
      {
        client: {} as never,
        config: { token: 'x' } as never,
        variables,
      },
      createLogger(),
    );

    expect(result).toBe(2);
    expect(variables.count).toBe(2);
    executor.dispose();
  });

  it('times out long running scripts', async () => {
    const executor = createDirectExecutor(50);

    await expect(
      executor.execute(
        'await new Promise((resolve) => setTimeout(resolve, 500));',
        {
          client: {} as never,
          config: { token: 'x' } as never,
          variables: {},
        },
        createLogger(),
      ),
    ).rejects.toThrow(/timed out/i);

    executor.dispose();
  });

  it('calls interaction.reply with real objects', async () => {
    const executor = createDirectExecutor();
    const reply = vi.fn(async () => ({ ok: true }));

    await executor.execute(
      "await interaction.reply({ content: 'pong' });",
      {
        client: {} as never,
        config: { token: 'x' } as never,
        variables: {},
        interaction: { reply } as never,
      },
      createLogger(),
    );

    expect(reply).toHaveBeenCalledWith({ content: 'pong' });
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
