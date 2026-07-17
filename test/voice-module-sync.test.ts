import { describe, expect, it } from 'vitest';

import { isSyncModuleFunction } from '../src/scripts/script-host-sync.js';

describe('voice module sync classification', () => {
  it('treats joinVoiceChannel as async so callers can await Ready', () => {
    expect(isSyncModuleFunction('module:voice', 'joinVoiceChannel')).toBe(false);
    expect(isSyncModuleFunction('module:voice', 'joinVoiceChannelReady')).toBe(false);
    expect(isSyncModuleFunction('module:voice', 'createAudioPlayer')).toBe(true);
    expect(isSyncModuleFunction('module:voice', 'getVoiceConnection')).toBe(true);
  });
});
