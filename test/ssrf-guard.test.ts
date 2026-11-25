import { describe, expect, it } from 'bun:test';

import { createCappedFetch } from '../src/runtime/memory-hygiene.js';
import { createSsrfGuardedFetch } from '../src/runtime/ssrf-guard.js';

const assertPublic = async (host: string): Promise<void> => {
  if (host === 'internal.test' || host === '127.0.0.1') throw new Error('refused');
};

describe('createSsrfGuardedFetch', () => {
  it('refuses private hosts and non-http schemes', async () => {
    const f = createSsrfGuardedFetch((async () => new Response('x')) as never, assertPublic);
    await expect(f('http://internal.test/')).rejects.toThrow('not allowed');
    await expect(f('file:///etc/passwd')).rejects.toThrow('http(s)');
    expect(await (await f('https://ok.test/')).text()).toBe('x');
  });

  it('re-checks every redirect hop', async () => {
    const seen: string[] = [];
    const impl = (async (url: URL) => {
      seen.push(url.href);
      return new Response(null, { status: 302, headers: { location: 'http://internal.test/secret' } });
    }) as never;
    const f = createSsrfGuardedFetch(impl, assertPublic);
    await expect(f('https://ok.test/')).rejects.toThrow('not allowed');
    expect(seen).toEqual(['https://ok.test/']);
  });
});

describe('createCappedFetch body stream', () => {
  it('bounds the raw response.body stream', async () => {
    const f = createCappedFetch((async () => new Response('x'.repeat(100))) as never, 10);
    const res = await f('http://a.test');
    await expect(new Response(res.body).text()).rejects.toThrow('byte limit');
  });
});
