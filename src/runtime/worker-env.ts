export function buildWorkerProcessEnv(
  botId: string,
  dataDir: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    BOT_CREATOR_BOT_ID: botId,
    BOT_CREATOR_DATA_DIR: dataDir,
    BOT_CREATOR_WORKER_MODE: '1',
  };

  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('BOT_CREATOR_') && value) {
      env[key] = value;
    }
  }

  for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) {
    const value = process.env[key];
    if (value) {
      env[key] = value;
    }
  }

  return env;
}
