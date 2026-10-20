import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'bun:test';
import { Client, DefaultRestOptions } from 'discord.js';

import { parseJsBotConfig } from '../src/config/js-bot-config.js';
import { clearLastKnownPortalIntents } from '../src/discord/application-intent-sync.js';
import { clearDiscordIpBlock } from '../src/discord/discord-auth-errors.js';
import { buildDiscordClientOptions } from '../src/discord/discord-client-options.js';
import type { VariableDatabase } from '../src/runtime/variable-database.js';
import { JsDiscordRunner } from '../src/worker/js-discord-runner.js';

import {
  DISCORD_INVALID_REQUEST_WARNING_INTERVAL,
  DiscordRestStats,
  REST_LOG_MAX_LINES_PER_MINUTE,
  attachRestObservers,
  normalizeDiscordRoute,
} from '../src/discord/rest-observability.js';

const MINUTE = 60_000;

function fakeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

function invalid(status: number, path = '/channels/123456789012345678/messages', scope?: string) {
  return {
    status,
    method: 'POST',
    url: `https://discord.com/api/v10${path}?wait=true`,
    scope: scope ?? null,
  };
}

describe('normalizeDiscordRoute', () => {
  it.each([
    ['https://discord.com/api/v10/channels/123456789012345678/messages?limit=5', '/channels/:id/messages'],
    ['/guilds/123456789012345678/members/987654321098765432', '/guilds/:id/members/:id'],
    // Le bucketRoute de discord.js garde le jeton d'une interaction : il ne doit jamais sortir.
    [
      '/interactions/123456789012345678/aW50ZXJhY3Rpb24tdG9rZW4tc2VjcmV0LXZhbHVl/callback',
      '/interactions/:id/:token/callback',
    ],
    [
      'https://discord.com/api/v10/webhooks/123456789012345678/c2VjcmV0LXdlYmhvb2stdG9rZW4/messages/@original',
      '/webhooks/:id/:token/messages/@original',
    ],
    ['/webhooks/:id/:token', '/webhooks/:id/:token'],
    ['/applications/@me', '/applications/@me'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeDiscordRoute(input)).toBe(expected);
  });
});

describe('DiscordRestStats', () => {
  it('counts invalid responses by status, in a sliding 10 minute window', () => {
    const clock = fakeClock();
    const stats = new DiscordRestStats(clock.now);

    stats.recordInvalidResponse(invalid(403));
    stats.recordInvalidResponse(invalid(403));
    stats.recordInvalidResponse(invalid(401, '/users/@me'));
    clock.advance(5 * MINUTE);
    stats.recordInvalidResponse(invalid(429));

    let snapshot = stats.snapshot();
    expect(snapshot.invalid.window10m).toBe(4);
    expect(snapshot.invalid.byStatus).toEqual({ '401': 1, '403': 2, '429': 1 });
    expect(snapshot.invalid.total).toBe(4);

    // Les trois premières sortent de la fenêtre ; le total depuis le démarrage reste exact.
    clock.advance(6 * MINUTE);
    snapshot = stats.snapshot();
    expect(snapshot.invalid.window10m).toBe(1);
    expect(snapshot.invalid.byStatus).toEqual({ '401': 0, '403': 0, '429': 1 });
    expect(snapshot.invalid.total).toBe(4);
  });

  it('ignores statuses that are not invalid and leaves shared-scope 429 out of the budget', () => {
    const stats = new DiscordRestStats(fakeClock().now);

    stats.recordInvalidResponse(invalid(200));
    stats.recordInvalidResponse(invalid(404));
    stats.recordInvalidResponse(invalid(500));
    // Discord ne compte pas les 429 de scope « shared » dans ses 10 000.
    stats.recordInvalidResponse(invalid(429, '/channels/123456789012345678/messages', 'shared'));

    const snapshot = stats.snapshot();
    expect(snapshot.invalid.window10m).toBe(0);
    expect(snapshot.invalid.total).toBe(0);
    expect(snapshot.invalid.sharedRateLimited).toBe(1);
  });

  it('ranks the routes that burn the budget, without ids or tokens in the keys', () => {
    const stats = new DiscordRestStats(fakeClock().now);
    for (let i = 0; i < 5; i++) stats.recordInvalidResponse(invalid(403, '/channels/111111111111111111/messages'));
    for (let i = 0; i < 3; i++) stats.recordInvalidResponse(invalid(403, '/channels/222222222222222222/messages'));
    stats.recordInvalidResponse({
      status: 401,
      method: 'GET',
      url: 'https://discord.com/api/v10/users/@me',
    });

    const { topRoutes } = stats.snapshot().invalid;
    expect(topRoutes[0]).toEqual({ route: 'POST /channels/:id/messages', status: 403, count: 8 });
    expect(topRoutes[1]).toEqual({ route: 'GET /users/@me', status: 401, count: 1 });
  });

  it('bounds the number of distinct route keys', () => {
    const stats = new DiscordRestStats(fakeClock().now);
    for (let i = 0; i < 500; i++) {
      stats.recordInvalidResponse(invalid(403, `/some/route${i}`));
    }
    const snapshot = stats.snapshot();
    expect(snapshot.invalid.total).toBe(500);
    expect(snapshot.invalid.topRoutes.length).toBeLessThanOrEqual(8);
    const counted = snapshot.invalid.topRoutes.reduce((sum, entry) => sum + entry.count, 0);
    expect(counted).toBeGreaterThan(0);
  });
});

