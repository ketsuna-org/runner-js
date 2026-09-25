/**
 * Memory helpers for the runner process.
 *
 * With 1 bot = 1 pod, the Kubernetes cgroup memory limit is the hard ceiling
 * (OOMKill). There is no in-process soft/critical RSS exit — the kubelet
 * restarts the pod when the limit is hit. Fetch body caps still protect
 * against unbounded script-side downloads.
 */

/** Max bytes allowed for script-side fetch() response bodies. */
export const MAX_FETCH_BODY_BYTES = 10 * 1024 * 1024;

/**
 * Reads a fetch Response body with a hard byte cap.
 * Rejects early on Content-Length, otherwise streams until the limit.
 */
export async function readResponseBodyCapped(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const contentLengthHeader = response.headers.get('content-length');
  if (contentLengthHeader) {
    const contentLength = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new Error(
        `fetch: response body exceeds ${maxBytes} byte limit (Content-Length: ${contentLength})`,
      );
    }
  }

  if (!response.body) {
    // Response-like mocks (and some polyfills) expose text() without a ReadableStream body.
    if (typeof response.text === 'function') {
      const text = await response.text();
      const byteLength = new TextEncoder().encode(text).byteLength;
      if (byteLength > maxBytes) {
        throw new Error(`fetch: response body exceeds ${maxBytes} byte limit`);
      }
      return text;
    }
    return '';
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`fetch: response body exceeds ${maxBytes} byte limit`);
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // ignore cancel errors after a failed read
    }
    throw error;
  }

  return chunks.join('');
}

/**
 * Reads a fetch Response body as bytes with a hard cap.
 *
 * Same contract as {@link readResponseBodyCapped}, for the readers that do not
 * go through `text()`.
 */
export async function readResponseBytesCapped(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const contentLengthHeader = response.headers.get('content-length');
  if (contentLengthHeader) {
    const contentLength = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new Error(
        `fetch: response body exceeds ${maxBytes} byte limit (Content-Length: ${contentLength})`,
      );
    }
  }

  if (!response.body) {
    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > maxBytes) {
      throw new Error(`fetch: response body exceeds ${maxBytes} byte limit`);
    }
    return new Uint8Array(arrayBuffer);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`fetch: response body exceeds ${maxBytes} byte limit`);
      }
      chunks.push(value);
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // ignore cancel errors after a failed read
    }
    throw error;
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/**
 * Copies the capped bytes into a plain `ArrayBuffer`.
 *
 * `BodyInit`/`BlobPart` want an `ArrayBuffer`, and a typed-array view's `buffer`
 * is `ArrayBufferLike` (it may be a `SharedArrayBuffer`): hence the copy. The
 * body is bounded by the cap, so the copy is bounded too.
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

/**
 * Wraps a fetch so script-side response bodies are bounded.
 *
 * The cap was written for exactly this and wired NOWHERE, so a script could
 * download an unbounded body and take the whole node down with it — the node
 * hosts every bot of the process (an OOM kill is not limited to the bot that
 * misbehaved). The readers that consume the body are capped here.
 *
 * SCOPE, stated honestly: `response.body` (the raw stream) is NOT capped — a
 * script that reads the stream itself keeps the raw, unbounded behaviour. This
 * bounds the ordinary reads (`text`, `json`, `arrayBuffer`, `blob`,
 * `formData`), which is what script-side fetches actually use; it is not a
 * sandbox.
 */
export function createCappedFetch(
  fetchImpl: typeof fetch,
  maxBytes: number = MAX_FETCH_BODY_BYTES,
): typeof fetch {
  const cappedFetch = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const response = await fetchImpl(input, init);

    return new Proxy(response, {
      get(target, property, receiver) {
        switch (property) {
          case 'text':
            return () => readResponseBodyCapped(target, maxBytes);
          case 'json':
            return async () => JSON.parse(await readResponseBodyCapped(target, maxBytes));
          case 'arrayBuffer':
            return async () => toArrayBuffer(await readResponseBytesCapped(target, maxBytes));
          case 'blob':
            return async () =>
              new Blob([toArrayBuffer(await readResponseBytesCapped(target, maxBytes))], {
                type: target.headers.get('content-type') ?? '',
              });
          case 'formData': {
            return async () => {
              const buffer = toArrayBuffer(await readResponseBytesCapped(target, maxBytes));
              // A fresh Response: the native formData() would read the (already
              // consumed) body of the original, uncapped.
              return new Response(buffer, { headers: target.headers }).formData();
            };
          }
          case 'clone':
            return () => {
              throw new Error(
                'fetch: clone() is disabled because its body would bypass the size cap',
              );
            };
          default: {
            // The receiver must be the TARGET, not the proxy: the native
            // getters (`status`, `body`, ...) refuse to run on anything but a
            // real Response ("The Response.status getter can only be used on
            // instances of Response").
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
          }
        }
      },
    });
  };

  return cappedFetch as typeof fetch;
}
