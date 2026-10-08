import { describe, expect, it, mock, spyOn, vi } from 'bun:test';

import { resolveScriptMember } from '../src/discord/handler-registry.js';

describe('resolveScriptMember', () => {
  it('returns the existing member without fetching', async () => {
    const existing = { id: 'member-1' };
    const fetch = vi.fn();
    const message = {
      author: { id: 'user-1' },
      guild: { members: { fetch } },
      member: null,
    };

    const result = await resolveScriptMember(message as never, existing as never);

    expect(result).toBe(existing);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fetches the guild member when message.member is null', async () => {
    const fetched = { id: 'member-2', user: { id: 'user-1' } };
    const fetch = vi.fn(async () => fetched);
    const message = {
      author: { id: 'user-1' },
      guild: { members: { fetch } },
      member: null,
    };

    const result = await resolveScriptMember(message as never, null);

    expect(result).toBe(fetched);
    expect(fetch).toHaveBeenCalledWith('user-1');
  });

  it('returns null when fetch fails', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('Missing Access');
    });
    const message = {
      author: { id: 'user-1' },
      guild: { members: { fetch } },
      member: null,
    };

    const result = await resolveScriptMember(message as never, null);

    expect(result).toBeNull();
  });

  it('returns null when there is no guild', async () => {
    const message = {
      author: { id: 'user-1' },
      guild: null,
      member: null,
    };

    const result = await resolveScriptMember(message as never, null);

    expect(result).toBeNull();
  });
});

describe('upgradeInteractionMember', () => {
  it('replaces a raw API member by a fetched GuildMember', async () => {
    const real = { roles: { add: () => undefined } };
    const interaction = {
      guildId: 'g',
      guild: { members: { fetch: async () => real } },
      user: { id: 'u' },
    };
    const { upgradeInteractionMember } = await import('../src/discord/handler-registry.js');
    const raw = { roles: ['1'] };
    const result = await upgradeInteractionMember({} as never, interaction as never, raw);
    expect(result).toBe(real);
  });
  it('keeps a member that already has roles.add, and falls back on failure', async () => {
    const { upgradeInteractionMember } = await import('../src/discord/handler-registry.js');
    const ok = { roles: { add: () => undefined } };
    expect(await upgradeInteractionMember({} as never, { guildId: 'g' } as never, ok)).toBe(ok);
    const raw = { roles: ['1'] };
    const failing = {
      guildId: 'g',
      guild: { members: { fetch: async () => { throw new Error('x'); } } },
      user: { id: 'u' },
    };
    expect(await upgradeInteractionMember({} as never, failing as never, raw)).toBe(raw);
  });
});

describe('describeScriptSource', () => {
  it('names the command, webhook or fallback that triggered a script', async () => {
    const { describeScriptSource } = await import('../src/discord/handler-registry.js');
    expect(describeScriptSource({ interaction: { commandName: 'ping' } as never })).toBe('command /ping');
    expect(describeScriptSource({ webhook: { path: '/h' } })).toBe('inbound webhook /h');
    expect(describeScriptSource({})).toBe('event or scheduled handler');
  });
});
