import { afterEach, describe, expect, it } from 'vitest';

import { buildWorkerProcessEnv } from '../src/runtime/worker-env.js';

describe('buildWorkerProcessEnv', () => {
  const previousEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...previousEnv };
  });

  it('does not pass runner control-plane secrets to workers', () => {
    process.env.BOT_CREATOR_API_TOKEN = 'runner-secret';
    process.env.BOT_CREATOR_WEB_HOST = '127.0.0.1';
    process.env.BOT_CREATOR_WEB_PORT = '8080';
    process.env.BOT_CREATOR_POOL_MODE = '1';
    process.env.BOT_CREATOR_RUNNER_NODE_ID = 'node-a';

    const env = buildWorkerProcessEnv('bot-1', '/data/bots');

    expect(env.BOT_CREATOR_BOT_ID).toBe('bot-1');
    expect(env.BOT_CREATOR_DATA_DIR).toBe('/data/bots');
    expect(env.BOT_CREATOR_WORKER_MODE).toBe('1');
    expect(env.BOT_CREATOR_API_TOKEN).toBeUndefined();
    expect(env.BOT_CREATOR_WEB_HOST).toBeUndefined();
    expect(env.BOT_CREATOR_WEB_PORT).toBeUndefined();
    expect(env.BOT_CREATOR_POOL_MODE).toBeUndefined();
    expect(env.BOT_CREATOR_RUNNER_NODE_ID).toBeUndefined();
  });

  it('passes managed variable store settings when configured', () => {
    process.env.BOT_CREATOR_MANAGED_RUNNER_API = 'https://vars.example';
    process.env.BOT_CREATOR_MANAGED_RUNNER_TOKEN = 'vars-token';

    const env = buildWorkerProcessEnv('bot-1', '/data/bots');

    expect(env.BOT_CREATOR_MANAGED_RUNNER_API).toBe('https://vars.example');
    expect(env.BOT_CREATOR_MANAGED_RUNNER_TOKEN).toBe('vars-token');
  });
});
