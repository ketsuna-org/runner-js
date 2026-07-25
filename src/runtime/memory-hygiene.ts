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
