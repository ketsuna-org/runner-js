import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';
import { Client, DefaultRestOptions } from 'discord.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadRunnerEnv } from '../src/config/env.js';
import { parseJsBotConfig, type JsBotConfig } from '../src/config/js-bot-config.js';
import {
  DiscordUnavailableError,
  armDiscordIpBlock,
  asDiscordUnavailable,
  classifyDiscord429,
  clearDiscordIpBlock,
  clampRetryAfterSeconds,
  discord429RetryAfterSeconds,
  discordIpBlockRemainingMs,
  isDiscordTokenUnauthorized,
  type Discord429Class,
} from '../src/discord/discord-auth-errors.js';
import {
  DISCORD_REST_RETRIES,
  DISCORD_REST_TIMEOUT_MS,
  buildDiscordClientOptions,
  createGuardedMakeRequest,
  isLoginCriticalRoute,
} from '../src/discord/discord-client-options.js';
import { clearLastKnownPortalIntents } from '../src/discord/application-intent-sync.js';
import { createHttpServer } from '../src/http/server.js';
import { LogStore } from '../src/runtime/log-store.js';
import { RuntimeController } from '../src/runtime/runtime-controller.js';
import type { VariableDatabase } from '../src/runtime/variable-database.js';
import { JsDiscordRunner } from '../src/worker/js-discord-runner.js';

// Le texte exact vu en production (GET applications/@me), à rejouer tel quel.
const PEDRO_TEXT =
  'Failed to start bot: You are being blocked from accessing our API temporarily due to exceeding global rate limits. ' +
  'Refer to https://discord.com/developers/docs/topics/rate-limits for more information. ' +
  '(0) GET https://discord.com/api/v10/applications/@me';

// Corps réels non capturés : la table est faite pour être complétée avec les vrais.
const CLOUDFLARE_BAN_HTML =
  '<!DOCTYPE html><html><head><title>Access denied | discord.com used Cloudflare</title></head>' +
  '<body>error code: 1015 You are being rate limited</body></html>';

const JSON_HEADERS = { 'content-type': 'application/json' };

type Case = {
  name: string;
  headers: Record<string, string>;
  body: string;
  expected: Discord429Class;
};

const CLASSIFICATION_CASES: Case[] = [
  { name: 'Pedro text, plain text', headers: { 'content-type': 'text/plain' }, body: PEDRO_TEXT, expected: 'ip-block' },
  { name: 'ban text inside a JSON body with rate-limit headers', headers: { ...JSON_HEADERS, 'x-ratelimit-global': 'true' }, body: JSON.stringify({ message: 'You are being blocked from accessing our API', global: true }), expected: 'ip-block' },
  { name: 'cloudflare html (error code: 1015)', headers: { 'content-type': 'text/html; charset=UTF-8' }, body: CLOUDFLARE_BAN_HTML, expected: 'ip-block' },
  { name: 'non-JSON 429 with no x-ratelimit header', headers: { 'content-type': 'text/html' }, body: '<html>nope</html>', expected: 'ip-block' },
  { name: 'non-JSON 429 with a Retry-After only', headers: { 'content-type': 'text/html', 'retry-after': '30' }, body: 'slow down', expected: 'ip-block' },
  { name: 'non-JSON 429 but carrying x-ratelimit headers', headers: { 'content-type': 'text/plain', 'x-ratelimit-remaining': '0' }, body: 'slow down', expected: 'rate-limit' },
  { name: 'no content-type at all, no text pattern', headers: {}, body: 'slow down', expected: 'rate-limit' },
  { name: 'text/plain, no rate-limit header, empty body', headers: { 'content-type': 'text/plain' }, body: '', expected: 'ip-block' },
  { name: 'text/html with error code: 1015', headers: { 'content-type': 'text/html' }, body: 'error code: 1015', expected: 'ip-block' },
  { name: 'non-JSON content-type but Discord-shaped body (retry_after + global false)', headers: { 'content-type': 'text/plain' }, body: '{"retry_after":1.5,"global":false}', expected: 'rate-limit' },
  { name: 'non-JSON content-type, Discord-shaped body with only retry_after', headers: { 'content-type': 'text/plain' }, body: '{"retry_after":2}', expected: 'rate-limit' },
  { name: 'non-JSON content-type, Discord-shaped body with only global false', headers: { 'content-type': 'text/html' }, body: '{"global":false}', expected: 'rate-limit' },
  { name: 'non-JSON content-type, global true in body: token-global, not ip-block', headers: { 'content-type': 'text/plain' }, body: '{"retry_after":1,"global":true}', expected: 'token-global' },
  { name: 'non-JSON content-type, JSON object without retry_after/global', headers: { 'content-type': 'text/plain' }, body: '{"message":"nope"}', expected: 'ip-block' },
  { name: 'non-JSON content-type, non-numeric retry_after', headers: { 'content-type': 'text/plain' }, body: '{"retry_after":"soon"}', expected: 'ip-block' },
  { name: 'blocked text wins over a Discord-shaped body', headers: { 'content-type': 'text/plain' }, body: '{"message":"You are being blocked","retry_after":1,"global":false}', expected: 'ip-block' },
  { name: 'no content-type, empty body: never ip-block', headers: {}, body: '', expected: 'rate-limit' },
  { name: 'per-token global, header', headers: { ...JSON_HEADERS, 'x-ratelimit-global': 'true', 'retry-after': '2' }, body: JSON.stringify({ message: 'You are being rate limited.', retry_after: 2, global: true }), expected: 'token-global' },
  { name: 'per-token global, scope header', headers: { ...JSON_HEADERS, 'x-ratelimit-scope': 'global' }, body: '{"message":"You are being rate limited.","retry_after":1}', expected: 'token-global' },
  { name: 'per-token global, JSON body only', headers: JSON_HEADERS, body: '{"message":"You are being rate limited.","retry_after":1,"global":true}', expected: 'token-global' },
  { name: 'ordinary route 429 (scope user)', headers: { ...JSON_HEADERS, 'x-ratelimit-scope': 'user', 'x-ratelimit-bucket': 'abc', 'retry-after': '1' }, body: '{"message":"You are being rate limited.","retry_after":1,"global":false}', expected: 'rate-limit' },
  { name: 'ordinary 429 (scope shared)', headers: { ...JSON_HEADERS, 'x-ratelimit-scope': 'shared' }, body: '{"message":"You are being rate limited.","retry_after":0.5,"global":false}', expected: 'rate-limit' },
];

