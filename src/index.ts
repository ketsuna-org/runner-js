import './runtime/bun-compat.js';
import { startMainServer } from './main-server.js';
import { logFfmpegStatus } from './runtime/ffmpeg-setup.js';
import { perfSettings } from './runtime/perf.js';
import { logVoiceDependencyStatus } from './runtime/voice-deps.js';

const log = (level: 'info' | 'warn' | 'error' | 'debug', message: string) => {
  console[level === 'info' || level === 'debug' ? 'log' : 'warn'](`[runner] ${message}`);
};
// Mesure par exécution (lignes `perf`, audience internal) : éteinte par défaut, voir runtime/perf.ts.
perfSettings.configureFromEnv();
logFfmpegStatus(log);
await logVoiceDependencyStatus(log);

startMainServer().catch((error) => {
  console.error('[FATAL]', error);
  process.exit(1);
});
