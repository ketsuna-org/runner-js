import { afterEach, describe, expect, it, vi } from 'bun:test';
import { clearDiscordIpBlock } from '../src/discord/discord-auth-errors.js';
import {
  buildDiscordClientOptions,
  clientHasGuildVoiceStatesIntent,
  createGuardedMakeRequest,
} from '../src/discord/discord-client-options.js';
import {
  DISCORD_INVALID_REQUEST_WARNING_INTERVAL,
  type DiscordResponseInfo,
} from '../src/discord/rest-observability.js';
import { GatewayIntentBits, GuildMemberManager, PresenceManager, VoiceStateManager } from 'discord.js';

describe('buildDiscordClientOptions', () => {
  it('disables message and reaction caches by default', () => {
    const options = buildDiscordClientOptions({ Guilds: true });
    expect(options.makeCache).toBeDefined();
    expect(options.sweepers).toBeDefined();
  });

  it('includes guild members intent bit only when enabled in map', () => {
    const withMembers = buildDiscordClientOptions({ 'Guild Members': true });
    const withoutMembers = buildDiscordClientOptions({ 'Guild Members': false });
    const withBits = withMembers.intents?.[0] ?? 0;
    const withoutBits = withoutMembers.intents?.[0] ?? 0;
    expect(withBits & GatewayIntentBits.GuildMembers).not.toBe(0);
    expect(withoutBits & GatewayIntentBits.GuildMembers).toBe(0);
  });

  it('builds minimal cache options with sweepers configured', () => {
    const options = buildDiscordClientOptions({ Guilds: true });
    expect(options.makeCache).toBeTypeOf('function');
    expect(options.sweepers?.messages).toEqual({ interval: 300, lifetime: 300 });
    expect(options.sweepers?.threads).toEqual({ interval: 300, lifetime: 600 });
  });

  it('adds guild member sweeper when Guild Members intent is enabled', () => {
    const options = buildDiscordClientOptions({ 'Guild Members': true });
    expect(options.sweepers?.guildMembers).toBeDefined();
    expect(options.sweepers?.guildMembers).toMatchObject({ interval: 300 });
  });

  it('keeps a small GuildMemberManager cache without Guild Members intent', () => {
    const withoutMembers = buildDiscordClientOptions({ Guilds: true, 'Guild Members': false });
    const withMembers = buildDiscordClientOptions({ Guilds: true, 'Guild Members': true });

    expect(withoutMembers.sweepers?.guildMembers).toBeUndefined();
    expect(withMembers.sweepers?.guildMembers).toBeDefined();

    // makeCache(managerType, holds, manager) — manager.name selects the limit.
    const manager = { name: 'GuildMemberManager' };
    const withoutCache = withoutMembers.makeCache!(GuildMemberManager, null as never, manager as never) as {
      maxSize?: number;
      keepOverLimit?: (entry: { id: string }) => boolean;
    };
    const withCache = withMembers.makeCache!(GuildMemberManager, null as never, manager as never) as {
      maxSize?: number;
      keepOverLimit?: (entry: { id: string }) => boolean;
    };
    expect(withoutCache.maxSize).toBe(25);
    expect(withCache.maxSize).toBe(25);
    expect(typeof withoutCache.keepOverLimit).toBe('function');
  });

  it('keeps the bot voice state when Guild Voice States intent is enabled', () => {
    const options = buildDiscordClientOptions({
      Guilds: true,
      'Guild Voice States': true,
    });
    const manager = { name: 'VoiceStateManager' };
    const cache = options.makeCache!(VoiceStateManager, null as never, manager as never) as {
      maxSize?: number;
      keepOverLimit?: unknown;
    };
    expect(cache.maxSize).toBe(50);
    expect(typeof cache.keepOverLimit).toBe('function');
  });

  it('caches presences only when Guild Presence intent is enabled', () => {
    const manager = { name: 'PresenceManager' };
    const on = buildDiscordClientOptions({ Guilds: true, 'Guild Presence': true });
    const off = buildDiscordClientOptions({ Guilds: true });
    expect((on.makeCache!(PresenceManager, null as never, manager as never) as { maxSize?: number }).maxSize).toBe(200);
    expect((off.makeCache!(PresenceManager, null as never, manager as never) as { maxSize?: number }).maxSize).toBe(0);
  });

  it('detects Guild Voice States intent on client options', () => {
    const withVoice = buildDiscordClientOptions({
      Guilds: true,
      'Guild Voice States': true,
    });
    const withoutVoice = buildDiscordClientOptions({
      Guilds: true,
      'Guild Voice States': false,
    });

    const clientWith = { options: withVoice } as import('discord.js').Client;
    const clientWithout = { options: withoutVoice } as import('discord.js').Client;

    expect(clientHasGuildVoiceStatesIntent(clientWith)).toBe(true);
    expect(clientHasGuildVoiceStatesIntent(clientWithout)).toBe(false);
  });
});

describe('REST observability options', () => {
  it('asks discord.js for invalidRequestWarning events before the 10 000 invalid responses limit', () => {
    const options = buildDiscordClientOptions({ Guilds: true });
    expect(DISCORD_INVALID_REQUEST_WARNING_INTERVAL).toBe(250);
    expect(options.rest?.invalidRequestWarningInterval).toBe(DISCORD_INVALID_REQUEST_WARNING_INTERVAL);
    // Les valeurs explicites déjà en place ne bougent pas.
    expect(options.rest?.timeout).toBe(15_000);
    expect(options.rest?.retries).toBe(3);
  });
});

describe('createGuardedMakeRequest invalid response observer', () => {
  afterEach(() => clearDiscordIpBlock());

  const respond = (status: number, headers: Record<string, string> = {}, body = '{}') =>
    new Response(body, { status, headers });

  it.each([401, 403, 429])('reports a %i with the method, url and rate limit scope', async (status) => {
    const seen: DiscordResponseInfo[] = [];
    const guarded = createGuardedMakeRequest(
      (async () =>
        respond(status, { 'content-type': 'application/json', 'x-ratelimit-scope': 'user' })) as never,
      (info) => seen.push(info),
    );

    const response = await guarded('https://discord.com/api/v10/channels/1/messages', { method: 'POST' });

    expect(response.status).toBe(status);
    expect(seen).toEqual([
      {
        status,
        method: 'POST',
        url: 'https://discord.com/api/v10/channels/1/messages',
        scope: 'user',
      },
    ]);
  });

  it('stays silent on every other status', async () => {
    const seen: DiscordResponseInfo[] = [];
    for (const status of [200, 204, 404, 500]) {
      const guarded = createGuardedMakeRequest((async () => respond(status)) as never, (info) =>
        seen.push(info),
      );
      await guarded('https://discord.com/api/v10/users/@me', {});
    }
    expect(seen).toEqual([]);
  });

  it('still counts the 429 that turns out to be an IP block, before throwing', async () => {
    const seen: DiscordResponseInfo[] = [];
    const guarded = createGuardedMakeRequest(
      (async () =>
        respond(429, { 'content-type': 'text/html' }, 'You are being blocked from accessing our API')) as never,
      (info) => seen.push(info),
    );

    await expect(guarded('https://discord.com/api/v10/users/@me', {})).rejects.toThrow();
    expect(seen).toHaveLength(1);
    expect(seen[0].status).toBe(429);
  });

  it('never lets a failing observer break the request', async () => {
    const guarded = createGuardedMakeRequest(
      (async () => respond(403)) as never,
      vi.fn(() => {
        throw new Error('observer exploded');
      }),
    );
    const response = await guarded('https://discord.com/api/v10/users/@me', {});
    expect(response.status).toBe(403);
  });
});
