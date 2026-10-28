import { describe, expect, it, mock, spyOn, vi } from 'bun:test';

import { ScriptExecutor } from '../src/scripts/script-executor.js';

function createDirectExecutor(timeoutMs = 5000): ScriptExecutor {
  return new ScriptExecutor(timeoutMs);
}

describe('ScriptDirectRuntime', () => {
  it('allows require("node:fs")', async () => {
    const executor = createDirectExecutor();
    const result = await executor.execute(
      `
        const fs = require('node:fs');
        return typeof fs.readFileSync;
      `,
      {
        client: {} as never,
        config: { token: 'x' } as never,
        variables: {},
      },
      createLogger(),
    );

    expect(result).toBe('function');
    executor.dispose();
  });

  it('allows require("path")', async () => {
    const executor = createDirectExecutor();
    const result = await executor.execute(
      `
        const path = require('path');
        return path.posix.join('a', 'b');
      `,
      {
        client: {} as never,
        config: { token: 'x' } as never,
        variables: {},
      },
      createLogger(),
    );

    expect(result).toBe('a/b');
    executor.dispose();
  });

  it('persists variable mutations after execution', async () => {
    const executor = createDirectExecutor();
    const variables: Record<string, unknown> = { count: 1 };

    const result = await executor.execute(
      'variables.count = 2; return variables.count;',
      {
        client: {} as never,
        config: { token: 'x' } as never,
        variables,
      },
      createLogger(),
    );

    expect(result).toBe(2);
    expect(variables.count).toBe(2);
    executor.dispose();
  });

  it('times out long running scripts', async () => {
    const executor = createDirectExecutor(50);

    await expect(
      executor.execute(
        'await new Promise((resolve) => setTimeout(resolve, 500));',
        {
          client: {} as never,
          config: { token: 'x' } as never,
          variables: {},
        },
        createLogger(),
      ),
    ).rejects.toThrow(/timed out/i);

    executor.dispose();
  });

  it('calls interaction.reply with real objects', async () => {
    const executor = createDirectExecutor();
    const reply = vi.fn(async () => ({ ok: true }));

    await executor.execute(
      "await interaction.reply({ content: 'pong' });",
      {
        client: {} as never,
        config: { token: 'x' } as never,
        variables: {},
        interaction: { reply } as never,
      },
      createLogger(),
    );

    expect(reply).toHaveBeenCalledWith({ content: 'pong' });
    executor.dispose();
  });

  it('does not expose config.token, client.token, or db.config', async () => {
    const { ScriptDb } = await import('../src/scripts/script-db.js');
    const executor = createDirectExecutor();
    const store = {
      token: 'managed-bearer-secret',
      getGlobalVariables: async () => ({}),
      setGlobalVariable: async () => undefined,
      removeGlobalVariable: async () => undefined,
      getScopedVariable: async () => undefined,
      setScopedVariable: async () => undefined,
      removeScopedVariable: async () => undefined,
      listContextIds: async () => [],
      removeAllScopedValuesForKey: async () => undefined,
    };
    const config = {
      token: 'super-secret-token',
      globalVariables: {},
      scopedVariableDefinitions: [],
      inboundWebhooks: [{ id: '1', path: '/hook', secret: 'webhook-secret', script: '', enabled: true }],
    } as never;
    const db = new ScriptDb('bot-1', config, store as never, {}, {});
    const client = { token: 'super-secret-token', uptime: 1 };

    const result = (await executor.execute(
      `
        return {
          configToken: config.token,
          clientToken: client.token,
          dbConfig: db.config,
          dbToken: db.config?.token,
          webhookSecret: config.inboundWebhooks?.[0]?.secret,
        };
      `,
      {
        client: client as never,
        config,
        variables: {},
        db,
      },
      createLogger(),
    )) as {
      configToken?: string;
      clientToken?: string;
      dbConfig?: unknown;
      dbToken?: string;
      webhookSecret?: string;
    };

    expect(result.configToken).toBeUndefined();
    expect(result.clientToken).toBeUndefined();
    expect(result.dbConfig).toBeUndefined();
    expect(result.dbToken).toBeUndefined();
    expect(result.webhookSecret).toBeUndefined();
    executor.dispose();
  });

  it('reuses compiled script cache for fast repeated execution', async () => {
    const executor = createDirectExecutor();
    const script = 'return variables.val * 2;';

    const r1 = await executor.execute(script, { client: {} as never, config: { token: 'x' } as never, variables: { val: 10 } }, createLogger());
    const r2 = await executor.execute(script, { client: {} as never, config: { token: 'x' } as never, variables: { val: 25 } }, createLogger());

    expect(r1).toBe(20);
    expect(r2).toBe(50);
    executor.dispose();
  });
});

