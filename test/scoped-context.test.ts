import { describe, expect, it } from 'vitest';

import {
  findScopedVariableDefinition,
  resolveContextIdForScope,
  resolveScopedContextId,
} from '../src/runtime/scoped-context.js';

describe('scoped-context', () => {
  const config = {
    globalVariables: {},
    scopedVariableDefinitions: [
      { key: 'coins', scope: 'user' },
      { key: 'bc_score', scope: 'guild' },
    ],
    commands: [],
    events: [],
    inboundWebhooks: [],
    intents: [],
    token: 'token',
    scriptTimeoutMs: 1000,
  };

  it('finds scoped definitions with bc_ prefix', () => {
    const definition = findScopedVariableDefinition(config, 'bc_score');
    expect(definition.scope).toBe('guild');
    expect(definition.key).toBe('score');
  });

  it('resolves user and guildMember context ids', () => {
    expect(
      resolveScopedContextId('user', {
        interaction: { user: { id: 'u1' } } as never,
      }),
    ).toBe('u1');

    expect(
      resolveScopedContextId('guildMember', {
        guild: { id: 'g1' } as never,
        interaction: { user: { id: 'u2' } } as never,
      }),
    ).toBe('g1:u2');
  });

  it('resolves explicit target ids without interaction context', () => {
    expect(
      resolveContextIdForScope('user', {}, { userId: 'explicit-user' }),
    ).toBe('explicit-user');

    expect(
      resolveContextIdForScope('guildMember', {}, { guildId: 'g9', userId: 'u9' }),
    ).toBe('g9:u9');
  });
});
