import {
  buildWorkerNodeOptions,
  DEFAULT_WORKER_MAX_HEAP_MB,
  parsePositiveIntEnv,
} from './memory-hygiene.js';

const WORKER_INHERITED_ENV_KEYS = [
  'BOT_CREATOR_MANAGED_RUNNER_API',
  'BOT_CREATOR_MANAGED_RUNNER_TOKEN',
  'BOT_CREATOR_WORKER_RSS_RESTART_MB',
  'BOT_CREATOR_WORKER_RSS_RESTART_CHECKS',
  'BOT_CREATOR_WORKER_RSS_RESTART_MIN_UPTIME_MS',
] as const;

export function buildWorkerProcessEnv(
  botId: string,
  dataDir: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    BOT_CREATOR_BOT_ID: botId,
    BOT_CREATOR_DATA_DIR: dataDir,
    BOT_CREATOR_WORKER_MODE: '1',
  };

  for (const key of WORKER_INHERITED_ENV_KEYS) {
    const value = process.env[key];
    if (value) {
      env[key] = value;
    }
  }

  for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) {
    const value = process.env[key];
    if (value) {
      env[key] = value;
    }
  }

  const maxHeapMb = parsePositiveIntEnv(
    process.env.BOT_CREATOR_WORKER_MAX_HEAP_MB,
    DEFAULT_WORKER_MAX_HEAP_MB,
  );
  const nodeOptions = buildWorkerNodeOptions(process.env.NODE_OPTIONS, maxHeapMb);
  if (nodeOptions) {
    env.NODE_OPTIONS = nodeOptions;
  }

  return env;
}
