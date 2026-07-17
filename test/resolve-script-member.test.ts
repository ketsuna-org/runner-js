import { describe, expect, it, vi } from 'vitest';

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
