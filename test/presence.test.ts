import { describe, expect, it } from 'bun:test';
import { applyPresence, presenceTextScript, stopPresenceRotation } from '../src/discord/presence.js';

function fakeClient() {
  const calls: unknown[] = [];
  return { calls, user: { setPresence: (p: unknown) => calls.push(p) } } as never as {
    calls: unknown[];
    user: unknown;
  };
}

describe('applyPresence', () => {
  it('sets all activities at once when there is a single one', () => {
    const c = fakeClient();
    applyPresence(c as never, { presence: { status: 'idle', activities: [{ type: 'watching', name: 'a' }] } } as never);
    expect(c.calls).toHaveLength(1);
    expect((c.calls[0] as { activities: unknown[] }).activities).toHaveLength(1);
  });

  it('starts rotation with the first activity when there are several', () => {
    const c = fakeClient();
    const cfg = {
      presence: {
        status: 'online',
        activities: [
          { type: 'playing', name: 'a', minIntervalSeconds: 30 },
          { type: 'playing', name: 'b', minIntervalSeconds: 30 },
        ],
      },
    } as never;
    applyPresence(c as never, cfg);
    expect(c.calls).toHaveLength(1);
    expect(((c.calls[0] as { activities: { name: string }[] }).activities)[0].name).toBe('a');
    stopPresenceRotation(c as never);
  });

  it('sends a custom status (type 4) with the text in state', () => {
    const c = fakeClient();
    applyPresence(c as never, { presence: { status: 'online', activities: [{ type: 'custom', name: 'Ready to help' }] } } as never);
    expect((c.calls[0] as { activities: unknown[] }).activities).toEqual([
      { name: 'Custom Status', type: 4, state: 'Ready to help' },
    ]);
  });
});

describe('applyPresence with dynamic text', () => {
  it('evaluates ${...} parts and refreshes on a single status', async () => {
    const c = fakeClient();
    const seen: string[] = [];
    applyPresence(
      c as never,
      { presence: { status: 'online', activities: [{ type: 'custom', name: 'Ping ${client.ws.ping} ms' }] } } as never,
      async (text) => {
        seen.push(text);
        return 'Ping 42 ms';
      },
    );
    await new Promise((r) => setTimeout(r, 5));
    expect(seen).toEqual(['Ping ${client.ws.ping} ms']);
    expect((c.calls[0] as { activities: unknown[] }).activities).toEqual([
      { name: 'Custom Status', type: 4, state: 'Ping 42 ms' },
    ]);
    stopPresenceRotation(c as never);
  });

  it('keeps the raw text when the evaluation fails', async () => {
    const c = fakeClient();
    applyPresence(
      c as never,
      { presence: { status: 'online', activities: [{ type: 'playing', name: 'x ${boom}' }] } } as never,
      async () => {
        throw new Error('boom');
      },
    );
    await new Promise((r) => setTimeout(r, 5));
    expect(((c.calls[0] as { activities: { name: string }[] }).activities)[0].name).toBe('x ${boom}');
    stopPresenceRotation(c as never);
  });

  it('renders the text as a template literal', () => {
    expect(presenceTextScript('a `b` ${client.ws.ping}')).toBe('return `a \\`b\\` ${client.ws.ping}`;');
  });
});
