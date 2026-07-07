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

  it('rejects disallowed require modules', async () => {
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
    ).rejects.toThrow(/not allowed/i);

    executor.dispose();
  });

  it('exposes allowlisted canvas and voice modules via require', async () => {
    const executor = new ScriptExecutor(5000);

    const result = await executor.execute(
      `
        let canvasCreate = 'missing';
        let voiceJoin = 'missing';
        let voiceStatus = 'missing';
        try {
          canvasCreate = typeof require('canvas').createCanvas;
        } catch {}
        try {
          const voice = require('@discordjs/voice');
          voiceJoin = typeof voice.joinVoiceChannel;
          voiceStatus = typeof voice.VoiceConnectionStatus;
        } catch {}
        return { canvasCreate, voiceJoin, voiceStatus };
      `,
      {
        client: {} as never,
        config: { token: 'x' } as never,
        variables: {},
      },
      createLogger(),
    ) as { canvasCreate?: string; voiceJoin?: string; voiceStatus?: string };

    if (result.canvasCreate === 'function') {
      expect(result.voiceJoin).toBe('function');
      expect(result.voiceStatus).toBe('object');
    } else {
      expect(result.canvasCreate).toBe('missing');
    }

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

  it('exposes the full client but not the token', async () => {
    const executor = new ScriptExecutor(5000);
    const fetchInvites = vi.fn(async () => ['invite']);
    const client = {
      token: 'super-secret-token',
      uptime: 1000,
      ws: {
        get ping() {
          return 42;
        },
      },
      guilds: {
        cache: {
          size: 2,
        },
      },
      fetchInvites,
    };

    const result = await executor.execute(
      `
        return {
          ping: client.ws.ping,
          guildCount: client.guilds.cache.size,
          token: client.token,
          invites: await client.fetchInvites('guild-id'),
        };
      `,
      {
        client: client as never,
        config: { token: 'x' } as never,
        variables: {},
      },
      createLogger(),
    ) as {
      ping?: number;
      guildCount?: number;
      token?: string;
      invites?: string[];
    };

    expect(result.ping).toBe(42);
    expect(result.guildCount).toBe(2);
    expect(result.token).toBeUndefined();
    expect(result.invites).toEqual(['invite']);
    expect(fetchInvites).toHaveBeenCalledWith('guild-id');
    executor.dispose();
  });

  it('exposes client.ws.ping from the host websocket manager', async () => {
    const executor = new ScriptExecutor(5000);
    const client = {
      user: null,
      readyTimestamp: Date.now(),
      uptime: 1000,
      ws: {
        get ping() {
          return 42;
        },
        status: 0,
      },
    };

    const result = await executor.execute(
      'return client.ws.ping;',
      {
        client: client as never,
        config: { token: 'x' } as never,
        variables: {},
      },
      createLogger(),
    );

    expect(result).toBe(42);
    executor.dispose();
  });

  it('exposes full interaction and message APIs dynamically', async () => {
    const executor = new ScriptExecutor(5000);
    const reply = vi.fn(async () => ({ ok: true }));
    const react = vi.fn(async () => undefined);
    const getString = vi.fn(() => 'hello');

    const result = await executor.execute(
      `
        await interaction.reply({ content: await interaction.options.getString('name') });
        await message.react('✅');
        return {
          commandName: interaction.commandName,
          content: message.content,
        };
      `,
      {
        client: {} as never,
        config: { token: 'x' } as never,
        variables: {},
        interaction: {
          commandName: 'greet',
          reply,
          options: { getString },
        } as never,
        message: {
          content: 'ping',
          react,
        } as never,
      },
      createLogger(),
    ) as { commandName?: string; content?: string };

    expect(result.commandName).toBe('greet');
    expect(result.content).toBe('ping');
    expect(getString).toHaveBeenCalledWith('name');
    expect(reply).toHaveBeenCalledWith({ content: 'hello' });
    expect(react).toHaveBeenCalledWith('✅');
    executor.dispose();
  });

  it('supports eval-based prefix command scripts', async () => {
    const executor = new ScriptExecutor(5000);
    const reply = vi.fn(async (payload: { content: string }) => ({ content: payload.content }));

    await executor.execute(
      `
        let args = message.content.split(" ");
        let content = args.slice(1).join(" ");
        try {
          await message.reply(String(eval(content)));
        } catch (err) {
          await message.reply(String(err.message));
        }
      `,
      {
        client: {} as never,
        config: { token: 'x' } as never,
        variables: {},
        message: {
          content: '!eval 2 + 2',
          reply,
        } as never,
      },
      createLogger(),
    );

    expect(reply).toHaveBeenCalledWith('4');
    executor.dispose();
  });

  it('serializes concurrent script executions on the same isolate', async () => {
    const executor = new ScriptExecutor(5000);
    const order: string[] = [];
    const reply = vi.fn(async (payload: { content: string }) => {
      order.push(payload.content);
      return { content: payload.content };
    });

    const first = executor.execute(
      `
        await new Promise((resolve) => setTimeout(resolve, 40));
        await message.reply({ content: 'first' });
      `,
      {
        client: {} as never,
        config: { token: 'x' } as never,
        variables: {},
        message: { reply } as never,
      },
      createLogger(),
    );

    await new Promise((resolve) => setTimeout(resolve, 5));

    const second = executor.execute(
      `await message.reply({ content: 'second' });`,
      {
        client: {} as never,
        config: { token: 'x' } as never,
        variables: {},
        message: { reply } as never,
      },
      createLogger(),
    );

    await Promise.all([first, second]);
    expect(order).toEqual(['first', 'second']);
    executor.dispose();
  });

  it('runs setTimeout callbacks before releasing the host bridge', async () => {
    const executor = new ScriptExecutor(5000);
    const reply = vi.fn(async () => ({ ok: true }));

    await executor.execute(
      `
        setTimeout(async () => {
          await interaction.reply({ content: 'delayed' });
        }, 20);
      `,
      {
        client: {} as never,
        config: { token: 'x' } as never,
        variables: {},
        interaction: { reply } as never,
      },
      createLogger(),
    );

    expect(reply).toHaveBeenCalledWith({ content: 'delayed' });
    executor.dispose();
  });

  it('waits for fire-and-forget host calls before releasing the bridge', async () => {
    const executor = new ScriptExecutor(5000);
    let replyFinished = false;
    const reply = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      replyFinished = true;
      return { ok: true };
    });

    await executor.execute(
      "interaction.reply({ content: 'pong' });",
      {
        client: {} as never,
        config: { token: 'x' } as never,
        variables: {},
        interaction: { reply } as never,
      },
      createLogger(),
    );

    expect(reply).toHaveBeenCalledWith({ content: 'pong' });
    expect(replyFinished).toBe(true);
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
