import type { RuntimeController } from '../runtime/runtime-controller.js';
import type { LogStore } from '../runtime/log-store.js';
import type { RunnerEnv } from '../config/env.js';

interface PoolBootstrapBot {
  bot_id?: string;
  bot_name?: string;
  desired_state?: string;
  payload?: {
    botId?: string;
    botName?: string;
    config?: Record<string, unknown>;
  };
}

export async function bootstrapFromPool(
  env: RunnerEnv,
  runtime: RuntimeController,
  logStore: LogStore,
): Promise<void> {
  if (!env.poolMode) {
    return;
  }

  const nodeId = env.runnerNodeId.trim();
  if (!nodeId) {
    logStore.append('error', '[Pool] BOT_CREATOR_RUNNER_NODE_ID is required in pool mode.');
    return;
  }

  const managedApi = env.managedRunnerApi.trim();
  const managedToken = env.managedRunnerToken.trim();
  if (!managedApi || !managedToken) {
    logStore.append(
      'error',
      '[Pool] BOT_CREATOR_MANAGED_RUNNER_API and BOT_CREATOR_MANAGED_RUNNER_TOKEN are required.',
    );
    return;
  }

  const baseUrl = managedApi.endsWith('/') ? managedApi.slice(0, -1) : managedApi;
  const url = baseUrl.endsWith(`/internal/pool-runners/${nodeId}`)
    ? `${baseUrl}/bootstrap`
    : `${baseUrl}/internal/pool-runners/${nodeId}/bootstrap`;

  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${managedToken}` },
    });

    if (!response.ok) {
      logStore.append('error', `[Pool] Bootstrap failed: ${response.status} ${await response.text()}`);
      return;
    }

    const body = (await response.json()) as { bots?: PoolBootstrapBot[] };
    const bots = body.bots ?? [];
    logStore.append('info', `[Pool] Bootstrapping ${bots.length} bot(s)...`);

    for (const botData of bots) {
      try {
        await syncAndStartPoolBot(botData, runtime, logStore);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logStore.append('error', `[Pool] Failed to sync/start bot: ${message}`);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logStore.append('error', `[Pool] Bootstrap error: ${message}`);
  }
}

async function syncAndStartPoolBot(
  botJson: PoolBootstrapBot,
  runtime: RuntimeController,
  logStore: LogStore,
): Promise<void> {
  const botId = (botJson.bot_id ?? '').trim();
  const botName = (botJson.bot_name ?? '').trim();
  const desiredState = (botJson.desired_state ?? '').trim();
  const payload = botJson.payload;

  if (!botId || !payload?.config) {
    logStore.append('warn', '[Pool] Skipping invalid bot entry: missing bot_id or config.');
    return;
  }

  await runtime.syncBot(botId, botName || botId, payload.config);

  if (desiredState === 'running' && !runtime.isBotRunning(botId)) {
    await runtime.startBot(botId, botName);
    logStore.append('info', `[Pool] Bot "${botName || botId}" (${botId}) started.`);
  }
}
