import { describe, expect, it } from 'bun:test';

import { createHttpServer } from '../src/http/server.js';
import { loadRunnerEnv } from '../src/config/env.js';
import { LogStore } from '../src/runtime/log-store.js';
import { RuntimeController } from '../src/runtime/runtime-controller.js';

describe('scoped-definitions/set', () => {
  it('keeps the stored valueType when the client sends none', async () => {
    const env = {
      ...loadRunnerEnv(),
      dataDir: './data/test-scoped-type',
      logFile: './data/test-scoped-type/logs/runner.log',
      webHost: '127.0.0.1',
      webPort: 0,
      apiToken: '',
    };
    const runtime = await RuntimeController.create(env.dataDir, new LogStore(env.logFile), env);
    const app = createHttpServer({ env, runtime, logStore: new LogStore(env.logFile) });
    const post = (path: string, body: unknown) =>
      app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    await post('/bots/sync', { botId: 'typed', botName: 'T', config: { token: 'x' } });
    await post('/bots/typed/variables/scoped-definitions/set', {
      key: 'score', scope: 'user', defaultValue: 0, valueType: 'number',
    });
    // Le Studio ne connaît pas le type : il ne l'envoie pas.
    await post('/bots/typed/variables/scoped-definitions/set', {
      key: 'score', scope: 'user', defaultValue: 5,
    });

    const entry = await runtime.botStore.load('typed');
    const def = entry!.config.scopedVariableDefinitions.find((d) => d.key === 'score');
    expect(def?.valueType).toBe('number');
    expect(def?.defaultValue).toBe(5);
  });
});
