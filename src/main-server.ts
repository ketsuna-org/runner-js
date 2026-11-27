import { installGuildAlertsApi } from './runtime/alerts/guild-alerts-api.js';
import { join } from 'node:path';
import { ManagedAiGateway } from './ai/ai-gateway.js';
import { ManagedDocumentsGateway, setDocumentsGateway } from './documents/documents-gateway.js';
import { LocalDocumentsGateway } from './documents/local-documents.js';
import { ManagedFilesGateway } from './files/files-gateway.js';
import { ManagedVoiceQuotaGateway } from './runtime/voice/voice-quota.js';
import { LocalFilesGateway } from './files/local-files-gateway.js';
import { loadRunnerEnv, validateRunnerWebConfiguration } from './config/env.js';
import { createHttpServer } from './http/server.js';
import { bootstrapFromPool } from './pool/bootstrap.js';
import { CommandStatsShipper, setCommandStatsShipper } from './runtime/command-stats-shipper.js';
import { LogShipper } from './runtime/log-shipper.js';
import { LogStore } from './runtime/log-store.js';
import { RuntimeController } from './runtime/runtime-controller.js';

export async function startMainServer(): Promise<void> {
  const env = loadRunnerEnv();
  const validationError = validateRunnerWebConfiguration(env);
  if (validationError) {
    console.error(validationError);
    process.exit(1);
  }

  const logStore = new LogStore(env.logFile);
  await logStore.init();

  // Journal durable: avec un Manager (runner géré ou pool), les lignes partent aussi par lots vers lui.
  let logShipper: LogShipper | null = null;
  let statsShipper: CommandStatsShipper | null = null;
  if (env.managedRunnerApi.trim() && env.managedRunnerToken.trim()) {
    logShipper = new LogShipper({ baseUrl: env.managedRunnerApi, token: env.managedRunnerToken });
    logStore.setShipper(logShipper);
    logShipper.start();
    // Statistiques du Dashboard des commandes: même Manager, même jeton.
    statsShipper = new CommandStatsShipper({ baseUrl: env.managedRunnerApi, token: env.managedRunnerToken });
    setCommandStatsShipper(statsShipper);
    statsShipper.start();
  }

  // Fonctions IA du langage (`bc.ai`) : seulement avec un Manager (runner géré ou pool).
  ManagedAiGateway.install(env);
  installGuildAlertsApi(env);
  // Quota de l'enregistrement vocal (`bc.recorder`) : Premium et heures mensuelles tenus par le Manager.
  ManagedVoiceQuotaGateway.install(env);
  // Fichiers des bots (`bc.files`) : stockage du compte, via le Manager.
  // Sans Manager, un bot local (desktop) écrit dans un dossier du PC si BOT_CREATOR_LOCAL_FILES_DIR est posé.
  // Sans Manager (self-host, runner embarqué dans l'app desktop), les fichiers et la base vivent sur la machine, par
  // défaut dans `<dataDir>/.local-data` : même comportement que le runner Dart.
  ManagedFilesGateway.install(env) ||
    LocalFilesGateway.install(env) ||
    LocalFilesGateway.install({ localFilesDir: join(env.dataDir, '.local-data', 'files') });
  // Base des bots (`bc.db`) : le Manager, sinon l'app desktop qui nous embarque (boucle locale), sinon SQLite ici.
  if (!ManagedDocumentsGateway.install(env)) {
    if (
      !ManagedDocumentsGateway.install({
        managedRunnerApi: env.localDocumentsUrl,
        managedRunnerToken: env.localDocumentsToken,
      })
    ) {
      setDocumentsGateway(new LocalDocumentsGateway({ dir: env.localDbDir || join(env.dataDir, '.local-data', 'db') }));
    }
  }

  // All bots share this process; log unexpected errors but never exit, since
  // exiting would take down every bot on the node.
  process.on('uncaughtException', (error) => {
    logStore.append('error', `uncaughtException: ${error?.stack ?? String(error)}`);
  });
  process.on('unhandledRejection', (reason) => {
    const message =
      reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    logStore.append('error', `unhandledRejection: ${message}`);
  });

  const runtime = await RuntimeController.create(env.dataDir, logStore, env);
  const app = createHttpServer({ env, runtime, logStore });

  const server = Bun.serve({
    // `server` sert à `getConnInfo` (IP source des webhooks entrants).
    fetch: (request, srv) => app.fetch(request, { server: srv }),
    port: env.webPort,
    hostname: env.webHost,
  });

  const shutdown = async (signal: string) => {
    logStore.append('info', `Shutting down (${signal})...`);
    await runtime.dispose();
    await logShipper?.stop();
    await statsShipper?.stop();
    server.stop(true);
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  const listenUrl = `http://${env.webHost}:${env.webPort}`;
  logStore.append('info', `Runner JS listening on ${listenUrl}`);
  console.log(`[runner-js] Listening on ${listenUrl}`);
  console.log(`[runner-js] Logs: ${env.logFile}`);
  console.log(`[runner-js] Health: ${listenUrl}/health`);

  if (env.poolMode) {
    void bootstrapFromPool(env, runtime, logStore);
  }
}
