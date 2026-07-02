import { startMainServer } from './main-server.js';

const isBotWorker = process.argv.includes('--bot-worker');

if (isBotWorker) {
  await import('./worker/bot-worker.js');
} else {
  startMainServer().catch((error) => {
    console.error('[FATAL]', error);
    process.exit(1);
  });
}
