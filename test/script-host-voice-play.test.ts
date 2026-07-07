import { describe, expect, it } from 'vitest';

import { assertValidAudioResourceForPlay } from '../src/scripts/script-host-voice-play.js';

describe('script-host-voice-play', () => {
  it('rejects empty objects that come from un-awaited createAudioResource calls', () => {
    expect(() => assertValidAudioResourceForPlay({})).toThrow(/await createAudioResource/i);
    expect(() => assertValidAudioResourceForPlay(null)).toThrow(/await createAudioResource/i);
  });

  it('accepts resources with a playStream', () => {
    expect(() =>
      assertValidAudioResourceForPlay({ playStream: {} }),
    ).not.toThrow();
  });
});
