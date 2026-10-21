import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';

import {
  buildEffectiveIntentsMap,
  buildSafeFallbackIntentsMap,
  clearLastKnownPortalIntents,
  describePortalSyncFailure,
  PortalFetchError,
  fetchPortalEnabledPrivilegedIntents,
  getLastKnownPortalIntents,
  rememberPortalIntents,
} from '../src/discord/application-intent-sync.js';
import {
  DiscordTokenUnauthorizedError,
  clearDiscordIpBlock,
  discordIpBlockRemainingMs,
} from '../src/discord/discord-auth-errors.js';
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
    clearDiscordIpBlock();
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

  it('gives up immediately when Retry-After exceeds the max wait', async () => {
    const fn = mockSequence([
      () => new Response('{}', { status: 429, headers: { 'Retry-After': '30' } }),
    ]);
    let caught: unknown;
    try {
      await fetchPortalEnabledPrivilegedIntents('token', noSleep);
    } catch (error) {
      caught = error;
    }
    expect(fn).toHaveBeenCalledTimes(1);
    expect(describePortalSyncFailure(caught)).toBe('HTTP 429, retry after 30s');
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
    expect(clock).toBeGreaterThan(0);
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

  const JSON_429 = { 'content-type': 'application/json' };

  async function failure(run: () => Promise<unknown>): Promise<unknown> {
    try {
      await run();
    } catch (error) {
      return error;
    }
    throw new Error('expected a failure');
  }

  it.each([
    [
      'blocked text',
      () =>
        new Response(
          'You are being blocked from accessing our API temporarily due to exceeding global rate limits.',
          { status: 429, headers: { 'content-type': 'text/plain', 'retry-after': '120' } },
        ),
    ],
    [
      'error code 1015',
      () =>
        new Response('error code: 1015', {
          status: 429,
          headers: { 'content-type': 'text/html', 'retry-after': '1' },
        }),
    ],
    [
      'non-JSON 429 without any x-ratelimit header',
      () => new Response('<html>denied</html>', { status: 429, headers: { 'content-type': 'text/html' } }),
    ],
  ])('IP block (%s): one request, no retry, platform hold armed', async (_name, response) => {
    const waits: number[] = [];
    const fn = mockSequence([response]);

    const caught = await failure(() =>
      fetchPortalEnabledPrivilegedIntents('token', { sleep: async (ms) => void waits.push(ms) }),
    );

    expect(fn).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
    expect(caught).toBeInstanceOf(PortalFetchError);
    expect((caught as PortalFetchError).kind).toBe('blocked');
    expect(describePortalSyncFailure(caught)).toContain('blocking requests');
    expect(discordIpBlockRemainingMs()).toBeGreaterThan(0);
  });

  it('IP block: the retry-after of the response drives the hold (default 60 s, capped at 600 s)', async () => {
    mockSequence([
      () => new Response('You are being blocked', { status: 429, headers: { 'retry-after': '120' } }),
    ]);
    const caught = (await failure(() => fetchPortalEnabledPrivilegedIntents('token', noSleep))) as PortalFetchError;
    expect(caught.retryAfterSeconds).toBe(120);
    expect(describePortalSyncFailure(caught)).toContain('retry after 120s');

    clearDiscordIpBlock();
    mockSequence([() => new Response('You are being blocked', { status: 429 })]);
    const noHeader = (await failure(() => fetchPortalEnabledPrivilegedIntents('token', noSleep))) as PortalFetchError;
    expect(noHeader.retryAfterSeconds).toBe(60);

    clearDiscordIpBlock();
    mockSequence([
      () => new Response('You are being blocked', { status: 429, headers: { 'retry-after': '99999' } }),
    ]);
    const capped = (await failure(() => fetchPortalEnabledPrivilegedIntents('token', noSleep))) as PortalFetchError;
    expect(capped.retryAfterSeconds).toBe(600);
  });

  it('sends no request at all while the IP block lasts', async () => {
    const fn = mockSequence([
      () => new Response('error code: 1015', { status: 429, headers: { 'content-type': 'text/html' } }),
    ]);
    await failure(() => fetchPortalEnabledPrivilegedIntents('token', noSleep));
    const caught = await failure(() => fetchPortalEnabledPrivilegedIntents('other-token', noSleep));

    expect(fn).toHaveBeenCalledTimes(1);
    expect((caught as PortalFetchError).kind).toBe('blocked');
  });

  it('per-token global 429 keeps a bounded backoff and never arms the platform hold', async () => {
    const waits: number[] = [];
    const fn = mockSequence([
      () =>
        new Response('{"message":"You are being rate limited.","retry_after":1,"global":true}', {
          status: 429,
          headers: { ...JSON_429, 'x-ratelimit-global': 'true', 'retry-after': '1' },
        }),
    ]);

    const caught = await failure(() =>
      fetchPortalEnabledPrivilegedIntents('token', { sleep: async (ms) => void waits.push(ms) }),
    );

    expect(fn.mock.calls.length).toBe(4);
    expect(waits.length).toBe(3);
    expect(Math.max(...waits)).toBeLessThanOrEqual(5_000);
    expect((caught as PortalFetchError).kind).toBe('http');
    expect(describePortalSyncFailure(caught)).toBe('HTTP 429 (token global limit), retry after 1s');
    expect(discordIpBlockRemainingMs()).toBe(0);
  });

  it('per-token global 429 announced only by the JSON body is not an IP block', async () => {
    const fn = mockSequence([
      () => new Response('{"retry_after":1,"global":true}', { status: 429, headers: JSON_429 }),
    ]);
    await failure(() => fetchPortalEnabledPrivilegedIntents('token', noSleep));
    expect(fn.mock.calls.length).toBeGreaterThan(1);
    expect(discordIpBlockRemainingMs()).toBe(0);
  });

  it('a non-JSON 429 with a Discord-shaped body is a rate limit: bounded retries, no platform hold', async () => {
    const fn = mockSequence([
      () =>
        new Response('{"message":"You are being rate limited.","retry_after":1.5,"global":false}', {
          status: 429,
          headers: { 'content-type': 'text/plain' },
        }),
      () => new Response(JSON.stringify({ flags: PRESENCE_LIMITED }), { status: 200 }),
    ]);
    const result = await fetchPortalEnabledPrivilegedIntents('token', noSleep);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(result.enabled).toEqual(new Set(['Guild Presence']));
    expect(discordIpBlockRemainingMs()).toBe(0);
  });

  it('an ordinary JSON 429 retries then succeeds', async () => {
    const fn = mockSequence([
      () =>
        new Response('{"message":"You are being rate limited.","retry_after":1,"global":false}', {
          status: 429,
          headers: { ...JSON_429, 'x-ratelimit-scope': 'user', 'retry-after': '1' },
        }),
      () => new Response(JSON.stringify({ flags: PRESENCE_LIMITED }), { status: 200 }),
    ]);
    const result = await fetchPortalEnabledPrivilegedIntents('token', noSleep);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(result.enabled).toEqual(new Set(['Guild Presence']));
    expect(discordIpBlockRemainingMs()).toBe(0);
  });

  it('reports every invalid response of the startup read to the observer, retries included', async () => {
    mockSequence([
      () =>
        new Response('{"message":"You are being rate limited.","retry_after":1,"global":false}', {
          status: 429,
          headers: { ...JSON_429, 'x-ratelimit-scope': 'user', 'retry-after': '1' },
        }),
      () => new Response(JSON.stringify({ flags: PRESENCE_LIMITED }), { status: 200 }),
    ]);
    const seen: Array<{ status: number; method: string; url: string; scope?: string | null }> = [];

    await fetchPortalEnabledPrivilegedIntents('token', {
      ...noSleep,
      onInvalidResponse: (info) => seen.push(info),
    });

    // La réponse 200 n'est pas un invalide ; le 429 est compté avec la route, sans jeton.
    expect(seen).toEqual([
      {
        status: 429,
        method: 'GET',
        url: 'https://discord.com/api/v10/applications/@me',
        scope: 'user',
      },
    ]);
  });

  it('reports a 403 of the startup read too', async () => {
    mockSequence([() => new Response('{}', { status: 403 })]);
    const seen: number[] = [];

    await expect(
      fetchPortalEnabledPrivilegedIntents('token', {
        ...noSleep,
        onInvalidResponse: (info) => seen.push(info.status),
      }),
    ).rejects.toBeInstanceOf(DiscordTokenUnauthorizedError);

    expect(seen).toEqual([403]);
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

describe('intents des routes de message (préfixes, variable de préfixe, mention)', () => {
  const approved = new Set(['Message Content']);
  const noCommands = { ...emptyConfig, commands: [] as JsBotConfig['commands'] };

  it('Message Content demandé quand seuls `prefixes` sont configurés (prefix vide, commandes à déclencheur implicite)', () => {
    const config = {
      ...noCommands,
      prefix: '',
      prefixes: ['?'],
      commands: [{ id: 'c', name: 'ping', script: '', enabled: true, aliases: [], options: [], type: 'command', description: '', discordType: 'chatInput' }],
    } as unknown as JsBotConfig;
    expect(buildEffectiveIntentsMap(config, approved)['Message Content']).toBe(true);
  });

  it('Message Content demandé avec une variable de préfixe', () => {
    const config = { ...noCommands, prefixVariable: 'prefix' } as JsBotConfig;
    expect(buildEffectiveIntentsMap(config, approved)['Message Content']).toBe(true);
    expect(buildEffectiveIntentsMap({ ...config, prefixVariable: '  ' } as JsBotConfig, approved)['Message Content']).toBe(false);
  });

  it('configurations historiques inchangées', () => {
    expect(buildEffectiveIntentsMap({ ...noCommands, prefix: '!' }, approved)['Message Content']).toBe(true);
    expect(buildEffectiveIntentsMap(noCommands, approved)['Message Content']).toBe(false);
    expect(buildEffectiveIntentsMap({ ...noCommands, prefix: '!' }, new Set())['Message Content']).toBe(false);
  });

  it('la mention seule ne lève pas Message Content (Discord fournit le contenu des messages qui mentionnent le bot) mais garde Guild Messages', () => {
    const config = { ...noCommands, mentionAsPrefix: true } as JsBotConfig;
    const effective = buildEffectiveIntentsMap(config, approved);
    expect(effective['Message Content']).toBe(false);
    expect(effective['Guild Messages']).toBe(true);
    expect(effective['Direct Messages']).toBe(true);
  });

  it('resolveRequiredIntentKeys réclame Guild Messages pour la mention, jamais Message Content', async () => {
    const { resolveRequiredIntentKeys } = await import('../src/discord/intent-resolver.js');
    const mention = resolveRequiredIntentKeys({ eventNames: [], mentionAsPrefix: true });
    expect([...mention]).toEqual(['Guild Messages']);
    expect([...resolveRequiredIntentKeys({ eventNames: [] })]).toEqual([]);
    const both = resolveRequiredIntentKeys({
      eventNames: [],
      hasLegacyCommands: true,
      mentionAsPrefix: true,
      approvedPrivilegedIntents: approved,
    });
    expect([...both].sort()).toEqual(['Guild Messages', 'Message Content']);
  });
});
