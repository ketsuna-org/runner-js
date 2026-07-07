import prism from 'prism-media';

export interface FfmpegStatus {
  available: boolean;
  command?: string;
  version?: string;
  libopus?: boolean;
  error?: string;
}

let cachedStatus: FfmpegStatus | null = null;

export function ensureFfmpegAvailable(): FfmpegStatus {
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
