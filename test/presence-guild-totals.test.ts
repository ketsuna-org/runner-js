import { describe, expect, test } from 'bun:test';

import { presenceGuildTotals } from '../src/worker/js-discord-runner.js';

describe('presenceGuildTotals', () => {
  test('somme les membres de tous les serveurs et compte les serveurs', () => {
    const guilds = new Map([
      ['1', { memberCount: 10 }],
      ['2', { memberCount: 32 }],
      ['3', {}],
    ]);
    const client = { guilds: { cache: guilds } } as never;
    expect(presenceGuildTotals(client)).toEqual({ memberCount: 42, count: 3 });
  });
});