describe('classifyDiscord429', () => {
  it.each(CLASSIFICATION_CASES)('$name -> $expected', ({ headers, body, expected }) => {
    expect(classifyDiscord429({ headers: new Headers(headers), bodyText: body })).toBe(expected);
  });

  it('reads the retry-after from the header, then from the JSON body', () => {
    expect(discord429RetryAfterSeconds({ headers: new Headers({ 'retry-after': '7' }) })).toBe(7);
    expect(
      discord429RetryAfterSeconds({ headers: new Headers(), bodyText: '{"retry_after":2.5}' }),
    ).toBe(2.5);
    expect(discord429RetryAfterSeconds({ headers: new Headers(), bodyText: 'html' })).toBeNull();
  });
});

describe('DiscordUnavailableError', () => {
  it('exposes the contract code and an integer retry-after clamped to [1, 600] (60 by default)', () => {
    const blocked = new DiscordUnavailableError('blocked', 4013);
    expect(blocked.code).toBe('discord_temporarily_blocked');
    expect(blocked.retryAfterSeconds).toBe(600);
    const limited = new DiscordUnavailableError('rate_limited', 0.2);
    expect(limited.code).toBe('discord_rate_limited');
    expect(limited.retryAfterSeconds).toBe(1);
    expect(new DiscordUnavailableError('blocked').retryAfterSeconds).toBe(60);
    expect(clampRetryAfterSeconds(Number.NaN)).toBe(60);
  });

  it('is never read as an invalid token, even with a 4013 in the text', () => {
    expect(isDiscordTokenUnauthorized(new DiscordUnavailableError('blocked', 30))).toBe(false);
    expect(isDiscordTokenUnauthorized(new Error(PEDRO_TEXT))).toBe(false);
    expect(isDiscordTokenUnauthorized(PEDRO_TEXT)).toBe(false);
    expect(
      isDiscordTokenUnauthorized(
        new Error('You are being blocked: gateway close 4013 retry after 4013s'),
      ),
    ).toBe(false);
    // Contrôle : sans le texte de blocage, ce même message reste un jeton refusé.
    expect(isDiscordTokenUnauthorized(new Error('gateway close 4013'))).toBe(true);
  });

  it('turns a discord.js RateLimitError (empty message) into a typed rate_limited error', () => {
    const rateLimit = Object.assign(new Error(), {
      name: 'RateLimitError[/gateway/bot]',
      retryAfter: 2400,
      timeToReset: 0,
    });
    const typed = asDiscordUnavailable(rateLimit);
    expect(typed?.kind).toBe('rate_limited');
    expect(typed?.retryAfterSeconds).toBe(3);
    expect(typed?.message).not.toBe('');
    expect(asDiscordUnavailable(new Error('boom'))).toBeNull();
  });
});

