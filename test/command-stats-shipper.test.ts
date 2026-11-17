import { describe, expect, test } from 'bun:test';
import { CommandStatsShipper, redactCommandError } from '../src/runtime/command-stats-shipper.js';

describe('CommandStatsShipper', () => {
  test('envoie les exécutions au Manager avec le contrat command-stats', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const shipper = new CommandStatsShipper({
      baseUrl: 'https://api.example/internal/runners/t/',
      token: 'tok',
      fetchFn: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch,
      now: () => Date.parse('2026-11-15T10:00:00Z'),
    });
    shipper.record({ botId: 'b1', command: 'ping', guildId: 'g1', locale: 'fr', ok: true, ms: 42.4 });
    shipper.record({ botId: 'b1', command: 'boom', ok: false, ms: 9, error: 'x is not\n a function' });
    shipper.record({ botId: '', command: 'ignored', ok: true, ms: 1 });
    await shipper.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.example/internal/runners/t/command-stats');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.records).toEqual([
      { bot_id: 'b1', command_name: 'ping', guild_id: 'g1', locale: 'fr', success: true, latency_ms: 42, executed_at: '2026-11-15T10:00:00.000Z' },
      { bot_id: 'b1', command_name: 'boom', success: false, latency_ms: 9, error: 'x is not a function', executed_at: '2026-11-15T10:00:00.000Z' },
    ]);
    expect(shipper.pending).toBe(0);
  });

  test('remet le lot en file après une erreur 5xx', async () => {
    let status = 503;
    const shipper = new CommandStatsShipper({
      baseUrl: 'https://api.example',
      token: 't',
      fetchFn: (async () => new Response('', { status })) as unknown as typeof fetch,
    });
    shipper.record({ botId: 'b', command: 'a', ok: true, ms: 1 });
    await shipper.flush();
    expect(shipper.pending).toBe(1);
    status = 200;
  });

  test('masque les jetons et borne le texte', () => {
    const token = `${'A'.repeat(24)}.${'b'.repeat(6)}.${'c'.repeat(30)}`;
    expect(redactCommandError(`bad ${token} here`)).toBe('bad [token] here');
    expect(redactCommandError('Authorization: Bearer abcdefghijklmnop')).not.toContain('abcdefghijklmnop');
    expect(redactCommandError('x'.repeat(1000)).length).toBeLessThanOrEqual(301);
  });
});
