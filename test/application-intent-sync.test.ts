import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';

import {
  buildEffectiveIntentsMap,
  buildSafeFallbackIntentsMap,
  clearLastKnownPortalIntents,
  describePortalSyncFailure,
  fetchPortalEnabledPrivilegedIntents,
  getLastKnownPortalIntents,
  rememberPortalIntents,
} from '../src/discord/application-intent-sync.js';
import { DiscordTokenUnauthorizedError } from '../src/discord/discord-auth-errors.js';
import type { JsBotConfig } from '../src/config/js-bot-config.js';

// Bits « limited » selon la doc Discord (bot non vérifié, intent activé au portail).
const PRESENCE_LIMITED = 1 << 13;
const MEMBERS_LIMITED = 1 << 15;
const MESSAGE_CONTENT_LIMITED = 1 << 19;

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

describe('portal sync resilience', () => {
  const originalFetch = globalThis.fetch;
  const SECRET = 'SECRET-TOKEN-abc123';
  const noSleep = { sleep: async () => {} };

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearLastKnownPortalIntents();
  });

  function mockSequence(responses: Array<() => Response | Promise<Response>>) {
    let i = 0;
    const fn = vi.fn(async () => {
      const r = responses[Math.min(i, responses.length - 1)]!;
      i++;
      return r();
    });
    globalThis.fetch = fn as unknown as typeof fetch;
    return fn;
  }

  it('retries a 429 honouring Retry-After then succeeds', async () => {
    const waits: number[] = [];
    const fn = mockSequence([
      () => new Response('{}', { status: 429, headers: { 'Retry-After': '2' } }),
      () => new Response(JSON.stringify({ flags: MESSAGE_CONTENT_LIMITED }), { status: 200 }),
    ]);

    const result = await fetchPortalEnabledPrivilegedIntents('token', {
      sleep: async (ms) => {
        waits.push(ms);
      },
    });

    expect(fn).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([2000]);
    expect(result.enabled).toEqual(new Set(['Message Content']));
  });

  it('retries 5xx and network errors', async () => {
    const fn = mockSequence([
      () => new Response('', { status: 502 }),
      () => {
        throw new TypeError('fetch failed');
      },
      () => new Response(JSON.stringify({ flags: PRESENCE_LIMITED }), { status: 200 }),
    ]);

    const result = await fetchPortalEnabledPrivilegedIntents('token', noSleep);

    expect(fn).toHaveBeenCalledTimes(3);
    expect(result.enabled).toEqual(new Set(['Guild Presence']));
  });

  it('gives up on a persistent 429 and exposes the cause', async () => {
    const fn = mockSequence([
      () => new Response('{}', { status: 429, headers: { 'Retry-After': '1' } }),
    ]);

    let caught: unknown;
    try {
      await fetchPortalEnabledPrivilegedIntents('token', noSleep);
    } catch (error) {
      caught = error;
    }

    expect(fn.mock.calls.length).toBeGreaterThan(1);
    expect(describePortalSyncFailure(caught)).toBe('HTTP 429, retry after 1s');
  });

  it('stays inside the global budget', async () => {
    let clock = 0;
    mockSequence([
      () => new Response('{}', { status: 429, headers: { 'Retry-After': '5' } }),
    ]);

    let caught: unknown;
    try {
      await fetchPortalEnabledPrivilegedIntents('token', {
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
        totalBudgetMs: 15_000,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeDefined();
    expect(clock).toBeLessThanOrEqual(15_000);
  });

  it.each([401, 403])('does not retry on %i', async (status) => {
    const fn = mockSequence([() => new Response('nope', { status })]);

    await expect(
      fetchPortalEnabledPrivilegedIntents('token', noSleep),
    ).rejects.toBeInstanceOf(DiscordTokenUnauthorizedError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('detects limited-only flags for all three privileged intents', async () => {
    mockSequence([
      () =>
        new Response(
          JSON.stringify({
            flags: PRESENCE_LIMITED | MEMBERS_LIMITED | MESSAGE_CONTENT_LIMITED,
          }),
          { status: 200 },
        ),
    ]);

    const result = await fetchPortalEnabledPrivilegedIntents('token', noSleep);
    expect(result.enabled).toEqual(
      new Set(['Guild Members', 'Guild Presence', 'Message Content']),
    );
  });

  it('falls back to the last known intents before disabling everything', () => {
    const config: JsBotConfig = {
      ...emptyConfig,
      events: [{ id: 'e1', name: 'messageCreate', script: 'return;' }],
    };
    rememberPortalIntents('bot-1', new Set(['Message Content']), new Date('2026-01-02T03:04:05Z'));
    const lastKnown = getLastKnownPortalIntents('bot-1');
    const warnings: string[] = [];

    const effective = buildSafeFallbackIntentsMap(config, warnings, {
      cause: 'HTTP 429, retry after 2s',
      lastKnown,
    });

    expect(effective['Message Content']).toBe(true);
    expect(warnings[0]).toContain('HTTP 429, retry after 2s');
    expect(warnings[0]).toContain('last known');
    expect(warnings[0]).toContain('2026-01-02T03:04:05.000Z');
    expect(getLastKnownPortalIntents('bot-2')).toBeUndefined();
  });

  it('without last known state keeps privileged intents off and logs the cause', () => {
    const config: JsBotConfig = {
      ...emptyConfig,
      events: [{ id: 'e1', name: 'messageCreate', script: 'return;' }],
    };
    const warnings: string[] = [];

    const effective = buildSafeFallbackIntentsMap(config, warnings, { cause: 'timeout' });

    expect(effective['Message Content']).toBe(false);
    expect(warnings[0]).toContain('(timeout)');
    expect(warnings[0]).toContain('privileged intents disabled');
  });

  it('never leaks the token in failure descriptions', async () => {
    mockSequence([
      () => {
        throw new TypeError(`fetch failed Bot ${SECRET}`);
      },
    ]);

    let caught: unknown;
    try {
      await fetchPortalEnabledPrivilegedIntents(SECRET, noSleep);
    } catch (error) {
      caught = error;
    }

    const description = describePortalSyncFailure(caught);
    expect(description).not.toContain(SECRET);
    expect((caught as Error).message).not.toContain(SECRET);
  });
});