describe('process-wide IP block', () => {
  afterEach(() => clearDiscordIpBlock());

  it('arms from a clock, only extends, and expires', () => {
    expect(discordIpBlockRemainingMs(0)).toBe(0);
    expect(armDiscordIpBlock(30, 1_000)).toBe(30);
    expect(discordIpBlockRemainingMs(1_000)).toBe(30_000);
    armDiscordIpBlock(5, 1_000);
    expect(discordIpBlockRemainingMs(1_000)).toBe(30_000);
    expect(discordIpBlockRemainingMs(31_000)).toBe(0);
  });
});

describe('buildDiscordClientOptions rest options', () => {
  it('sets explicit timeout and retries and rejects 429 on login routes only', () => {
    const rest = buildDiscordClientOptions({ Guilds: true }).rest!;
    expect(rest.timeout).toBe(DISCORD_REST_TIMEOUT_MS);
    expect(rest.retries).toBe(DISCORD_REST_RETRIES);
    expect(DISCORD_REST_RETRIES).toBe(DefaultRestOptions.retries);
    expect(DISCORD_REST_RETRIES).toBe(3);
    expect(typeof rest.makeRequest).toBe('function');
    const reject = rest.rejectOnRateLimit as (data: { route: string }) => boolean;
    expect(reject({ route: '/gateway/bot' })).toBe(true);
    expect(reject({ route: '/applications/@me' })).toBe(true);
    expect(reject({ route: '/channels/:id/messages' })).toBe(false);
    expect(isLoginCriticalRoute('/gateway')).toBe(true);
  });
});

function fakeResponse(status: number, headers: Record<string, string>, body: string) {
  return new Response(body, { status, headers });
}

describe('createGuardedMakeRequest', () => {
  afterEach(() => clearDiscordIpBlock());

  it('throws a typed blocked error on an IP-ban 429, arms the hold, then sends nothing', async () => {
    const base = vi.fn(async () =>
      fakeResponse(429, { 'content-type': 'text/html' }, CLOUDFLARE_BAN_HTML),
    );
    const guarded = createGuardedMakeRequest(base as never);

    const first = await guarded('https://discord.com/api/v10/users/@me', {}).catch((e) => e);
    expect(first).toBeInstanceOf(DiscordUnavailableError);
    expect((first as DiscordUnavailableError).kind).toBe('blocked');
    expect(discordIpBlockRemainingMs()).toBeGreaterThan(0);

    const second = await guarded('https://discord.com/api/v10/users/@me', {}).catch((e) => e);
    expect((second as DiscordUnavailableError).kind).toBe('blocked');
    expect(base).toHaveBeenCalledTimes(1);
  });

  it('hands back an ordinary 429 untouched, body included, without arming the hold', async () => {
    const body = '{"message":"You are being rate limited.","retry_after":1,"global":false}';
    const base = vi.fn(async () =>
      fakeResponse(429, { ...JSON_HEADERS, 'x-ratelimit-scope': 'user' }, body),
    );
    const guarded = createGuardedMakeRequest(base as never);

    const response = await guarded('https://discord.com/api/v10/users/@me', {});
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual(JSON.parse(body));
    expect(discordIpBlockRemainingMs()).toBe(0);
  });

  it('does not arm the hold on a non-JSON 429 whose body is Discord-shaped', async () => {
    const body = '{"message":"You are being rate limited.","retry_after":1.5,"global":false}';
    const base = vi.fn(async () => fakeResponse(429, { 'content-type': 'text/plain' }, body));
    const guarded = createGuardedMakeRequest(base as never);

    const response = await guarded('https://discord.com/api/v10/users/@me', {});
    expect(response.status).toBe(429);
    expect(await response.text()).toBe(body);
    expect(discordIpBlockRemainingMs()).toBe(0);
    await guarded('https://discord.com/api/v10/users/@me', {});
    expect(base).toHaveBeenCalledTimes(2);
  });

  it('does not touch successful responses', async () => {
    const ok = fakeResponse(200, JSON_HEADERS, '{}');
    const guarded = createGuardedMakeRequest((async () => ok) as never);
    expect(await guarded('https://discord.com/api/v10/users/@me', {})).toBe(ok);
  });
});

