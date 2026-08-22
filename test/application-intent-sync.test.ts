import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';

import {
  buildEffectiveIntentsMap,
  fetchPortalEnabledPrivilegedIntents,
} from '../src/discord/application-intent-sync.js';
import { DiscordTokenUnauthorizedError } from '../src/discord/discord-auth-errors.js';
import type { JsBotConfig } from '../src/config/js-bot-config.js';

const MEMBERS_LIMITED = 1 << 14;
const PRESENCE_LIMITED = 1 << 12;
const MESSAGE_CONTENT_LIMITED = 1 << 18;

const emptyConfig: JsBotConfig = {
  token: 'token',
  events: [],
  commands: [],
};

describe('fetchPortalEnabledPrivilegedIntents', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('reads portal flags without PATCHing', async () => {
    let patchCalled = false;

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith('/applications/@me') && init?.method !== 'PATCH') {
        return new Response(JSON.stringify({ flags: MEMBERS_LIMITED }), {
          status: 200,
        });
      }
      if (init?.method === 'PATCH') {
        patchCalled = true;
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    const result = await fetchPortalEnabledPrivilegedIntents('token');

    expect(patchCalled).toBe(false);
    expect(result.didAutoEnable).toBe(false);
    expect(result.enabled).toEqual(new Set(['Guild Members']));
  });

  it('returns all privileged intents when portal has them enabled', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith('/applications/@me') && init?.method !== 'PATCH') {
        return new Response(
          JSON.stringify({
            flags: MEMBERS_LIMITED | PRESENCE_LIMITED | MESSAGE_CONTENT_LIMITED,
          }),
          { status: 200 },
        );
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    const result = await fetchPortalEnabledPrivilegedIntents('token');

    expect(result.didAutoEnable).toBe(false);
    expect(result.enabled).toEqual(
      new Set(['Guild Members', 'Guild Presence', 'Message Content']),
    );
  });

  it('throws DiscordTokenUnauthorizedError on unauthorized application fetch', async () => {
    globalThis.fetch = vi.fn(async () => new Response('unauthorized', { status: 401 })) as typeof fetch;

    await expect(fetchPortalEnabledPrivilegedIntents('token')).rejects.toBeInstanceOf(
      DiscordTokenUnauthorizedError,
    );
  });
});

describe('buildEffectiveIntentsMap', () => {
  it('enables all non-privileged intents by default', () => {
    const effective = buildEffectiveIntentsMap(emptyConfig, new Set());

    expect(effective.Guilds).toBe(true);
    expect(effective['Guild Messages']).toBe(true);
    expect(effective['Guild Voice States']).toBe(true);
    expect(effective['Direct Messages']).toBe(true);
    expect(effective['Guild Message Reactions']).toBe(true);
    expect(effective['Message Content']).toBe(false);
    expect(effective['Guild Members']).toBe(false);
    expect(effective['Guild Presence']).toBe(false);
  });

  it('enables required non-privileged intents from events', () => {
    const config: JsBotConfig = {
      ...emptyConfig,
      events: [{ id: 'e1', name: 'messageCreate', script: 'return;' }],
    };

    const effective = buildEffectiveIntentsMap(config, new Set());

    expect(effective.Guilds).toBe(true);
    expect(effective['Guild Messages']).toBe(true);
    expect(effective['Direct Messages']).toBe(true);
    expect(effective['Message Content']).toBe(false);
  });

  it('enables privileged intents only when required and portal-approved', () => {
    const config: JsBotConfig = {
      ...emptyConfig,
      events: [{ id: 'e1', name: 'messageCreate', script: 'return;' }],
    };

    const effective = buildEffectiveIntentsMap(
      config,
      new Set(['Message Content']),
    );

    expect(effective['Message Content']).toBe(true);
  });
});
