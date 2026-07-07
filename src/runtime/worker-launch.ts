import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function isPkgRuntime(): boolean {
  if ('pkg' in process) {
    return true;
  }

  const executable = path.basename(process.execPath).toLowerCase();
  return executable.includes('bot-creator-runner-js');
}

export function shouldSpawnWorkerProcess(launch: {
  executable: string;
  args: string[];
}): boolean {
  return isPkgRuntime() || launch.executable.toLowerCase().endsWith('.exe');
}

export function resolveWorkerLaunch(): { executable: string; args: string[] } {
  if (isPkgRuntime()) {
    // PKG on Windows mis-parses `--bot-worker` as a script path when passed via argv.
    // Worker mode is selected through BOT_CREATOR_WORKER_MODE in the child env.
    return {
      executable: process.execPath,
      args: [],
    };
  }

  // Fork the main entrypoint in worker mode (BOT_CREATOR_WORKER_MODE=1 in child env).
  // bot-worker.js only exports runBotWorker() and never auto-starts when forked directly.
  return {
    executable: path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      'index.js',
    ),
    args: [],
  };
}