describe('attachRestObservers', () => {
  function setup() {
    const clock = fakeClock();
    const stats = new DiscordRestStats(clock.now);
    const rest = new EventEmitter();
    const onLog = vi.fn();
    attachRestObservers(rest, 'bot-42', onLog, stats);
    return { clock, stats, rest, onLog };
  }

  it('logs one warn line per invalidRequestWarning with the bot id, the process count and the top routes', () => {
    const { stats, rest, onLog } = setup();
    for (let i = 0; i < 4; i++) stats.recordInvalidResponse(invalid(403));
    stats.recordInvalidResponse(invalid(429, '/channels/123456789012345678/messages'));

    rest.emit('invalidRequestWarning', { count: 250, remainingTime: 598_400 });

    expect(onLog).toHaveBeenCalledTimes(1);
    const [level, message] = onLog.mock.calls[0] as [string, string];
    expect(level).toBe('warn');
    expect(message).toContain('Discord REST invalid_request_warning');
    expect(message).toContain('bot=bot-42');
    expect(message).toContain('process_count=250');
    expect(message).toContain('window_remaining_s=598');
    expect(message).toContain('bot_invalid_10m=5');
    expect(message).toContain('by_status=401:0,403:4,429:1');
    expect(message).toContain('top=POST /channels/:id/messages 403:4');
    expect(message).not.toContain('123456789012345678');
    expect(message).not.toContain('\n');
    expect(stats.snapshot().invalidRequestWarnings).toBe(1);
    expect(stats.snapshot().lastInvalidRequestWarningAt).not.toBeNull();
  });

  it('logs one warn line per rateLimited event and keeps the route free of ids and tokens', () => {
    const { stats, rest, onLog } = setup();

    rest.emit('rateLimited', {
      global: false,
      method: 'post',
      route: '/interactions/123456789012345678/aW50ZXJhY3Rpb24tdG9rZW4tc2VjcmV0LXZhbHVl/callback',
      scope: 'user',
      retryAfter: 1200,
      timeToReset: 1200,
      limit: 5,
      url: 'https://discord.com/api/v10/interactions/123456789012345678/SECRETTOKEN/callback',
    });

    expect(onLog).toHaveBeenCalledTimes(1);
    const [level, message] = onLog.mock.calls[0] as [string, string];
    expect(level).toBe('warn');
    expect(message).toBe(
      'Discord REST rate_limited bot=bot-42 method=POST route=/interactions/:id/:token/callback global=false scope=user retry_after_ms=1200',
    );
    expect(message).not.toContain('SECRETTOKEN');
    expect(stats.snapshot().rateLimited).toBe(1);
  });

  it('caps the lines per minute per event type, says so once, and keeps counting exactly', () => {
    const { clock, stats, rest, onLog } = setup();
    const max = REST_LOG_MAX_LINES_PER_MINUTE;
    const event = { global: false, method: 'get', route: '/x', scope: 'user', retryAfter: 10 };

    for (let i = 0; i < max + 10; i++) rest.emit('rateLimited', event);

    // max lignes + une seule ligne de coupure ; les compteurs, eux, voient tout.
    expect(onLog).toHaveBeenCalledTimes(max + 1);
    const lastMessage = onLog.mock.calls[max][1] as string;
    expect(lastMessage).toContain('rate_limited');
    expect(lastMessage).toContain('suppressed');
    expect(lastMessage).toContain('bot=bot-42');
    expect(stats.snapshot().rateLimited).toBe(max + 10);

    // L'autre type d'événement a son propre plafond.
    rest.emit('invalidRequestWarning', { count: 250, remainingTime: 1000 });
    expect(onLog).toHaveBeenCalledTimes(max + 2);

    // Une minute plus tard, les lignes repartent.
    clock.advance(MINUTE + 1);
    rest.emit('rateLimited', event);
    expect(onLog).toHaveBeenCalledTimes(max + 3);
    expect(stats.snapshot().rateLimited).toBe(max + 11);
  });

  it('keeps counting across a new client: the stats belong to the bot, not to the client', () => {
    const { stats, rest, onLog } = setup();
    rest.emit('invalidRequestWarning', { count: 250, remainingTime: 1000 });

    // Redémarrage du bot : nouveau client, donc nouvel émetteur, mêmes compteurs.
    const nextRest = new EventEmitter();
    attachRestObservers(nextRest, 'bot-42', onLog, stats);
    nextRest.emit('invalidRequestWarning', { count: 500, remainingTime: 1000 });

    expect(stats.snapshot().invalidRequestWarnings).toBe(2);
  });
});

describe('constants', () => {
  it('warns well before the 10 000 invalid responses Discord tolerates', () => {
    expect(DISCORD_INVALID_REQUEST_WARNING_INTERVAL).toBeGreaterThan(0);
    expect(DISCORD_INVALID_REQUEST_WARNING_INTERVAL).toBeLessThanOrEqual(1000);
  });
});

