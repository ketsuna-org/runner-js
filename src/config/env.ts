import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export interface RunnerEnv {
  webHost: string;
  webPort: number;
  apiToken: string;
  dataDir: string;
  logFile: string;
  poolMode: boolean;
  poolMaxBots: number;
  runnerNodeId: string;
  managedRunnerApi: string;
  managedRunnerToken: string;
  version: string;
}

function envOrDefault(key: string, fallback: string): string {
  const value = (process.env[key] ?? '').trim();
  return value.length > 0 ? value : fallback;
}

function resolveVersion(): string {
  try {
    const pkgPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'package.json',
    );
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export function isManagedRunner(
  env: Pick<RunnerEnv, 'managedRunnerApi' | 'managedRunnerToken'>,
): boolean {
  return env.managedRunnerApi.trim().length > 0 && env.managedRunnerToken.trim().length > 0;
}

export function loadRunnerEnv(): RunnerEnv {
  const poolMaxRaw = envOrDefault('BOT_CREATOR_POOL_MAX_BOTS', '40');
  const poolMaxBots = Number.parseInt(poolMaxRaw, 10);

  return {
    webHost: envOrDefault('BOT_CREATOR_WEB_HOST', '127.0.0.1'),
    webPort: Number.parseInt(envOrDefault('BOT_CREATOR_WEB_PORT', '8080'), 10),
    apiToken: envOrDefault('BOT_CREATOR_API_TOKEN', ''),
    dataDir: envOrDefault('BOT_CREATOR_DATA_DIR', './data/bots'),
    logFile: envOrDefault('BOT_CREATOR_RUNNER_LOG_FILE', './data/logs/runner.log'),
    poolMode: ['true', '1'].includes(
      envOrDefault('BOT_CREATOR_POOL_MODE', '').toLowerCase(),
    ),
    poolMaxBots: Number.isFinite(poolMaxBots) ? poolMaxBots : 40,
    runnerNodeId: envOrDefault('BOT_CREATOR_RUNNER_NODE_ID', ''),
    managedRunnerApi: envOrDefault('BOT_CREATOR_MANAGED_RUNNER_API', ''),
    managedRunnerToken: envOrDefault('BOT_CREATOR_MANAGED_RUNNER_TOKEN', ''),
    version: resolveVersion(),
  };
}

export function normalizeRunnerApiToken(value: string | undefined): string {
  return (value ?? '').trim();
}

export function isRunnerLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (!normalized || normalized === 'localhost') {
    return true;
  }

  const unwrapped =
    normalized.startsWith('[') && normalized.endsWith(']')
      ? normalized.slice(1, -1)
      : normalized;

  if (unwrapped === '127.0.0.1' || unwrapped === '::1') {
    return true;
  }

  return false;
}

export function validateRunnerWebConfiguration(env: RunnerEnv): string | null {
  if (!isRunnerLoopbackHost(env.webHost) && env.apiToken.length === 0) {
    return 'BOT_CREATOR_API_TOKEN is required when binding the runner to a non-loopback host.';
  }
  return null;
}

export function runnerPackageRoot(): string {
  return path.dirname(fileURLToPath(new URL('../../package.json', import.meta.url)));
}
