import { startMainServer } from './main-server.js';
import { logFfmpegStatus } from './runtime/ffmpeg-setup.js';
import { logVoiceDependencyStatus } from './runtime/voice-deps.js';
import { runBotWorker } from './worker/bot-worker.js';

const isBotWorker = process.env.BOT_CREATOR_WORKER_MODE === '1';

if (isBotWorker) {
  const log = (level: 'info' | 'warn' | 'error' | 'debug', message: string) => {
    console[level === 'info' || level === 'debug' ? 'log' : 'warn'](`[runner] ${message}`);
  };
  logFfmpegStatus(log);
  logVoiceDependencyStatus(log);
  runBotWorker().catch((error) => {
    console.error('[FATAL]', error);
    process.exit(1);
  });
} else {
  startMainServer().catch((error) => {
    console.error('[FATAL]', error);
    process.exit(1);
  });
}
