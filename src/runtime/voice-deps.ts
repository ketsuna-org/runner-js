import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import * as voice from '@discordjs/voice';

/** Three-state availability for a native/optional dependency. */
export type DependencyState = 'present' | 'missing' | 'unknown';

export type VoiceDependencyStatus = {
  available: boolean;
  version?: string;
  report?: string;
  /** True only when DAVE is confirmed present. Kept for backward compatibility. */
  davey: boolean;
  daveyState: DependencyState;
  daveyVersion?: string;
  error?: string;
};

const DAVEY_PACKAGE = '@snazzah/davey';

const DAVEY_REPORT_PATTERN = /@snazzah\/davey:\s*(?!not found)(\S+)/i;

let cachedStatus: VoiceDependencyStatus | null = null;

/**
 * Resolve the installed version of a package using Bun's resolver, then read the
 * matching package.json. Returns undefined when the package cannot be resolved or
 * the version cannot be read. Never treats a resolution failure as "absent".
 */
function resolveInstalledVersion(name: string): string | undefined {
  const resolveSync = (globalThis as { Bun?: { resolveSync?: typeof Bun.resolveSync } }).Bun
    ?.resolveSync;
  if (typeof resolveSync !== 'function') {
    return undefined;
  }

  let entry: string;
  try {
    entry = resolveSync(name, import.meta.dir);
  } catch {
    return undefined;
  }

  let dir = dirname(entry);
  for (;;) {
    const manifestPath = join(dir, 'package.json');
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
          name?: string;
          version?: string;
        };
        if (manifest.name === name && typeof manifest.version === 'string') {
          return manifest.version;
        }
      } catch {
        // Unreadable manifest: keep walking up the tree.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

/**
 * Attempt to load DAVE for real. Includes the native binding so a broken install
 * is reported as missing instead of silently falling through.
 */
async function isDaveyLoadable(): Promise<boolean> {
  try {
    await import(DAVEY_PACKAGE);
    return true;
  } catch {
    return false;
  }
}

function readDependencyReport(): string | undefined {
  try {
    return voice.generateDependencyReport();
  } catch {
    return undefined;
  }
}

type DaveyResolution = { state: DependencyState; version?: string };

/**
 * Resolve the DAVE state without trusting the dependency report: the report is
 * unreliable in compiled/pod builds where node_modules is not embedded and every
 * line reads "not found".
 */
function resolveDavey(report: string | undefined): DaveyResolution {
  const resolvedVersion = resolveInstalledVersion(DAVEY_PACKAGE);
  if (resolvedVersion) {
    return { state: 'present', version: resolvedVersion };
  }

  const reportMatch = report?.match(DAVEY_REPORT_PATTERN);
  if (reportMatch?.[1]) {
    return { state: 'present', version: reportMatch[1] };
  }

  // Resolution failed: this is inconclusive, not proof of absence.
  return { state: 'unknown' };
}

export function getVoiceDependencyStatus(): VoiceDependencyStatus {
  if (cachedStatus) {
    return cachedStatus;
  }

  try {
    const report = readDependencyReport();
    const davey = resolveDavey(report);

    cachedStatus = {
      available: true,
      version: voice.version,
      report,
      davey: davey.state === 'present',
      daveyState: davey.state,
      daveyVersion: davey.version,
    };
  } catch (error) {
    cachedStatus = {
      available: false,
      davey: false,
      daveyState: 'unknown',
      error: error instanceof Error ? error.message : String(error),
    };
  }

  return cachedStatus;
}

export async function logVoiceDependencyStatus(
  log: (level: 'info' | 'warn' | 'error' | 'debug', message: string) => void,
): Promise<VoiceDependencyStatus> {
  let status = getVoiceDependencyStatus();

  if (!status.available) {
    log('warn', `Voice dependencies unavailable: ${status.error ?? 'unknown error'}`);
    return status;
  }

  if (status.daveyState === 'unknown') {
    const loadable = await isDaveyLoadable();
    status = cachedStatus = {
      ...status,
      davey: loadable,
      daveyState: loadable ? 'present' : 'missing',
    };
  }

  log('info', `@discordjs/voice ${status.version ?? 'unknown'} ready`);
  log(
    'info',
    status.daveyState === 'present'
      ? `DAVE library ${DAVEY_PACKAGE} ${status.daveyVersion ?? ''} ready`.trim()
      : `DAVE library ${DAVEY_PACKAGE} status: ${status.daveyState}`,
  );

  if (status.report) {
    for (const line of status.report.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) {
        log('debug', `[VoiceDeps] ${trimmed}`);
      }
    }
  }

  if (status.daveyState === 'missing') {
    log(
      'warn',
      `DAVE library ${DAVEY_PACKAGE} is missing — Discord voice joins will fail with reconnect loops (close code 4017).`,
    );
  }

  return status;
}

export function resetVoiceDependencyStatusCacheForTests(): void {
  cachedStatus = null;
}
