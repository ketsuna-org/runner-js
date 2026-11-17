import { describe, expect, it } from 'bun:test';

import { scriptOrigin } from '../src/discord/handler-registry.js';

describe('scriptOrigin', () => {
  it('names slash commands, prefix commands, scheduled tasks and webhooks', () => {
    expect(scriptOrigin({ interaction: { commandName: 'ask' } as never })).toEqual({ kind: 'command', name: 'ask' });
    expect(scriptOrigin({ message: {} as never, invocation: { name: 'conseil' } })).toEqual({ kind: 'command', name: 'conseil' });
    expect(scriptOrigin({ scheduled: { id: 'world_tick' } })).toEqual({ kind: 'workflow', name: 'world_tick' });
    expect(scriptOrigin({ webhook: { path: 'rss' } })).toEqual({ kind: 'workflow', name: 'rss' });
    expect(scriptOrigin({ message: {} as never })).toBeUndefined();
  });
});
