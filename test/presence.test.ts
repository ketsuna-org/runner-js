import { describe, expect, it } from 'bun:test';
import { applyPresence, stopPresenceRotation } from '../src/discord/presence.js';

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
});
