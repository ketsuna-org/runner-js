import { describe, expect, it } from 'bun:test';

import { DiscordUnavailableError } from '../src/discord/discord-auth-errors.js';
import { createGuardedMakeRequest } from '../src/discord/discord-client-options.js';
import {
  DiscordRestStats,
  readBreakerConfig,
} from '../src/discord/rest-observability.js';

const MINUTE = 60_000;

function clock(start = 1_000_000) {
  let current = start;
  return { now: () => current, advance: (ms: number) => (current += ms) };
}

const url = 'https://discord.com/api/v10/channels/123456789012345678/messages';
const bad = (status: number, scope: string | null = null) => ({
  status,
  method: 'POST',
  url,
  scope,
});

describe('disjoncteur des réponses invalides', () => {
  it('ouvre au seuil, coupe les appels et prévient une fois', () => {
    const c = clock();
    const stats = new DiscordRestStats(c.now, { limit: 5, cooldownMs: 15 * MINUTE });
    const reasons: string[] = [];
    stats.onBreakerTrip = (r) => reasons.push(r);

    for (let i = 0; i < 4; i++) stats.recordInvalidResponse(bad(401));
    stats.assertCallsAllowed();
    stats.recordInvalidResponse(bad(401));
    stats.recordInvalidResponse(bad(403));

    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('suspendus pendant 15 min');
    expect(reasons[0]).toContain('401: 5');
    let thrown: unknown;
    try {
      stats.assertCallsAllowed();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DiscordUnavailableError);
    const error = thrown as DiscordUnavailableError;
    expect(error.code).toBe('bot_discord_calls_paused');
    expect(error.message.toLowerCase()).not.toContain('unauthorized');
    expect(stats.breakerSnapshot().open).toBe(true);
  });

  it('se referme après le refroidissement et repart de zéro', () => {
    const c = clock();
    const stats = new DiscordRestStats(c.now, { limit: 3, cooldownMs: 10 * MINUTE });
    for (let i = 0; i < 3; i++) stats.recordInvalidResponse(bad(429));
    expect(() => stats.assertCallsAllowed()).toThrow(DiscordUnavailableError);
    c.advance(11 * MINUTE);
    stats.assertCallsAllowed();
    const snap = stats.breakerSnapshot();
    expect(snap.open).toBe(false);
    expect(snap.invalidInWindow).toBe(0);
    expect(snap.trips).toBe(1);
  });

  it('ignore les 429 shared et la limite 0 désactive le disjoncteur', () => {
    const c = clock();
    const shared = new DiscordRestStats(c.now, { limit: 3, cooldownMs: MINUTE });
    for (let i = 0; i < 50; i++) shared.recordInvalidResponse(bad(429, 'shared'));
    shared.assertCallsAllowed();

    const off = new DiscordRestStats(c.now, { limit: 0, cooldownMs: MINUTE });
    for (let i = 0; i < 500; i++) off.recordInvalidResponse(bad(401));
    off.assertCallsAllowed();
  });

  it('les réglages se lisent dans l\'environnement', () => {
    expect(readBreakerConfig({ DISCORD_BOT_INVALID_LIMIT: '50', DISCORD_BOT_BREAKER_COOLDOWN_SECONDS: '120' })).toEqual({
      limit: 50,
      cooldownMs: 120_000,
    });
    expect(readBreakerConfig({ DISCORD_BOT_INVALID_LIMIT: 'abc' }).limit).toBe(200);
    expect(readBreakerConfig({ DISCORD_BOT_INVALID_LIMIT: '0' }).limit).toBe(0);
  });

  it('le transport ne part pas vers Discord quand le disjoncteur est ouvert', async () => {
    const c = clock();
    const stats = new DiscordRestStats(c.now, { limit: 2, cooldownMs: 10 * MINUTE });
    let sent = 0;
    const base = (async () => {
      sent += 1;
      return new Response('{}', { status: 401 });
    }) as never;
    const makeRequest = createGuardedMakeRequest(
      base,
      (info) => stats.recordInvalidResponse(info),
      () => stats.assertCallsAllowed(),
    );
    await makeRequest(url, { method: 'POST' } as never);
    await makeRequest(url, { method: 'POST' } as never);
    expect(sent).toBe(2);
    await expect(makeRequest(url, { method: 'POST' } as never)).rejects.toBeInstanceOf(
      DiscordUnavailableError,
    );
    expect(sent).toBe(2);
  });
});
