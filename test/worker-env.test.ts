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

  it('passes worker RSS restart settings when configured', () => {
    process.env.BOT_CREATOR_WORKER_RSS_RESTART_MB = '512';
    process.env.BOT_CREATOR_WORKER_RSS_RESTART_CHECKS = '4';
    process.env.BOT_CREATOR_WORKER_RSS_RESTART_MIN_UPTIME_MS = '600000';

    const env = buildWorkerProcessEnv('bot-1', '/data/bots');

    expect(env.BOT_CREATOR_WORKER_RSS_RESTART_MB).toBe('512');
    expect(env.BOT_CREATOR_WORKER_RSS_RESTART_CHECKS).toBe('4');
    expect(env.BOT_CREATOR_WORKER_RSS_RESTART_MIN_UPTIME_MS).toBe('600000');
  });

  it('injects default --max-old-space-size into NODE_OPTIONS', () => {
    delete process.env.BOT_CREATOR_WORKER_MAX_HEAP_MB;
    delete process.env.NODE_OPTIONS;

    const env = buildWorkerProcessEnv('bot-1', '/data/bots');
    expect(env.NODE_OPTIONS).toBe('--max-old-space-size=512');
  });

  it('concatenates with existing NODE_OPTIONS', () => {
    delete process.env.BOT_CREATOR_WORKER_MAX_HEAP_MB;
    process.env.NODE_OPTIONS = '--enable-source-maps';

    const env = buildWorkerProcessEnv('bot-1', '/data/bots');
    expect(env.NODE_OPTIONS).toBe('--enable-source-maps --max-old-space-size=512');
  });

  it('replaces an existing --max-old-space-size flag', () => {
    process.env.BOT_CREATOR_WORKER_MAX_HEAP_MB = '256';
    process.env.NODE_OPTIONS = '--max-old-space-size=1024 --trace-warnings';

    const env = buildWorkerProcessEnv('bot-1', '/data/bots');
    expect(env.NODE_OPTIONS).toBe('--max-old-space-size=256 --trace-warnings');
  });

  it('disables heap cap when BOT_CREATOR_WORKER_MAX_HEAP_MB is 0', () => {
    process.env.BOT_CREATOR_WORKER_MAX_HEAP_MB = '0';
    delete process.env.NODE_OPTIONS;

    const env = buildWorkerProcessEnv('bot-1', '/data/bots');
    expect(env.NODE_OPTIONS).toBeUndefined();
  });
});
