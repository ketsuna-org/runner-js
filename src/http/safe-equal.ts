import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Constant-time string comparison for credentials (API token, webhook secret).
 * Both sides are hashed first so the comparison always runs on 32 bytes and the
 * length of the expected secret does not leak through timing either.
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}
