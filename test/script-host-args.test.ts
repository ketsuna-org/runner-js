import { describe, expect, it } from 'vitest';

import { assertAllowedHostInvokeArgs } from '../src/scripts/script-host-args.js';

describe('script-host-args', () => {
  it('blocks local file paths in Discord attachment payloads', () => {
    expect(() =>
      assertAllowedHostInvokeArgs([{ files: ['/app/package.json'] }]),
    ).toThrow(/local file paths are blocked/i);

    expect(() =>
      assertAllowedHostInvokeArgs([{ files: [{ attachment: '/etc/passwd', name: 'x.txt' }] }]),
    ).toThrow(/local file paths are blocked/i);
  });

  it('allows http attachment URLs and regular message content', () => {
    expect(() =>
      assertAllowedHostInvokeArgs([
        { content: '/app/package.json is a path in text only' },
      ]),
    ).not.toThrow();

    expect(() =>
      assertAllowedHostInvokeArgs([
        { files: ['https://example.com/file.png'] },
      ]),
    ).not.toThrow();
  });
});