describe('Client.login against a 429 on /gateway/bot', () => {
  let client: Client | null = null;

  afterEach(async () => {
    await client?.destroy();
    client = null;
    clearDiscordIpBlock();
  });

  async function loginWith(response: () => Response) {
    const base = vi.fn(async () => response());
    client = new Client(buildDiscordClientOptions({ Guilds: true }, base as never));
    const error = await client.login('token').catch((e: unknown) => e);
    return { base, error };
  }

  it('an IP-ban shaped 429 costs exactly one request and a typed blocked error', async () => {
    const { base, error } = await loginWith(() =>
      fakeResponse(429, { 'content-type': 'text/html' }, 'Access denied'),
    );
    expect(base).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(DiscordUnavailableError);
    expect((error as DiscordUnavailableError).kind).toBe('blocked');
    expect(discordIpBlockRemainingMs()).toBeGreaterThan(0);
  });

  it('a per-token global 429 fails fast as rate_limited and never arms the platform hold', async () => {
    const { base, error } = await loginWith(() =>
      fakeResponse(
        429,
        { ...JSON_HEADERS, 'x-ratelimit-global': 'true', 'retry-after': '2' },
        '{"message":"You are being rate limited.","retry_after":2,"global":true}',
      ),
    );
    expect(base).toHaveBeenCalledTimes(1);
    const typed = asDiscordUnavailable(error);
    expect(typed?.kind).toBe('rate_limited');
    expect(discordIpBlockRemainingMs()).toBe(0);
  });

  it('an ordinary 429 on the login route also fails fast as rate_limited', async () => {
    const { base, error } = await loginWith(() =>
      fakeResponse(
        429,
        { ...JSON_HEADERS, 'x-ratelimit-scope': 'user', 'retry-after': '3' },
        '{"message":"You are being rate limited.","retry_after":3,"global":false}',
      ),
    );
    expect(base).toHaveBeenCalledTimes(1);
    expect(asDiscordUnavailable(error)?.kind).toBe('rate_limited');
    expect(discordIpBlockRemainingMs()).toBe(0);
  });
});

describe('JsDiscordRunner.start against an IP block', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearDiscordIpBlock();
    clearLastKnownPortalIntents();
  });

  function makeRunner(logs: string[]) {
    const config = { token: 'token', events: [], commands: [] } as unknown as JsBotConfig;
    return new JsDiscordRunner(
      'bot-1',
      config,
      {} as VariableDatabase,
      (level, message) => logs.push(`${level}: ${message}`),
    );
  }

  it('stops at the intent fetch: one request, one warning, typed blocked error, no login', async () => {
    const fetchMock = vi.fn(async () =>
      fakeResponse(429, { 'content-type': 'text/plain' }, PEDRO_TEXT),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const logs: string[] = [];
    const runner = makeRunner(logs);

    const error = await runner.start().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DiscordUnavailableError);
    expect((error as DiscordUnavailableError).code).toBe('discord_temporarily_blocked');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const warnings = logs.filter((line) => line.startsWith('warn: Intent warning:'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('retry after');
    expect(warnings[0]).not.toContain('token');
    expect(runner.getStatus().lastError).toBe((error as Error).message);
  });

  it('a second start during the block sends no request at all', async () => {
    const fetchMock = vi.fn(async () =>
      fakeResponse(429, { 'content-type': 'text/plain' }, PEDRO_TEXT),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const runner = makeRunner([]);

    await runner.start().catch(() => undefined);
    const second = await runner.start().catch((e: unknown) => e);

    expect((second as DiscordUnavailableError).kind).toBe('blocked');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('JsDiscordRunner.start against a 429 at login', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    clearDiscordIpBlock();
    clearLastKnownPortalIntents();
  });

  it('maps a per-token global 429 on /gateway/bot to a typed rate_limited error, hold untouched', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ flags: 0 }), { status: 200 }),
    ) as unknown as typeof fetch;
    const transport = vi.fn(async () =>
      fakeResponse(
        429,
        { ...JSON_HEADERS, 'x-ratelimit-global': 'true', 'retry-after': '2' },
        '{"message":"You are being rate limited.","retry_after":2,"global":true}',
      ),
    );
    vi.spyOn(DefaultRestOptions, 'makeRequest').mockImplementation(transport as never);
    const runner = new JsDiscordRunner(
      'bot-1',
      parseJsBotConfig({ token: 'token', events: [], commands: [] }),
      {} as VariableDatabase,
      () => undefined,
    );

    const error = await runner.start().catch((e: unknown) => e);

    expect(transport).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(DiscordUnavailableError);
    expect((error as DiscordUnavailableError).code).toBe('discord_rate_limited');
    expect(runner.getStatus().lastError).toBeTruthy();
    expect(discordIpBlockRemainingMs()).toBe(0);
  });
});

