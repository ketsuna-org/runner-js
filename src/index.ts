import { startMainServer } from './main-server.js';
import { runBotWorker } from './worker/bot-worker.js';

const isBotWorker = process.env.BOT_CREATOR_WORKER_MODE === '1';

if (isBotWorker) {
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
