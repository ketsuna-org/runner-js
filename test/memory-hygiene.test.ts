import { describe, expect, it } from 'vitest';

import { readResponseBodyCapped } from '../src/runtime/memory-hygiene.js';

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
