import { describe, expect, it, vi } from 'vitest';

import { ScriptExecutor } from '../src/scripts/script-executor.js';
import { isolatedVmAvailable } from './helpers/isolated-vm-available.js';

describe.skipIf(!isolatedVmAvailable)('ScriptExecutor', () => {
  it('executes async user script with injected context', async () => {
    const executor = new ScriptExecutor(5000, { sandboxed: true });
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

  it('recycles the isolate after max executions and keeps working', async () => {
    const executor = new ScriptExecutor(5000, {
      sandboxed: true,
      isolateMaxExecutions: 2,
      isolateMaxAgeMs: 0,
    });
    const logger = createLogger();

    await executor.execute(
      'return 1;',
      { client: {} as never, config: { token: 'x' } as never, variables: {} },
      logger,
    );
    await executor.execute(
      'return 2;',
      { client: {} as never, config: { token: 'x' } as never, variables: {} },
      logger,
    );

    const third = await executor.execute(
      'return 3;',
      { client: {} as never, config: { token: 'x' } as never, variables: {} },
      logger,
    );

    expect(third).toBe(3);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringMatching(/Recycled isolate after 2 executions/),
    );
    executor.dispose();
  });

  it('nulls runtime on dispose so a later execute recreates the isolate', async () => {
    const executor = new ScriptExecutor(5000, { sandboxed: true });
    const logger = createLogger();

    await executor.execute(
      'return 1;',
      { client: {} as never, config: { token: 'x' } as never, variables: {} },
      logger,
    );
    executor.dispose();

    const result = await executor.execute(
      'return 2;',
      { client: {} as never, config: { token: 'x' } as never, variables: {} },
      logger,
    );
    expect(result).toBe(2);
    executor.dispose();
  });

  it('times out long running scripts', async () => {
    const executor = new ScriptExecutor(50, { sandboxed: true });

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
    const executor = new ScriptExecutor(5000, { sandboxed: true });

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
    const executor = new ScriptExecutor(5000, { sandboxed: true });

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

  it('exposes crypto and util modules in sandbox', async () => {
    const executor = new ScriptExecutor(5000, { sandboxed: true });

    const result = await executor.execute(
      `
        const crypto = require('node:crypto');
        const util = require('util');
        const uuid = crypto.randomUUID();
        const inspected = util.inspect({ a: 1 });
        return { uuidLength: uuid.length, inspected };
      `,
      {
        client: {} as never,
        config: { token: 'x' } as never,
        variables: {},
      },
      createLogger(),
    ) as { uuidLength?: number; inspected?: string };

    expect(result.uuidLength).toBe(36);
    expect(result.inspected).toContain('a: 1');

    executor.dispose();
  });

  it('exposes discord.js builders but blocks Client in sandbox', async () => {
    const executor = new ScriptExecutor(5000, { sandboxed: true });

    const builderResult = await executor.execute(
      `
        const { EmbedBuilder } = require('discord.js');
        const embed = new EmbedBuilder().setTitle('hello');
        return embed.toJSON();
      `,
      {
        client: {} as never,
        config: { token: 'x' } as never,
        variables: {},
      },
      createLogger(),
    ) as { title?: string };

    expect(builderResult.title).toBe('hello');

    const chainedBuilderResult = await executor.execute(
      `
        const { EmbedBuilder } = require('discord.js');
        const embed = new EmbedBuilder()
          .setTitle('Stats')
          .setColor(0x5865f2)
          .addFields({ name: 'Coins', value: '100', inline: true });
        return embed.toJSON();
      `,
      {
        client: {} as never,
        config: { token: 'x' } as never,
        variables: {},
      },
      createLogger(),
    ) as { title?: string; fields?: Array<{ name: string; value: string }> };

    expect(chainedBuilderResult.title).toBe('Stats');
    expect(chainedBuilderResult.fields?.[0]?.name).toBe('Coins');
    expect(chainedBuilderResult.fields?.[0]?.value).toBe('100');

    await expect(
      executor.execute(
        `
          const { Client } = require('discord.js');
          Client();
        `,
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

  it('exposes url module in sandbox', async () => {
    const executor = new ScriptExecutor(5000, { sandboxed: true });

    const result = await executor.execute(
      `
        const { URL } = require('node:url');
        const parsed = new URL('https://example.com/path?q=1');
        return parsed.hostname;
      `,
      {
        client: {} as never,
        config: { token: 'x' } as never,
        variables: {},
      },
      createLogger(),
    );

    expect(result).toBe('example.com');

    executor.dispose();
  });

  it('does not expose process to user scripts', async () => {
    const executor = new ScriptExecutor(5000, { sandboxed: true });

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
    const executor = new ScriptExecutor(5000, { sandboxed: true });

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
    const executor = new ScriptExecutor(5000, { sandboxed: true });
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
    const executor = new ScriptExecutor(5000, { sandboxed: true });
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
    const executor = new ScriptExecutor(5000, { sandboxed: true });
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
    const executor = new ScriptExecutor(5000, { sandboxed: true });
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

  it('runs concurrent script executions on the same isolate in parallel', async () => {
    const executor = new ScriptExecutor(5000, { sandboxed: true });
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
    expect(order).toEqual(['second', 'first']);
    executor.dispose();
  });

  it('runs setTimeout callbacks before releasing the host bridge', async () => {
    const executor = new ScriptExecutor(5000, { sandboxed: true });
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
    const executor = new ScriptExecutor(5000, { sandboxed: true });
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
    const executor = new ScriptExecutor(5000, { sandboxed: true });
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
    const executor = new ScriptExecutor(5000, { sandboxed: true });
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

  it('allows String() coercion on host reply objects in eval handlers', async () => {
    const executor = new ScriptExecutor(5000, { sandboxed: true });
    const reply = vi.fn(async (payload: string) => ({ content: payload, id: '123' }));

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
          content: '!eval await message.reply("ok")',
          reply,
        } as never,
      },
      createLogger(),
    );

    expect(reply).toHaveBeenCalledTimes(2);
    expect(String(reply.mock.calls[1]?.[0])).not.toBe('undefined');
    executor.dispose();
  });

  it('supports return inside eval content', async () => {
    const executor = new ScriptExecutor(5000, { sandboxed: true });
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
    const executor = new ScriptExecutor(5000, { sandboxed: true });
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
    const executor = new ScriptExecutor(50, { sandboxed: true });

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
    const executor = new ScriptExecutor(5000, { sandboxed: true });
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

  it('blocks local filesystem paths in voice and canvas modules', async () => {
    const executor = new ScriptExecutor(5000, { sandboxed: true });

    const result = await executor.execute(
      `
        const checks = {};

        try {
          const voice = require('@discordjs/voice');
          try {
            voice.createAudioResource('/etc/passwd');
            checks.audio = 'allowed';
          } catch (err) {
            checks.audio = err.message;
          }
        } catch {
          checks.audio = 'voice-unavailable';
        }

        try {
          const canvas = require('canvas');
          try {
            canvas.registerFont('/etc/passwd', { family: 'x' });
            checks.font = 'allowed';
          } catch (err) {
            checks.font = err.message;
          }
          try {
            canvas.loadImage('/etc/passwd');
            checks.image = 'allowed';
          } catch (err) {
            checks.image = err.message;
          }
          try {
            canvas.loadImage('/app/package.json');
            checks.appPackage = 'allowed';
          } catch (err) {
            checks.appPackage = err.message;
          }
        } catch {
          checks.font = 'canvas-unavailable';
          checks.image = 'canvas-unavailable';
          checks.appPackage = 'canvas-unavailable';
        }

        return checks;
      `,
      {
        client: {} as never,
        config: { token: 'x' } as never,
        variables: {},
      },
      createLogger(),
    ) as { audio?: string; font?: string; image?: string; appPackage?: string };

    if (result.audio !== 'voice-unavailable') {
      expect(result.audio).toMatch(/local file paths are blocked/i);
    }
    if (result.font !== 'canvas-unavailable') {
      expect(result.font).toMatch(/local file paths are blocked/i);
      expect(result.image).toMatch(/local file paths are blocked/i);
      expect(result.appPackage).toMatch(/local file paths are blocked/i);
    }
    executor.dispose();
  });

  it('fetches remote audio URLs before creating a voice resource', async () => {
    const executor = new ScriptExecutor(5000, { sandboxed: true });
    const mp3Bytes = Buffer.from([
      0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        arrayBuffer: async () => mp3Bytes.buffer.slice(
          mp3Bytes.byteOffset,
          mp3Bytes.byteOffset + mp3Bytes.byteLength,
        ),
      })),
    );

    const result = await executor.execute(
      `
        try {
          const voice = require('@discordjs/voice');
          if (typeof voice.createAudioResource !== 'function') {
            return { skipped: true };
          }
          const resource = await voice.createAudioResource('https://example.com/test.mp3');
          return {
            ok: true,
            resourceType: typeof resource,
          };
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
    ) as { skipped?: boolean; ok?: boolean; error?: string; resourceType?: string };

    vi.unstubAllGlobals();
    if (result.skipped) {
      executor.dispose();
      return;
    }

    expect(result.error ?? '').not.toMatch(/could not be cloned/i);
    expect(result.ok).toBe(true);
    expect(result.resourceType).toBe('object');
    executor.dispose();
  });

  it('exposes playAudio on the voice module', async () => {
    const executor = new ScriptExecutor(5000, { sandboxed: true });

    const result = await executor.execute(
      `
        try {
          const voice = require('@discordjs/voice');
          return {
            skipped: typeof voice.joinVoiceChannel !== 'function',
            playAudio: typeof voice.playAudio,
          };
        } catch {
          return { skipped: true };
        }
      `,
      {
        client: {} as never,
        config: { token: 'x' } as never,
        variables: {},
      },
      createLogger(),
    ) as { skipped?: boolean; playAudio?: string };

    if (result.skipped) {
      executor.dispose();
      return;
    }

    expect(result.playAudio).toBe('function');
    executor.dispose();
  });

  it('rejects player.play when createAudioResource was not awaited', async () => {
    const executor = new ScriptExecutor(5000, { sandboxed: true });
    const mp3Bytes = Buffer.from([
      0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        arrayBuffer: async () => mp3Bytes.buffer.slice(
          mp3Bytes.byteOffset,
          mp3Bytes.byteOffset + mp3Bytes.byteLength,
        ),
      })),
    );

    const result = await executor.execute(
      `
        try {
          const voice = require('@discordjs/voice');
          if (typeof voice.createAudioPlayer !== 'function') {
            return { skipped: true };
          }
          const player = voice.createAudioPlayer();
          const resource = voice.createAudioResource('https://example.com/test.mp3');
          player.play(resource);
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

    vi.unstubAllGlobals();
    if (result.skipped) {
      executor.dispose();
      return;
    }

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/await createAudioResource/i);
    executor.dispose();
  });

  it('registers isolate callbacks on voice player event listeners', async () => {
    const executor = new ScriptExecutor(5000, { sandboxed: true });

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
    const executor = new ScriptExecutor(5000, { sandboxed: true });
    const adapterCreator = vi.fn(() => ({ sendPayload: vi.fn(), destroy: vi.fn() }));

    const result = await executor.execute(
      `
        try {
          const voice = require('@discordjs/voice');
          if (typeof voice.joinVoiceChannel !== 'function') {
            return { skipped: true };
          }
          // Touch the adapter creator through the bridge (same path join uses).
          const creator = guild.voiceAdapterCreator;
          return {
            ok: typeof creator === 'function' && typeof voice.joinVoiceChannelReady === 'function',
            joinIsAsync: voice.joinVoiceChannel.length >= 1,
          };
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
    expect(result.ok).toBe(true);
    executor.dispose();
  });

  it('exposes synchronous voice player methods', async () => {
    const executor = new ScriptExecutor(5000, { sandboxed: true });

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
    const executor = new ScriptExecutor(5000, { sandboxed: true });
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
    const executor = new ScriptExecutor(5000, { sandboxed: true });
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
    const executor = new ScriptExecutor(5000, { sandboxed: true });
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
    const executor = new ScriptExecutor(5000, { sandboxed: true });
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

  it('blocks local file paths in Discord send attachments', async () => {
    const executor = new ScriptExecutor(5000, { sandboxed: true });
    const send = vi.fn(async () => ({ ok: true }));

    await expect(
      executor.execute(
        "await channel.send({ files: ['/app/package.json'] });",
        {
          client: {} as never,
          config: { token: 'x' } as never,
          variables: {},
          channel: { send } as never,
        },
        createLogger(),
      ),
    ).rejects.toThrow(/local file paths are blocked/i);

    expect(send).not.toHaveBeenCalled();
    executor.dispose();
  });

  it('calls host bridged methods such as interaction.reply', async () => {
    const executor = new ScriptExecutor(5000, { sandboxed: true });
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

  it('propagates sandbox listener return values for message component filters', async () => {
    const executor = new ScriptExecutor(5000, { sandboxed: true });
    const awaitMessageComponent = createCollectorMock(
      { customId: 'confirm', user: { id: 'user-42' } },
      'Collector received no interactions after the allowed time.',
    );

    const result = await executor.execute(
      `
        const btn = await message.awaitMessageComponent({
          filter: (i) => i.customId === 'confirm' && i.user.id === 'user-42',
          time: 5000,
        });
        return btn.customId;
      `,
      {
        client: {} as never,
        config: { token: 'x' } as never,
        variables: {},
        message: { awaitMessageComponent } as never,
      },
      createLogger(),
    );

    expect(result).toBe('confirm');
    expect(awaitMessageComponent).toHaveBeenCalled();
    executor.dispose();
  });

  it('rejects message component collection when sandbox filter returns false', async () => {
    const executor = new ScriptExecutor(5000, { sandboxed: true });
    const awaitMessageComponent = createCollectorMock(
      { customId: 'confirm', user: { id: 'user-42' } },
      'Collector received no interactions after the allowed time.',
    );

    await expect(
      executor.execute(
        `
          await message.awaitMessageComponent({
            filter: (i) => i.user.id === 'someone-else',
            time: 5000,
          });
        `,
        {
          client: {} as never,
          config: { token: 'x' } as never,
          variables: {},
          message: { awaitMessageComponent } as never,
        },
        createLogger(),
      ),
    ).rejects.toThrow(/Collector received no interactions/i);

    executor.dispose();
  });

  it('propagates sandbox listener return values for reaction collectors', async () => {
    const executor = new ScriptExecutor(5000, { sandboxed: true });
    const awaitReaction = createCollectorMock(
      { emoji: { name: '✅' }, users: { cache: { has: (id: string) => id === 'user-42' } } },
      'Collector received no reactions after the allowed time.',
    );

    const result = await executor.execute(
      `
        const reaction = await message.awaitReaction({
          filter: (r, user) => r.emoji.name === '✅' && user.id === 'user-42',
          time: 5000,
        });
        return reaction.emoji.name;
      `,
      {
        client: {} as never,
        config: { token: 'x' } as never,
        variables: {},
        message: { awaitReaction } as never,
      },
      createLogger(),
    );

    expect(result).toBe('✅');
    expect(awaitReaction).toHaveBeenCalled();
    executor.dispose();
  });

  it('propagates sandbox listener return values for message collectors', async () => {
    const executor = new ScriptExecutor(5000, { sandboxed: true });
    const candidate = { content: 'hello world', author: { id: 'user-42' } };
    const awaitMessages = createCollectorMock(
      candidate,
      'Collector received no messages after the allowed time.',
      {
        resolveValue: {
          first: () => candidate,
          size: 1,
        },
      },
    );

    const result = await executor.execute(
      `
        const collected = await channel.awaitMessages({
          filter: (m) => m.content.includes('hello') && m.author.id === 'user-42',
          max: 1,
          time: 5000,
        });
        return collected.first().content;
      `,
      {
        client: {} as never,
        config: { token: 'x' } as never,
        variables: {},
        channel: { awaitMessages } as never,
      },
      createLogger(),
    );

    expect(result).toBe('hello world');
    expect(awaitMessages).toHaveBeenCalled();
    executor.dispose();
  });

  it('awaits nested host: methods such as guild.members.fetch', async () => {
    const executor = new ScriptExecutor(5000, { sandboxed: true });
    const fetch = vi.fn(async (id: string) => ({
      id,
      user: { username: 'garder500' },
      voice: { channelId: 'voice-1' },
    }));
    const guild = {
      members: { fetch },
    };

    const result = await executor.execute(
      `
        const member = await guild.members.fetch('user-42');
        return {
          username: member.user.username,
          channelId: member.voice.channelId,
        };
      `,
      {
        client: {} as never,
        config: { token: 'x' } as never,
        variables: {},
        guild: guild as never,
      },
      createLogger(),
    ) as { username?: string; channelId?: string };

    expect(result.username).toBe('garder500');
    expect(result.channelId).toBe('voice-1');
    expect(fetch).toHaveBeenCalledWith('user-42');
    executor.dispose();
  });

  it('awaits nested host: methods such as message.channel.send', async () => {
    const executor = new ScriptExecutor(5000, { sandboxed: true });
    const send = vi.fn(async (content: string) => ({ id: 'msg-1', content }));
    const message = {
      channel: { send },
    };

    const result = await executor.execute(
      `
        const sent = await message.channel.send('hello');
        return sent.content;
      `,
      {
        client: {} as never,
        config: { token: 'x' } as never,
        variables: {},
        message: message as never,
      },
      createLogger(),
    );

    expect(result).toBe('hello');
    expect(send).toHaveBeenCalledWith('hello');
    executor.dispose();
  });
});

function createCollectorMock<T>(
  candidate: T,
  timeoutMessage: string,
  options?: { resolveValue?: unknown },
): ReturnType<typeof vi.fn> {
  return vi.fn((collectorOptions?: { filter?: (...args: unknown[]) => boolean }) =>
    new Promise((resolve, reject) => {
      setTimeout(() => {
        if (!collectorOptions?.filter) {
          resolve(options?.resolveValue ?? candidate);
          return;
        }

        const args =
          candidate != null && typeof candidate === 'object' && 'users' in (candidate as object)
            ? [candidate, { id: 'user-42' }]
            : [candidate];

        if (collectorOptions.filter(...args)) {
          resolve(options?.resolveValue ?? candidate);
          return;
        }

        reject(new Error(timeoutMessage));
      }, 10);
    }),
  );
}

function createLogger() {
  return {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}
