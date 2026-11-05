import { describe, expect, it } from 'bun:test';

import {
  analyzeScriptVariableNeeds,
  needsScopedDefinition,
} from '../src/runtime/script-variable-needs.js';
import { buildScriptVariables } from '../src/runtime/scoped-context.js';
import type { VariableDatabase } from '../src/runtime/variable-database.js';

function countingStore(globals: Record<string, unknown>, scoped: Record<string, unknown>) {
  const calls: string[] = [];
  const store = {
    getGlobalVariables: async () => {
      calls.push('globals');
      return { ...globals };
    },
    getScopedVariable: async (_bot: string, scope: string, ctx: string, key: string) => {
      calls.push(`scoped:${scope}:${ctx}:${key}`);
      return scoped[`${scope}:${ctx}:${key}`];
    },
  } as unknown as VariableDatabase;
  return { store, calls };
}

const config = {
  globalVariables: { fromConfig: 'c' },
  scopedVariableDefinitions: [
    { key: 'coins', scope: 'user', defaultValue: 0 },
    { key: 'bc_score', scope: 'guild' },
    { key: 'xp', scope: 'guildMember' },
  ],
  commands: [],
  events: [],
  inboundWebhooks: [],
  intents: [],
  token: 'token',
  scriptTimeoutMs: 1000,
};

const ctx = {
  interaction: { user: { id: 'u1' }, guildId: 'g1', channelId: 'c1' } as never,
  guild: { id: 'g1' } as never,
};

describe('analyzeScriptVariableNeeds', () => {
  it('a script without variables needs nothing', () => {
    const needs = analyzeScriptVariableNeeds("await interaction.reply('pong');");
    expect(needs).toEqual({ all: false, usesVariables: false, keys: new Set() });
  });

  it('collects statically named keys', () => {
    const needs = analyzeScriptVariableNeeds(
      "const a = variables.coins; const b = variables['bc_score']; const c = variables?.xp;",
    );
    expect(needs).toEqual({ all: false, usesVariables: true, keys: new Set(['coins', 'score', 'xp']) });
  });

  it('falls back to everything when it cannot prove the keys', () => {
    for (const script of [
      'const k = "coins"; variables[k];',
      'console.log(variables);',
      'Object.keys(variables)',
      'const { coins } = variables;',
      'helper(variables)',
      'await fn.giveCoins(1)',
      'eval("variables.coins")',
      'globalThis["vari" + "ables"]',
      'new Function("return variables")()',
    ]) {
      expect(analyzeScriptVariableNeeds(script)).toEqual({ all: true });
    }
    expect(analyzeScriptVariableNeeds(undefined)).toEqual({ all: true });
  });

  it('matches definitions with or without bc_', () => {
    const needs = analyzeScriptVariableNeeds('variables.bc_coins');
    expect(needsScopedDefinition(needs, 'coins')).toBe(true);
    expect(needsScopedDefinition(needs, 'bc_coins')).toBe(true);
    expect(needsScopedDefinition(needs, 'xp')).toBe(false);
  });
});

describe('buildScriptVariables with a script', () => {
  it('does not call the store for a script that ignores variables', async () => {
    const { store, calls } = countingStore({ g: 1 }, {});
    const variables = await buildScriptVariables('bot', config, store, ctx, 'await interaction.reply("hi")');
    expect(calls).toEqual([]);
    expect(variables).toEqual({ fromConfig: 'c' });
  });

  it('reads only the cited scoped variable', async () => {
    const { store, calls } = countingStore(
      { motd: 'hello' },
      { 'user:u1:coins': 12, 'guild:g1:score': 3 },
    );
    const variables = await buildScriptVariables('bot', config, store, ctx, 'reply(variables.coins)');
    expect(calls).toEqual(['globals', 'scoped:user:u1:coins']);
    expect(variables.coins).toBe(12);
    expect(variables.bc_coins).toBe(12);
    expect(variables.motd).toBe('hello');
    expect('score' in variables).toBe(false);
  });

  it('applies the declared default for a cited variable without value', async () => {
    const { store } = countingStore({}, {});
    const variables = await buildScriptVariables('bot', config, store, ctx, 'variables.coins');
    expect(variables.coins).toBe(0);
  });

  it('loads everything without a script or for a dynamic one', async () => {
    for (const script of [undefined, 'helper(variables)']) {
      const { store, calls } = countingStore({}, { 'user:u1:coins': 1, 'guild:g1:score': 2 });
      const variables = await buildScriptVariables('bot', config, store, ctx, script);
      expect(calls).toContain('globals');
      expect(calls).toContain('scoped:user:u1:coins');
      expect(calls).toContain('scoped:guild:g1:score');
      expect(variables.coins).toBe(1);
      expect(variables.score).toBe(2);
    }
  });
});