describe('JsDiscordRunner wires the REST observers on its real client', () => {
  const originalFetch = globalThis.fetch;
  const originalMakeRequest = DefaultRestOptions.makeRequest;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    (DefaultRestOptions as { makeRequest: unknown }).makeRequest = originalMakeRequest;
    vi.restoreAllMocks();
    clearDiscordIpBlock();
    clearLastKnownPortalIntents();
  });

  it('counts the invalid responses of the client and logs the two REST events with the bot id', async () => {
    // Lecture des intents au démarrage : le portail répond 429 de scope user, puis 200.
    let intentCalls = 0;
    globalThis.fetch = vi.fn(async () => {
      intentCalls += 1;
      return intentCalls === 1
        ? new Response('{"retry_after":0,"global":false}', {
            status: 429,
            headers: { 'content-type': 'application/json', 'x-ratelimit-scope': 'user', 'retry-after': '0' },
          })
        : new Response('{"flags":0}', { status: 200 });
    }) as unknown as typeof fetch;
    // Transport de base du client : tout est refusé en 403.
    (DefaultRestOptions as { makeRequest: unknown }).makeRequest = vi.fn(
      async () =>
        new Response('{"message":"Missing Access","code":50001}', {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
    );
    // Pas de gateway dans ce test : le login rejoue ce qui se passe sur le REST du client.
    vi.spyOn(Client.prototype, 'login').mockImplementation(async function (this: Client) {
      this.rest.setToken('token');
      await this.rest.get('/channels/123456789012345678/messages' as never).catch(() => undefined);
      this.rest.emit('invalidRequestWarning', { count: 250, remainingTime: 540_000 });
      this.rest.emit('rateLimited', {
        global: false,
        method: 'GET',
        route: '/channels/:id/messages',
        scope: 'user',
        retryAfter: 900,
        timeToReset: 900,
        limit: 5,
        hash: 'h',
        majorParameter: 'm',
        url: 'https://discord.com/api/v10/channels/123456789012345678/messages',
        sublimitTimeout: 0,
      } as never);
      return 'token';
    });

    const logs: string[] = [];
    const stats = new DiscordRestStats();
    const runner = new JsDiscordRunner(
      'bot-7',
      parseJsBotConfig({ token: 'token', commands: [] }),
      {} as VariableDatabase,
      (level, message) => logs.push(`${level}: ${message}`),
      undefined,
      stats,
    );

    await runner.start();
    await runner.stop();

    const snapshot = stats.snapshot();
    // Le 429 de la lecture des intents et le 403 du client sont tous deux au compte du bot.
    expect(snapshot.invalid.byStatus).toEqual({ '401': 0, '403': 1, '429': 1 });
    expect(snapshot.invalid.topRoutes.map((entry) => entry.route)).toContain(
      'GET /channels/:id/messages',
    );
    expect(snapshot.invalid.topRoutes.map((entry) => entry.route)).toContain(
      'GET /applications/@me',
    );
    expect(snapshot.invalidRequestWarnings).toBe(1);
    expect(snapshot.rateLimited).toBe(1);
    const restLines = logs.filter((line) => line.includes('Discord REST'));
    expect(restLines).toHaveLength(2);
    expect(restLines[0]).toStartWith('warn: Discord REST invalid_request_warning bot=bot-7 process_count=250');
    expect(restLines[1]).toStartWith('warn: Discord REST rate_limited bot=bot-7 method=GET');
  });
});

describe('invalidRequestWarning with the real discord.js REST', () => {
  it('fires once per 250 invalid responses, which is what makes the alarm real', async () => {
    const base = vi.fn(
      async () =>
        new Response('{"message":"Missing Access","code":50001}', {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const stats = new DiscordRestStats();
    const options = buildDiscordClientOptions({ Guilds: true }, base as never, (info) =>
      stats.recordInvalidResponse(info),
    );
    // discord.js espace ses requêtes (globalRequestsPerSecond = 50) : 250 requêtes prendraient 5 s, à la
    // limite du délai par défaut d'un test. On lève ce pas, l'intervalle d'alerte reste celui du vrai builder.
    const client = new Client({
      ...options,
      rest: { ...options.rest, globalRequestsPerSecond: 10_000 },
    });
    client.rest.setToken('token');
    const warnings: number[] = [];
    client.rest.on('invalidRequestWarning', (data) => warnings.push(data.count));

    for (let i = 0; i < DISCORD_INVALID_REQUEST_WARNING_INTERVAL; i++) {
      await client.rest.get('/channels/123456789012345678/messages' as never).catch(() => undefined);
    }

    // Le compteur de discord.js est global au processus : le seuil franchi est un multiple de 250.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]! % DISCORD_INVALID_REQUEST_WARNING_INTERVAL).toBe(0);
    expect(stats.snapshot().invalid.byStatus['403']).toBe(DISCORD_INVALID_REQUEST_WARNING_INTERVAL);
    await client.destroy();
  });
});
