import { describe, expect, it } from 'vitest';

import {
  buildEffectiveIntentsMap,
  buildSafeFallbackIntentsMap,
  intentsMapsEqual,
} from '../src/discord/application-intent-sync.js';
import { mapIntents } from '../src/discord/intent-mapper.js';
import { GatewayIntentBits } from 'discord.js';
import type { JsBotConfig } from '../src/config/js-bot-config.js';

const baseConfig: JsBotConfig = {
  token: 'token',
  intents: {},
  commands: [],
  events: [],
  scheduled: [],
  inboundWebhooks: [],
  globalVariables: {},
  scopedVariableDefinitions: [],
  scriptTimeoutMs: 30_000,
  autoRestart: true,
};

describe('buildEffectiveIntentsMap', () => {
  it('enables privileged intent only when required and portal-enabled', () => {
    const config: JsBotConfig = {
      ...baseConfig,
      events: [{ id: '1', enabled: true, script: 'module.exports = async () => {}', name: 'messageCreate' }],
    };

    const effective = buildEffectiveIntentsMap(config, new Set(['Message Content']));
    expect(effective['Message Content']).toBe(false);
    expect(effective['Guild Messages']).toBe(true);
  });

  it('omits privileged intent when portal-disabled even if required', () => {
    const warnings: string[] = [];
    const config: JsBotConfig = {
      ...baseConfig,
      events: [{ id: '1', enabled: true, script: 'module.exports = async () => {}', name: 'guildMemberAdd' }],
    };

    const effective = buildEffectiveIntentsMap(config, new Set(), warnings);
    expect(effective['Guild Members']).toBe(false);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('does not enable privileged intent when portal on but not required', () => {
    const effective = buildEffectiveIntentsMap(
      baseConfig,
      new Set(['Message Content', 'Guild Members']),
    );
    expect(effective['Message Content']).toBe(false);
    expect(effective['Guild Members']).toBe(false);
  });
});

describe('buildSafeFallbackIntentsMap', () => {
  it('forces privileged intents off when portal sync fails', () => {
    const warnings: string[] = [];
    const effective = buildSafeFallbackIntentsMap(baseConfig, warnings);
    expect(effective['Message Content']).toBe(false);
    expect(effective['Guild Members']).toBe(false);
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe('mapIntents', () => {
  it('maps Guild Expressions alias to emoji intent bit', () => {
    const bits = mapIntents({ 'Guild Expressions': true })[0];
    expect(bits & GatewayIntentBits.GuildEmojisAndStickers).not.toBe(0);
  });

  it('includes privileged bits only when effective map is true', () => {
    const withContent = mapIntents({ 'Message Content': true })[0];
    const withoutContent = mapIntents({ 'Message Content': false })[0];
    expect(withContent & GatewayIntentBits.MessageContent).not.toBe(0);
    expect(withoutContent & GatewayIntentBits.MessageContent).toBe(0);
  });
});

describe('intentsMapsEqual', () => {
  it('compares intent maps by value', () => {
    expect(intentsMapsEqual({ 'Message Content': true }, { 'Message Content': true })).toBe(true);
    expect(intentsMapsEqual({ 'Message Content': true }, { 'Message Content': false })).toBe(
      false,
    );
  });
});
