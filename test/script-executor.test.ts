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
      createLogger(),
    );

    expect(result).toBe(2);
    expect(variables.count).toBe(2);
    executor.dispose();
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
        createLogger(),
        50,
      ),
    ).rejects.toThrow(/timed out/i);

    executor.dispose();
  });

  it('does not expose require to user scripts', async () => {
    const executor = new ScriptExecutor(5000);

    await expect(
      executor.execute(
        'require("node:fs");',
        {
          client: {} as never,
          config: { token: 'x' } as never,
          variables: {},
        },
        createLogger(),
      ),
    ).rejects.toThrow(/require is not defined/i);

    executor.dispose();
  });

  it('does not expose process to user scripts', async () => {
    const executor = new ScriptExecutor(5000);

    await expect(
      executor.execute(
        'process.exit(1);',
        {
          client: {} as never,
          config: { token: 'x' } as never,
          variables: {},
        },
        createLogger(),
      ),
    ).rejects.toThrow(/process is not defined/i);

    executor.dispose();
  });

  it('does not expose config.token to user scripts', async () => {
    const executor = new ScriptExecutor(5000);

    const result = await executor.execute(
      'return config.token;',
      {
        client: {} as never,
        config: { token: 'super-secret-token' } as never,
        variables: {},
      },
      createLogger(),
    );

    expect(result).toBeUndefined();
    executor.dispose();
  });

  it('calls host bridged methods such as interaction.reply', async () => {
    const executor = new ScriptExecutor(5000);
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
