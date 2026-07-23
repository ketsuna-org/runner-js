import { startMainServer } from './main-server.js';
import { logFfmpegStatus } from './runtime/ffmpeg-setup.js';
import { logVoiceDependencyStatus } from './runtime/voice-deps.js';

const log = (level: 'info' | 'warn' | 'error' | 'debug', message: string) => {
  console[level === 'info' || level === 'debug' ? 'log' : 'warn'](`[runner] ${message}`);
};
logFfmpegStatus(log);
logVoiceDependencyStatus(log);

startMainServer().catch((error) => {
  console.error('[FATAL]', error);
  process.exit(1);
});