describe('ScriptDirectRuntime : global fn', () => {
  it('fn est le 20e et dernier paramètre de portée (voice vient juste avant console)', async () => {
    const executor = createDirectExecutor();
    const result = await executor.execute(
      'return [arguments.length, typeof fn];',
      { client: {} as never, config: { token: 'x' } as never, variables: {} },
      createLogger(),
    );
    expect(result).toEqual([20, 'object']);
    executor.dispose();
  });

  it('expose l objet voice fourni par le contexte', async () => {
    const executor = createDirectExecutor();
    const voice = { enabled: true } as never;
    const result = await executor.execute(
      'return voice.enabled;',
      { client: {} as never, config: { token: 'x' } as never, variables: {}, voice },
      createLogger(),
    );
    expect(result).toBe(true);
    executor.dispose();
  });

  it('un script contenant `const fn = 1` s execute toujours (repli sans fn, moteur courant) et émet un avertissement', async () => {
    const executor = createDirectExecutor();
    const logger = createLogger();
    const result = await executor.execute(
      '/* direct-const-fn */ const fn = 1; return fn + 1;',
      { client: {} as never, config: { token: 'x' } as never, variables: {} },
      logger,
    );
    expect(result).toBe(2);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0]?.[0])).toMatch(/\bfn\b/);
    // Le repli est mis en cache : une deuxième exécution du même script ne ré-émet pas l avertissement.
    await executor.execute(
      '/* direct-const-fn */ const fn = 1; return fn + 1;',
      { client: {} as never, config: { token: 'x' } as never, variables: {} },
      logger,
    );
    expect(logger.warn).toHaveBeenCalledTimes(1);
    executor.dispose();
  });

  it('le script et ses fonctions partagent les mêmes valeurs de portée', async () => {
    const executor = createDirectExecutor();
    const variables = { a: 1 };
    const db = { marker: 'db' };
    const config = { token: 'x', jsFunctions: [{ name: 'probe', script: 'return [variables, db, console, setTimeout, fetch, require];' }] };
    const result = (await executor.execute(
      `const own = [variables, db, console, setTimeout, fetch, require];
       const viaFn = await fn.probe();
       return own.map((value, index) => value === viaFn[index]);`,
      { client: {} as never, config: config as never, variables, db: db as never },
      createLogger(),
    )) as boolean[];
    expect(result).toEqual([true, true, true, true, true, true]);
    executor.dispose();
  });

  it('après le timeout, le drapeau expiré empêche tout nouvel appel fn', async () => {
    const executor = createDirectExecutor(40);
    const variables: Record<string, unknown> = {};
    const config = { token: 'x', jsFunctions: [{ name: 'later', script: 'variables.ran = true;' }] };
    await expect(
      executor.execute(
        `await new Promise((resolve) => setTimeout(resolve, 120));
         variables.outcome = await fn.later().then(() => 'ran', (error) => error.message);`,
        { client: {} as never, config: config as never, variables },
        createLogger(),
      ),
    ).rejects.toThrow(/timed out/i);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(String(variables.outcome)).toMatch(/timed out/i);
    expect(variables.ran).toBeUndefined();
    executor.dispose();
  });
});

describe('ScriptDirectRuntime : fin réelle d’un script après son timeout', () => {
  const context = { client: {} as never, config: { token: 'x' } as never, variables: {} };

  it('signale onTimeout au rejet du timeout, puis onSettled quand le script se termine vraiment', async () => {
    const executor = createDirectExecutor();
    const events: string[] = [];
    await expect(
      executor.execute(
        'await new Promise((resolve) => setTimeout(resolve, 200)); return 42;',
        context,
        createLogger(),
        40,
        { onTimeout: () => events.push('timeout'), onSettled: () => events.push('settled') },
      ),
    ).rejects.toThrow('timed out');
    expect(events).toEqual(['timeout']);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(events).toEqual(['timeout', 'settled']);
    executor.dispose();
  });

  it('un script qui se termine à temps, avec succès ou en erreur, signale seulement onSettled', async () => {
    const executor = createDirectExecutor();
    const events: string[] = [];
    const lifecycle = { onTimeout: () => events.push('timeout'), onSettled: () => events.push('settled') };
    await expect(executor.execute('return 7;', context, createLogger(), 1000, lifecycle)).resolves.toBe(7);
    await expect(
      executor.execute('throw new Error("boom");', context, createLogger(), 1000, lifecycle),
    ).rejects.toThrow('boom');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toEqual(['settled', 'settled']);
    executor.dispose();
  });

  it('sans rappels, le comportement est inchangé', async () => {
    const executor = createDirectExecutor();
    await expect(executor.execute('return 1 + 1;', context, createLogger(), 1000)).resolves.toBe(2);
    executor.dispose();
  });
});


function createLogger() {
  return {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}
