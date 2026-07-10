import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PortalIntentAutoEnableError,
  PortalIntentPatchFailedError,
  fetchPortalEnabledPrivilegedIntents,
} from '../src/discord/application-intent-sync.js';
import { DiscordTokenUnauthorizedError } from '../src/discord/discord-auth-errors.js';

const MEMBERS_LIMITED = 1 << 14;
const PRESENCE_LIMITED = 1 << 12;
const MESSAGE_CONTENT_LIMITED = 1 << 18;
const VERIFIED_BOT = 1 << 16;

describe('fetchPortalEnabledPrivilegedIntents', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not PATCH when all privileged intents are already enabled', async () => {
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = input.toString();
      if (url.endsWith('/applications/@me') && init?.method !== 'PATCH') {
        return new Response(
          JSON.stringify({
            flags: MEMBERS_LIMITED | PRESENCE_LIMITED | MESSAGE_CONTENT_LIMITED,
          }),
          { status: 200 },
        );
      }
      if (init?.method === 'PATCH') {
        throw new Error('PATCH should not be called');
      }
      return new Response('not found', { status: 404 });
    });

    const result = await fetchPortalEnabledPrivilegedIntents('token');

    expect(result.didAutoEnable).toBe(false);
    expect(result.enabled).toEqual(
      new Set(['Guild Members', 'Guild Presence', 'Message Content']),
    );
  });

  it('PATCHes only missing limited flags for unverified bots', async () => {
    let patchedFlags: number | undefined;

    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = input.toString();
      if (url.endsWith('/applications/@me') && init?.method !== 'PATCH') {
        return new Response(JSON.stringify({ flags: MEMBERS_LIMITED }), {
          status: 200,
        });
      }
      if (url.endsWith('/users/@me')) {
        return new Response(JSON.stringify({ flags: 0 }), { status: 200 });
      }
      if (url.endsWith('/applications/@me') && init?.method === 'PATCH') {
        patchedFlags = JSON.parse(String(init.body)).flags;
        return new Response(JSON.stringify({ flags: patchedFlags }), {
          status: 200,
        });
      }
      return new Response('not found', { status: 404 });
    });

    const result = await fetchPortalEnabledPrivilegedIntents('token');

    expect(patchedFlags).toBe(
      MEMBERS_LIMITED | PRESENCE_LIMITED | MESSAGE_CONTENT_LIMITED,
    );
    expect(result.didAutoEnable).toBe(true);
    expect(result.enabled).toEqual(
      new Set(['Guild Members', 'Guild Presence', 'Message Content']),
    );
  });

  it('throws PortalIntentAutoEnableError for verified bots', async () => {
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = input.toString();
      if (url.endsWith('/applications/@me') && init?.method !== 'PATCH') {
        return new Response(JSON.stringify({ flags: 0 }), { status: 200 });
      }
      if (url.endsWith('/users/@me')) {
        return new Response(JSON.stringify({ flags: VERIFIED_BOT }), {
          status: 200,
        });
      }
      if (init?.method === 'PATCH') {
        throw new Error('PATCH should not be called');
      }
      return new Response('not found', { status: 404 });
    });

    await expect(fetchPortalEnabledPrivilegedIntents('token')).rejects.toBeInstanceOf(
      PortalIntentAutoEnableError,
    );
  });

  it('throws PortalIntentPatchFailedError when PATCH fails', async () => {
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = input.toString();
      if (url.endsWith('/applications/@me') && init?.method !== 'PATCH') {
        return new Response(JSON.stringify({ flags: 0 }), { status: 200 });
      }
      if (url.endsWith('/users/@me')) {
        return new Response(JSON.stringify({ flags: 0 }), { status: 200 });
      }
      if (init?.method === 'PATCH') {
        return new Response('forbidden', { status: 403 });
      }
      return new Response('not found', { status: 404 });
    });

    await expect(fetchPortalEnabledPrivilegedIntents('token')).rejects.toBeInstanceOf(
      PortalIntentPatchFailedError,
    );
  });

  it('throws DiscordTokenUnauthorizedError on unauthorized application fetch', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('unauthorized', { status: 401 }));

    await expect(fetchPortalEnabledPrivilegedIntents('token')).rejects.toBeInstanceOf(
      DiscordTokenUnauthorizedError,
    );
  });
});