describe('start route', () => {
  let dir: string;
  let runtime: RuntimeController | null = null;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-js-login-'));
  });

  afterEach(async () => {
    await runtime?.dispose();
    runtime = null;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function appFailingWith(error: Error) {
    const env = {
      ...loadRunnerEnv(),
      dataDir: dir,
      logFile: path.join(dir, 'logs', 'runner.log'),
      webHost: '127.0.0.1',
      webPort: 0,
      apiToken: '',
    };
    const logStore = new LogStore(env.logFile);
    runtime = new RuntimeController(dir, logStore, {} as VariableDatabase, 1, () => ({
      start: async () => {
        throw error;
      },
      stop: async () => undefined,
      reload: async () => undefined,
      triggerWebhook: async () => true,
      getGuildCount: () => 0,
      getHeapUsedBytes: () => null,
    }));
    const app = createHttpServer({ env, runtime, logStore });
    const sync = await app.request('/bots/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ botId: 'b1', botName: 'B', config: { token: 'x', commands: [] } }),
    });
    expect(sync.status).toBe(200);
    return app;
  }

  it('answers 503 discord_temporarily_blocked with retry_after_seconds and Retry-After', async () => {
    const app = await appFailingWith(new DiscordUnavailableError('blocked', 90));
    const response = await app.request('/bots/b1/start', { method: 'POST' });

    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('90');
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.code).toBe('discord_temporarily_blocked');
    expect(body.retry_after_seconds).toBe(90);
    expect(typeof body.error).toBe('string');
    expect(runtime!.isBotRunning('b1')).toBe(false);
  });

  it('answers 503 discord_rate_limited for a per-token limit', async () => {
    const app = await appFailingWith(new DiscordUnavailableError('rate_limited', 3));
    const response = await app.request('/bots/b1/start', { method: 'POST' });

    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('3');
    expect(await response.json()).toMatchObject({
      code: 'discord_rate_limited',
      retry_after_seconds: 3,
    });
  });

  it('answers 503 on /reload when the reconnection hits a Discord block', async () => {
    const env = {
      ...loadRunnerEnv(),
      dataDir: dir,
      logFile: path.join(dir, 'logs', 'runner.log'),
      webHost: '127.0.0.1',
      webPort: 0,
      apiToken: '',
    };
    const logStore = new LogStore(env.logFile);
    runtime = new RuntimeController(dir, logStore, {} as VariableDatabase, 1, () => ({
      start: async () => undefined,
      stop: async () => undefined,
      reload: async () => {
        throw new DiscordUnavailableError('blocked', 45);
      },
      triggerWebhook: async () => true,
      getGuildCount: () => 0,
      getHeapUsedBytes: () => null,
    }));
    const app = createHttpServer({ env, runtime, logStore });
    const post = (url: string, body: unknown) =>
      app.request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const config = { token: 'x', commands: [] };
    expect((await post('/bots/sync', { botId: 'b1', botName: 'B', config })).status).toBe(200);
    expect((await post('/bots/b1/start', {})).status).toBe(200);

    const response = await post('/bots/b1/reload', { config });

    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('45');
    expect(await response.json()).toMatchObject({
      code: 'discord_temporarily_blocked',
      retry_after_seconds: 45,
    });
  });

  it('end to end: Pedro text on applications/@me gives a 503 discord_temporarily_blocked after one request', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async () =>
      fakeResponse(429, { 'content-type': 'text/plain' }, PEDRO_TEXT),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const env = {
        ...loadRunnerEnv(),
        dataDir: dir,
        logFile: path.join(dir, 'logs', 'runner.log'),
        webHost: '127.0.0.1',
        webPort: 0,
        apiToken: '',
      };
      const logStore = new LogStore(env.logFile);
      runtime = new RuntimeController(dir, logStore, {} as VariableDatabase, 1);
      const app = createHttpServer({ env, runtime, logStore });
      const sync = await app.request('/bots/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ botId: 'b1', botName: 'B', config: { token: 'x', commands: [] } }),
      });
      expect(sync.status).toBe(200);

      const response = await app.request('/bots/b1/start', { method: 'POST' });

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: 'discord_temporarily_blocked' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(runtime.isBotRunning('b1')).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
      clearDiscordIpBlock();
      clearLastKnownPortalIntents();
    }
  });

  it('keeps answering 401 discord_token_invalid for a genuinely refused token', async () => {
    const { DiscordTokenUnauthorizedError } = await import('../src/discord/discord-auth-errors.js');
    const app = await appFailingWith(new DiscordTokenUnauthorizedError('refused'));
    const response = await app.request('/bots/b1/start', { method: 'POST' });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'discord_token_invalid' });
  });
});

