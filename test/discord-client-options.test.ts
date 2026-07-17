import { describe, expect, it } from 'vitest';
import { buildDiscordClientOptions } from '../src/discord/discord-client-options.js';
import { GatewayIntentBits, GuildMemberManager } from 'discord.js';

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
    };
    const withCache = withMembers.makeCache!(GuildMemberManager, null as never, manager as never) as {
      maxSize?: number;
    };
    expect(withoutCache.maxSize).toBe(25);
    expect(withCache.maxSize).toBe(25);
  });
});
