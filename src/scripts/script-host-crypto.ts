import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';

import type { ModuleRegistry } from './script-host-modules.js';

const HASH_METHODS = ['update', 'digest', 'copy', 'setEncoding', 'getEncoding'] as const;
const HMAC_METHODS = ['update', 'digest', 'copy', 'setEncoding', 'getEncoding'] as const;

export function buildCryptoModule(wrapHostResult: ModuleRegistry['wrapHostResult']) {
  return {
    randomBytes: (size: number) => Array.from(randomBytes(size)),
    randomUUID: () => randomUUID(),
    randomInt: (min: number, max: number) => randomInt(min, max),
    createHash: (algorithm: string) =>
      wrapHostResult(createHash(algorithm), 'crypto-hash', HASH_METHODS, () => ({})),
    createHmac: (algorithm: string, key: string | Uint8Array) =>
      wrapHostResult(createHmac(algorithm, key), 'crypto-hmac', HMAC_METHODS, () => ({})),
    timingSafeEqual: (a: Uint8Array | ArrayLike<number>, b: Uint8Array | ArrayLike<number>) => {
      const left = Buffer.from(a as never);
      const right = Buffer.from(b as never);
      return timingSafeEqual(left, right);
    },
  };
}
