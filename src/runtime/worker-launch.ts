import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function isPkgRuntime(): boolean {
  return Boolean((process as NodeJS.Process & { pkg?: unknown }).pkg);
}

export function resolveWorkerLaunch(): { executable: string; args: string[] } {
  if (isPkgRuntime()) {
    return {
      executable: process.execPath,
      args: ['--bot-worker'],
    };
  }

  return {
    executable: process.execPath,
    args: [
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        '..',
        'worker',
        'bot-worker.js',
      ),
    ],
  };
}
