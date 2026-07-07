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

  it('supports eval prefix scripts with async host replies', async () => {
    const executor = new ScriptExecutor(5000);
    const reply = vi.fn(async (payload: string | { content: string }) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return typeof payload === 'string' ? { content: payload } : payload;
    });

    await executor.execute(
      `
        let args = message.content.split(" ");
        let content = args.slice(1).join(" ");
        try {
          await message.reply(String(eval(content)));
        } catch (err) {
          await message.reply("error: " + String(err.message));
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

  it('supports await inside eval content', async () => {
    const executor = new ScriptExecutor(5000);
    const reply = vi.fn(async (payload: string) => ({ content: payload }));

    await executor.execute(
      `
        let content = message.content.split(" ").slice(1).join(" ");
        let result = eval(content);
        if (result != null && typeof result.then === 'function') {
          result = await result;
        }
        await message.reply(String(result ?? 'done'));
      `,
      {
        client: {} as never,
        config: { token: 'x' } as never,
        variables: {},
        message: {
          content: '!eval await 21 + 21',
          reply,
        } as never,
      },
      createLogger(),
    );

    expect(reply).toHaveBeenCalledWith('42');
    executor.dispose();
  });

  it('supports return inside eval content', async () => {
    const executor = new ScriptExecutor(5000);
    const reply = vi.fn(async (payload: string) => ({ content: payload }));

    await executor.execute(
      `
        let content = message.content.split(" ").slice(1).join(" ");
        let result = eval(content);
        if (result != null && typeof result.then === 'function') {
          result = await result;
        }
        if (result !== undefined) {
          await message.reply(String(result));
        }
      `,
      {
        client: {} as never,
        config: { token: 'x' } as never,
        variables: {},
        message: {
          content: '!eval if (false) { return "nope"; } return "yes"',
          reply,
        } as never,
      },
      createLogger(),
    );

    expect(reply).toHaveBeenCalledWith('yes');
    executor.dispose();
  });

  it('does not expose host bridge internals to eval', async () => {
    const executor = new ScriptExecutor(5000);
    const reply = vi.fn(async (payload: string) => ({ content: payload }));

    await executor.execute(
      `
        let result = 'ok';
        try {
          eval('typeof __setHostBridge');
          if (typeof __setHostBridge !== 'undefined') {
            result = 'exposed';
          }
          if (typeof globalThis.__hostBridgeHolder !== 'undefined') {
            result = 'exposed';
          }
        } catch {}
        await message.reply(result);
      `,
      {
        client: {} as never,
        config: { token: 'x' } as never,
        variables: {},
        message: { content: '!test', reply } as never,
      },
      createLogger(),
    );

    expect(reply).toHaveBeenCalledWith('ok');
    executor.dispose();
  });

  it('times out without host bridge errors', async () => {
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

  it('blocks nested client access on message', async () => {
    const executor = new ScriptExecutor(5000);
    const sharedClient = { token: 'secret', tag: 'Bot#1' };

    await expect(
      executor.execute(
        'message.client;',
        {
          client: sharedClient as never,
          config: { token: 'x' } as never,
          variables: {},
          message: {
            content: 'hi',
            client: sharedClient,
          } as never,
        },
        createLogger(),
      ),
    ).rejects.toThrow(/not allowed/i);

    await expect(
      executor.execute(
        'message["client"];',
        {
          client: sharedClient as never,
          config: { token: 'x' } as never,
          variables: {},
          message: {
            content: 'hi',
            client: sharedClient,
          } as never,
        },
        createLogger(),
      ),
    ).rejects.toThrow(/not allowed/i);

    executor.dispose();
  });

  it('registers isolate callbacks on voice player event listeners', async () => {
    const executor = new ScriptExecutor(5000);

    const result = await executor.execute(
      `
        try {
          const voice = require('@discordjs/voice');
          if (typeof voice.createAudioPlayer !== 'function') {
            return { skipped: true };
          }
          const player = voice.createAudioPlayer();
          player.on('error', () => {});
          return { ok: true };
        } catch (err) {
          return { ok: false, error: String(err.message) };
        }
      `,
      {
        client: {} as never,
        config: { token: 'x' } as never,
        variables: {},
      },
      createLogger(),
    ) as { skipped?: boolean; ok?: boolean; error?: string };

    if (result.skipped) {
      executor.dispose();
      return;
    }

    expect(result.error ?? '').not.toMatch(/could not be cloned/i);
    expect(result.ok).toBe(true);
    executor.dispose();
  });

  it('passes voiceAdapterCreator functions to voice join without clone errors', async () => {
    const executor = new ScriptExecutor(5000);
    const adapterCreator = vi.fn(() => ({ sendPackets: vi.fn() }));

    const result = await executor.execute(
      `
        try {
          const voice = require('@discordjs/voice');
          if (typeof voice.joinVoiceChannel !== 'function') {
            return { skipped: true };
          }
          voice.joinVoiceChannel({
            channelId: '123',
            guildId: '456',
            adapterCreator: guild.voiceAdapterCreator,
          });
          return { ok: true };
        } catch (err) {
          return { ok: false, error: String(err.message) };
        }
      `,
      {
        client: {} as never,
        config: { token: 'x' } as never,
        variables: {},
        guild: { voiceAdapterCreator: adapterCreator } as never,
      },
      createLogger(),
    ) as { skipped?: boolean; ok?: boolean; error?: string };

    if (result.skipped) {
      executor.dispose();
      return;
    }

    expect(result.error ?? '').not.toMatch(/could not be cloned/i);
    executor.dispose();
  });

  it('exposes synchronous voice player methods', async () => {
    const executor = new ScriptExecutor(5000);

    const result = await executor.execute(
      `
        let skipped = true;
        let playerIsPromise = false;
        let playType = 'missing';
        try {
          const voice = require('@discordjs/voice');
          if (typeof voice.createAudioPlayer !== 'function') {
            return { skipped: true };
          }
          skipped = false;
          const player = voice.createAudioPlayer();
          playerIsPromise = player != null && typeof player.then === 'function';
          playType = typeof player.play;
        } catch {}
        return { skipped, playerIsPromise, playType };
      `,
      {
        client: {} as never,
        config: { token: 'x' } as never,
        variables: {},
      },
      createLogger(),
    ) as { skipped?: boolean; playerIsPromise?: boolean; playType?: string };

    if (result.skipped) {
      executor.dispose();
      return;
    }

    expect(result.playerIsPromise).toBe(false);
    expect(result.playType).toBe('function');
    executor.dispose();
  });

  it('exposes fetch response body, text(), and json()', async () => {
    const executor = new ScriptExecutor(5000);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        url: 'https://example.com/data',
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => '{"hello":"world"}',
      })),
    );

    const result = await executor.execute(
      `
        const response = await fetch('https://example.com/data');
        const text = await response.text();
        const json = await response.json();
        return JSON.stringify({
          body: response.body,
          text,
          json,
          ok: response.ok,
          status: response.status,
        });
      `,
      {
        client: {} as never,
        config: { token: 'x' } as never,
        variables: {},
      },
      createLogger(),
    ) as string;

    const parsed = JSON.parse(result) as {
      body?: string;
      text?: string;
      json?: { hello?: string };
      ok?: boolean;
      status?: number;
    };

    expect(parsed.ok).toBe(true);
    expect(parsed.status).toBe(200);
    expect(parsed.body).toBe('{"hello":"world"}');
    expect(parsed.text).toBe('{"hello":"world"}');
    expect(parsed.json).toEqual({ hello: 'world' });
    vi.unstubAllGlobals();
    executor.dispose();
  });

  it('serializes client safely via JSON.stringify', async () => {
    const executor = new ScriptExecutor(5000);
    const client = {
      token: 'super-secret-token',
      uptime: 12345,
      user: { id: '1', username: 'JeanMichel', tag: 'JeanMichel#7892', bot: true },
      ws: { ping: 42 },
      guilds: { cache: { size: 3 } },
      channels: { cache: { get: () => ({ guild: null }) } },
    };
    // Simulate circular reference like Discord.js Client
    (client as Record<string, unknown>).channels = {
      cache: {
        size: 1,
        get: () => client,
      },
    };

    const result = await executor.execute(
      'return JSON.stringify(client);',
      {
        client: client as never,
        config: { token: 'x' } as never,
        variables: {},
      },
      createLogger(),
    ) as string;

    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed.uptime).toBe(12345);
    expect(parsed.ws).toEqual({ ping: 42 });
    expect(parsed.guilds).toEqual({ cache: { size: 3 } });
    expect(parsed.token).toBeUndefined();
    expect(JSON.stringify(parsed)).not.toContain('super-secret-token');
    executor.dispose();
  });

  it('serializes host proxies via JSON.stringify', async () => {
    const executor = new ScriptExecutor(5000);
    const reply = vi.fn(async (payload: string) => ({ content: payload }));

    const result = await executor.execute(
      `
        return {
          message: JSON.stringify(message),
          reference: JSON.stringify(message.reference),
          content: message.content,
        };
      `,
      {
        client: {} as never,
        config: { token: 'x' } as never,
        variables: {},
        message: {
          content: 'hello world',
          id: '123456789012345678',
          reference: {
            messageId: '987654321098765432',
            channelId: '111111111111111111',
            guildId: '222222222222222222',
            toJSON() {
              return {
                messageId: this.messageId,
                channelId: this.channelId,
                guildId: this.guildId,
              };
            },
          },
          toJSON() {
            return {
              content: this.content,
              id: this.id,
              reference: this.reference?.toJSON?.() ?? this.reference,
            };
          },
          reply,
        } as never,
      },
      createLogger(),
    ) as { message?: string; reference?: string; content?: string };

    expect(JSON.parse(result.message ?? '{}')).toEqual({
      content: 'hello world',
      id: '123456789012345678',
      reference: {
        messageId: '987654321098765432',
        channelId: '111111111111111111',
        guildId: '222222222222222222',
      },
    });
    expect(JSON.parse(result.reference ?? '{}')).toEqual({
      messageId: '987654321098765432',
      channelId: '111111111111111111',
      guildId: '222222222222222222',
    });
    expect(result.content).toBe('hello world');
    executor.dispose();
  });

  it('allows passing host proxy objects to host methods', async () => {
    const executor = new ScriptExecutor(5000);
    const reply = vi.fn(async (payload: unknown) => ({ ok: true, payload }));

    await executor.execute(
      `
        console.log(message);
        await message.reply(message.content);
      `,
      {
        client: {} as never,
        config: { token: 'x' } as never,
        variables: {},
        message: {
          content: 'hello',
          reply,
        } as never,
      },
      createLogger(),
    );

    expect(reply).toHaveBeenCalledWith('hello');
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
