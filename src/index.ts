import { startMainServer } from './main-server.js';
import { logFfmpegStatus } from './runtime/ffmpeg-setup.js';
import { runBotWorker } from './worker/bot-worker.js';

const isBotWorker = process.env.BOT_CREATOR_WORKER_MODE === '1';

if (isBotWorker) {
  logFfmpegStatus((level, message) => {
    console[level === 'info' ? 'log' : 'warn'](`[runner] ${message}`);
  });
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
