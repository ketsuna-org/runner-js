import { describe, expect, it } from 'vitest';

import { ensureFfmpegAvailable } from '../src/runtime/ffmpeg-setup.js';

describe('ffmpeg-setup', () => {
  it('detects bundled ffmpeg-static when available', () => {
    const status = ensureFfmpegAvailable();
    if (status.available) {
      expect(status.command).toContain('ffmpeg');
      expect(status.version).toBeTruthy();
    } else {
      expect(status.error).toBeTruthy();
    }
  });
});
