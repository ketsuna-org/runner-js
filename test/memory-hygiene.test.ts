import { describe, expect, it } from 'bun:test';

import {
  createCappedFetch,
  readResponseBodyCapped,
} from '../src/runtime/memory-hygiene.js';

describe('readResponseBodyCapped', () => {
  it('rejects early when Content-Length exceeds the limit', async () => {
    const response = new Response('ignored', {
      headers: { 'content-length': '100' },
    });
    await expect(readResponseBodyCapped(response, 50)).rejects.toThrow(
      /Content-Length: 100/,
    );
  });

  it('returns the body when under the limit', async () => {
    const response = new Response('hello world', {
      headers: { 'content-length': '11' },
    });
    await expect(readResponseBodyCapped(response, 100)).resolves.toBe('hello world');
  });

  it('falls back to text() when Response has no body stream', async () => {
    const response = {
      headers: new Headers(),
      body: null,
      text: async () => '{"hello":"world"}',
    } as unknown as Response;
    await expect(readResponseBodyCapped(response, 100)).resolves.toBe('{"hello":"world"}');
  });

  it('cuts off when the streamed body exceeds the limit', async () => {
    const encoder = new TextEncoder();
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled <= 3) {
          controller.enqueue(encoder.encode('abcdefghij'));
          return;
        }
        controller.close();
      },
    });
    const response = new Response(stream);
    await expect(readResponseBodyCapped(response, 25)).rejects.toThrow(
      /exceeds 25 byte limit/,
    );
  });
});

describe('createCappedFetch', () => {
  const bigBody = 'x'.repeat(200);

  it('caps text(), json() and arrayBuffer() at the limit', async () => {
    const fakeFetch = (async () => new Response(bigBody)) as unknown as typeof fetch;
    const capped = createCappedFetch(fakeFetch, 50);

    await expect(capped('http://example.test').then((r) => r.text())).rejects.toThrow(
      /exceeds 50 byte limit/,
    );
    await expect(capped('http://example.test').then((r) => r.json())).rejects.toThrow(
      /exceeds 50 byte limit/,
    );
    await expect(
      capped('http://example.test').then((r) => r.arrayBuffer()),
    ).rejects.toThrow(/exceeds 50 byte limit/);
  });

  it('lets a body under the limit through, unchanged', async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    const capped = createCappedFetch(fakeFetch, 1024);

    const response = await capped('http://example.test');
    expect(await response.json()).toEqual({ ok: true });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
  });

  it('refuses clone(), whose body would bypass the cap', async () => {
    const fakeFetch = (async () => new Response('hello')) as unknown as typeof fetch;
    const capped = createCappedFetch(fakeFetch, 1024);

    const response = await capped('http://example.test');
    expect(() => response.clone()).toThrow(/clone\(\) is disabled/);
  });

  // La portée du garde-fou, dite franchement : ce n'est PAS un bac à sable.
  it('does not cap the raw body stream (documented limit, not a sandbox)', async () => {
    const fakeFetch = (async () => new Response(bigBody)) as unknown as typeof fetch;
    const capped = createCappedFetch(fakeFetch, 50);

    const response = await capped('http://example.test');
    const raw = await new Response(response.body).text();
    expect(raw.length).toBe(200);
  });
});
