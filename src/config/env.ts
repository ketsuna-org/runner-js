import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import packageJson from '../../package.json' with { type: 'json' };

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

// The bundled package.json is imported statically so Bun inlines it into the
// compiled binary. This is required because `bun build --compile` runs from a
// virtual filesystem ($bunfs/root/...) where `../../package.json` does not
// exist, so a runtime readFileSync() would always fail and report 'unknown'.
const bundledVersion: string =
  typeof packageJson.version === 'string' ? packageJson.version : '';

function versionFromPackageFile(): string {
  try {
    const pkgPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'package.json',
    );
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return typeof pkg.version === 'string' ? pkg.version : '';
  } catch {
    return '';
  }
}

function resolveVersion(): string {
  // 1. Build/runtime override, useful to pin a version without rebuilding.
  const fromEnv = (process.env.BOT_CREATOR_RUNNER_VERSION ?? '').trim();
  if (fromEnv.length > 0) {
    return fromEnv;
  }

  // 2. Version bundled at compile time from package.json (works in --compile).
  if (bundledVersion.length > 0) {
    return bundledVersion;
  }

  // 3. Read package.json from disk when running from source.
  const fromFile = versionFromPackageFile();
  if (fromFile.length > 0) {
    return fromFile;
  }

  // 4. Last resort: the version genuinely cannot be determined. We return a
  // stable sentinel instead of throwing so the runner still starts and the
  // health endpoint stays reachable for diagnostics.
  return 'unknown';
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
