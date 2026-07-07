import { describe, expect, it } from 'vitest';

import {
  assertHttpOrDataUrl,
  assertHttpUrl,
  isBlockedLocalPath,
} from '../src/scripts/script-host-path.js';

describe('script-host-path', () => {
  it('detects local filesystem paths', () => {
    expect(isBlockedLocalPath('/etc/passwd')).toBe(true);
    expect(isBlockedLocalPath('./secret.mp3')).toBe(true);
    expect(isBlockedLocalPath('../etc/passwd')).toBe(true);
    expect(isBlockedLocalPath('file:///etc/passwd')).toBe(true);
    expect(isBlockedLocalPath('C:\\Windows\\System32')).toBe(true);
    expect(isBlockedLocalPath('~/secrets/key.pem')).toBe(true);
  });

  it('allows remote URLs', () => {
    expect(isBlockedLocalPath('https://example.com/audio.mp3')).toBe(false);
    expect(isBlockedLocalPath('http://example.com/image.png')).toBe(false);
    expect(isBlockedLocalPath('data:image/png;base64,abc')).toBe(false);
  });

  it('throws for non-http URLs in assertHttpUrl', () => {
    expect(() => assertHttpUrl('/etc/passwd', 'createAudioResource')).toThrow(
      /local file paths are blocked/i,
    );
  });

  it('throws for local paths in assertHttpOrDataUrl', () => {
    expect(() => assertHttpOrDataUrl('/etc/passwd', 'loadImage')).toThrow(
      /local file paths are blocked/i,
    );
  });
});
