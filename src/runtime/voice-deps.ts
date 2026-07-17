import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const moduleRequire = createRequire(fileURLToPath(import.meta.url));

export type VoiceDependencyStatus = {
  available: boolean;
  version?: string;
  report?: string;
  davey: boolean;
  error?: string;
};

let cachedStatus: VoiceDependencyStatus | null = null;

export function getVoiceDependencyStatus(): VoiceDependencyStatus {
  if (cachedStatus) {
    return cachedStatus;
  }

  try {
    const voice = moduleRequire('@discordjs/voice') as typeof import('@discordjs/voice');
    const report = voice.generateDependencyReport();
    let davey = /@snazzah\/davey:\s*(?!not found)\S+/i.test(report);

    if (!davey) {
      try {
        moduleRequire('@snazzah/davey');
        davey = true;
      } catch {
        davey = false;
      }
    }

    cachedStatus = {
      available: true,
      version: voice.version,
      report,
      davey,
    };
  } catch (error) {
    cachedStatus = {
      available: false,
      davey: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  return cachedStatus;
}

export function logVoiceDependencyStatus(
  log: (level: 'info' | 'warn' | 'error' | 'debug', message: string) => void,
): VoiceDependencyStatus {
  const status = getVoiceDependencyStatus();

  if (!status.available) {
    log('warn', `Voice dependencies unavailable: ${status.error ?? 'unknown error'}`);
    return status;
  }

  log('info', `@discordjs/voice ${status.version ?? 'unknown'} ready`);
  if (status.report) {
    for (const line of status.report.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) {
        log('info', `[VoiceDeps] ${trimmed}`);
      }
    }
  }

  if (!status.davey) {
    log(
      'warn',
      'DAVE library @snazzah/davey is missing — Discord voice joins will fail with reconnect loops (close code 4017).',
    );
  }

  return status;
}
