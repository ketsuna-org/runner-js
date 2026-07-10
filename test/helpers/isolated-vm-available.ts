import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export function isIsolatedVmAvailable(): boolean {
  try {
    require('isolated-vm');
    return true;
  } catch {
    return false;
  }
}

export const isolatedVmAvailable = isIsolatedVmAvailable();
