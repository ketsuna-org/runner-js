import { describe, expect, it, vi } from 'vitest';

import {
  assertAllowedFontSource,
  registerRemoteFont,
} from '../src/scripts/script-host-remote-font.js';

describe('script-host-remote-font', () => {
  it('blocks local font paths before fetching', () => {
    expect(() => assertAllowedFontSource('/etc/passwd')).toThrow(/local file paths are blocked/i);
    expect(() => assertAllowedFontSource('/app/package.json')).toThrow(/local file paths are blocked/i);
  });

  it('downloads http font URLs to a temp file before registering', async () => {
    const registerFont = vi.fn();
    const fontBytes = Buffer.from([0x00, 0x01, 0x00, 0x00]);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        arrayBuffer: async () => fontBytes,
      })),
    );

    await registerRemoteFont(registerFont, 'https://example.com/fonts/custom.ttf', {
      family: 'Custom',
    });

    vi.unstubAllGlobals();

    expect(registerFont).toHaveBeenCalledTimes(1);
    expect(registerFont.mock.calls[0]?.[0]).toMatch(/\.ttf$/);
    expect(registerFont.mock.calls[0]?.[1]).toEqual({ family: 'Custom' });
  });
});
