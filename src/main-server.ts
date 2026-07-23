import { loadRunnerEnv, validateRunnerWebConfiguration } from './config/env.js';
import { createHttpServer } from './http/server.js';
import { bootstrapFromPool } from './pool/bootstrap.js';
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

  const shutdown = async (signal: string) => {
    logStore.append('info', `Shutting down (${signal})...`);
    await runtime.dispose();
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: env.webHost, port: env.webPort });
  const listenUrl = `http://${env.webHost}:${env.webPort}`;
  logStore.append('info', `Runner JS listening on ${listenUrl}`);
  // PKG builds have no visible console by default; echo startup for local testing.
  console.log(`[runner-js] Listening on ${listenUrl}`);
  console.log(`[runner-js] Logs: ${env.logFile}`);
  console.log(`[runner-js] Health: ${listenUrl}/health`);

  if (env.poolMode) {
    void bootstrapFromPool(env, runtime, logStore);
  }
}
