import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import prism from 'prism-media';

export interface FfmpegStatus {
  available: boolean;
  command?: string;
  version?: string;
  libopus?: boolean;
  error?: string;
}

let cachedStatus: FfmpegStatus | null = null;
let configuredPath = false;

export function configureFfmpegPath(): void {
  if (configuredPath || process.env.FFMPEG_PATH) {
    configuredPath = true;
    return;
  }

  configuredPath = true;
  try {
    const moduleRequire = createRequire(fileURLToPath(import.meta.url));
    const ffmpegPath = moduleRequire('ffmpeg-static') as string | null;
    if (typeof ffmpegPath === 'string' && ffmpegPath.length > 0) {
      process.env.FFMPEG_PATH = ffmpegPath;
    }
  } catch {
    // Ignore missing ffmpeg-static in this environment.
  }
}

export function ensureFfmpegAvailable(): FfmpegStatus {
  configureFfmpegPath();

  if (cachedStatus) {
    return cachedStatus;
  }

  try {
    const info = prism.FFmpeg.getInfo();
    cachedStatus = {
      available: true,
      command: info.command,
      version: info.version,
      libopus: info.output.includes('--enable-libopus'),
    };
    return cachedStatus;
  } catch (error) {
    cachedStatus = {
      available: false,
      error: error instanceof Error ? error.message : String(error),
    };
    return cachedStatus;
  }
}

export function logFfmpegStatus(
  log: (level: 'info' | 'warn', message: string) => void,
): FfmpegStatus {
  const status = ensureFfmpegAvailable();
  if (status.available) {
    log(
      'info',
      `FFmpeg ${status.version} ready (${status.command})${status.libopus ? ', libopus enabled' : ''}`,
    );
  } else {
    log(
      'warn',
      `FFmpeg unavailable: ${status.error ?? 'unknown error'}. Remote audio URLs require ffmpeg-static.`,
    );
  }
  return status;
}

export function resetFfmpegStatusCacheForTests(): void {
  cachedStatus = null;
}
