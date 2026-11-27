import { describe, expect, it } from 'bun:test';

import { ManagedVoiceQuotaGateway, VoiceQuotaError } from '../src/runtime/voice/voice-quota.js';

function gateway(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { gw: new ManagedVoiceQuotaGateway({ baseUrl: 'https://m/internal/', token: 'tok', fetchImpl }), calls };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe('ManagedVoiceQuotaGateway', () => {
  it('réserve et clôt avec le jeton runner', async () => {
    const { gw, calls } = gateway((url) =>
      url.endsWith('/start') ? json(200, { session_id: 's1', granted_seconds: 120, remaining_seconds: 5000 }) : json(200, { ok: true }),
    );
    expect(await gw.reserve('bot 1', 'g1', 300)).toEqual({ sessionId: 's1', grantedSeconds: 120, remainingSeconds: 5000 });
    await gw.finish('bot 1', 's1', 42);
    expect(calls[0]!.url).toBe('https://m/internal/bots/bot%201/voice-recorder/start');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ session_id: 's1', used_seconds: 42 });
  });

  it('rend un code stable et un message clair pour chaque refus', async () => {
    for (const [status, code, text] of [
      [403, 'voice_recorder_premium_required', 'Premium'],
      [403, 'voice_recorder_quota_exceeded', 'quota'],
      [429, 'voice_recorder_too_many_sessions', 'maximum'],
      [503, 'voice_recorder_disabled', 'not enabled'],
    ] as const) {
      const { gw } = gateway(() => json(status, { code }));
      const error = (await gw.reserve('b', 'g', 60).catch((e) => e)) as VoiceQuotaError;
      expect(error).toBeInstanceOf(VoiceQuotaError);
      expect(error.code).toBe(code);
      expect(error.message).toContain(text);
    }
  });

  it('échoue fermé quand le Manager est injoignable ou répond n importe quoi', async () => {
    const down = new ManagedVoiceQuotaGateway({
      baseUrl: 'https://m',
      token: 't',
      fetchImpl: (async () => {
        throw new Error('network');
      }) as unknown as typeof fetch,
    });
    expect(((await down.reserve('b', 'g', 60).catch((e) => e)) as VoiceQuotaError).code).toBe('voice_recorder_unavailable');
    const { gw } = gateway(() => json(200, { session_id: '', granted_seconds: 0 }));
    expect(((await gw.reserve('b', 'g', 60).catch((e) => e)) as VoiceQuotaError).code).toBe('voice_recorder_unavailable');
    const odd = gateway(() => json(500, { code: 'something_else' }));
    expect(((await odd.gw.reserve('b', 'g', 60).catch((e) => e)) as VoiceQuotaError).code).toBe('voice_recorder_unavailable');
  });

  it('n installe rien sans configuration de runner géré', () => {
    expect(ManagedVoiceQuotaGateway.install({ managedRunnerApi: '', managedRunnerToken: '' })).toBe(false);
  });
});
