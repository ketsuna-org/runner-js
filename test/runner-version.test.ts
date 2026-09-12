import { afterEach, describe, expect, it } from 'bun:test';

import { loadRunnerEnv } from '../src/config/env.js';
import { createHttpServer } from '../src/http/server.js';

const VERSION_ENV_KEY = 'BOT_CREATOR_RUNNER_VERSION';
const originalVersionEnv = process.env[VERSION_ENV_KEY];

afterEach(() => {
  if (originalVersionEnv === undefined) {
    delete process.env[VERSION_ENV_KEY];
  } else {
    process.env[VERSION_ENV_KEY] = originalVersionEnv;
  }
});

describe('runner version resolution', () => {
  it('exposes the package.json version (0.5.0) and never "unknown" when run from source', () => {
    const env = loadRunnerEnv();

    expect(env.version).toBe('0.5.0');
    expect(env.version).not.toBe('unknown');
  });

  it('lets BOT_CREATOR_RUNNER_VERSION override the package version', () => {
    process.env[VERSION_ENV_KEY] = '9.9.9';

    const env = loadRunnerEnv();

    expect(env.version).toBe('9.9.9');
  });

  it('ignores an empty or whitespace-only BOT_CREATOR_RUNNER_VERSION override', () => {
    process.env[VERSION_ENV_KEY] = '   ';

    const env = loadRunnerEnv();

    expect(env.version).toBe('0.5.0');
  });

  it('reports the resolved version on GET /health', async () => {
    const env = loadRunnerEnv();
    const app = createHttpServer({
      env,
      runtime: {} as never,
      logStore: {} as never,
    });

    const response = await app.request('/health');

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      version?: string;
      engine?: string;
    };
    expect(body.ok).toBe(true);
    expect(body.version).toBe('0.5.0');
    expect(body.version).not.toBe('unknown');
    expect(body.engine).toBe('javascript');
  });

  it('reports the overridden version on GET /health', async () => {
    process.env[VERSION_ENV_KEY] = '9.9.9';
    const env = loadRunnerEnv();
    const app = createHttpServer({
      env,
      runtime: {} as never,
      logStore: {} as never,
    });

    const response = await app.request('/health');

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; version?: string };
    expect(body.ok).toBe(true);
    expect(body.version).toBe('9.9.9');
  });
});
