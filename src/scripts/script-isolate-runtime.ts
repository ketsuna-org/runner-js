import ivm from 'isolated-vm';

import { buildHostBridge, sanitizeConfigForScript } from './script-host-bridge.js';
import type { ScriptExecutionContext, ScriptLogger } from './script-context.js';

const DEFAULT_MEMORY_LIMIT_MB = 128;

const BOOTSTRAP_SCRIPT = `
"use strict";
function __makeHostProxy(spec, bridge) {
  if (!spec || !Array.isArray(spec.methods)) {
    return null;
  }
  const obj = Object.assign({}, spec.snapshot);
  if (spec.id === 'interaction') {
    obj.options = __makeHostProxy({
      id: 'interaction.options',
      snapshot: {},
      methods: [
        'getString', 'getInteger', 'getNumber', 'getBoolean', 'getUser', 'getMember',
        'getRole', 'getChannel', 'getAttachment', 'getMentionable', 'getSubcommand',
        'getSubcommandGroup', 'getFocused',
      ],
    }, bridge);
  }
  for (let i = 0; i < spec.methods.length; i++) {
    const method = spec.methods[i];
    if (method === '__call') {
      obj.fetch = (...args) => bridge.apply(undefined, ['invoke', spec.id, '__call', args], {
        arguments: { copy: true },
        result: { promise: true, copy: true },
      });
      continue;
    }
    obj[method] = (...args) => bridge.apply(undefined, ['invoke', spec.id, method, args], {
      arguments: { copy: true },
      result: { promise: true, copy: true },
    });
  }
  return obj;
}
`;

export class ScriptIsolateRuntime {
  private readonly isolate: ivm.Isolate;
  private readonly bootstrap: ivm.Script;
  private disposed = false;

  constructor(memoryLimitMb = DEFAULT_MEMORY_LIMIT_MB) {
    this.isolate = new ivm.Isolate({ memoryLimit: memoryLimitMb });
    this.bootstrap = this.isolate.compileScriptSync(BOOTSTRAP_SCRIPT, {
      filename: 'bootstrap.js',
    });
  }

  async execute(
    script: string,
    context: ScriptExecutionContext,
    logger: ScriptLogger,
    timeoutMs: number,
  ): Promise<unknown> {
    this.assertActive();

    const trimmed = script.trim();
    if (!trimmed) {
      return undefined;
    }

    const bridgeBundle = buildHostBridge(context, logger);
    const ivmContext = await this.isolate.createContext();
    const jail = ivmContext.global;

    try {
      await jail.set('global', jail.derefInto());
      this.bootstrap.runSync(ivmContext);

      jail.setSync('__hostBridge', bridgeBundle.bridgeRef);

      const specs = bridgeBundle.objectSpecs.map((spec) => ({
        id: spec.id,
        snapshot: spec.snapshot,
        methods: spec.methods,
      }));

      await ivmContext.evalSync(`
        const __specs = ${JSON.stringify(specs)};
        const __find = (id) => __specs.find((entry) => entry.id === id) ?? null;
        const __bridge = __hostBridge;
        globalThis.client = __makeHostProxy(__find('client'), __bridge);
        globalThis.interaction = __makeHostProxy(__find('interaction'), __bridge);
        globalThis.message = __makeHostProxy(__find('message'), __bridge);
        globalThis.member = __makeHostProxy(__find('member'), __bridge);
        globalThis.guild = __makeHostProxy(__find('guild'), __bridge);
        globalThis.channel = __makeHostProxy(__find('channel'), __bridge);
        globalThis.db = __makeHostProxy(__find('db'), __bridge);
        if (globalThis.db) {
          globalThis.db.global = __makeHostProxy(__find('db.global'), __bridge);
        }
        globalThis.console = __makeHostProxy({
          id: 'console',
          snapshot: {},
          methods: ['log', 'info', 'warn', 'error', 'debug'],
        }, __bridge);
        globalThis.fetch = __makeHostProxy({
          id: '__fetch',
          snapshot: {},
          methods: ['__call'],
        }, __bridge).fetch;
        globalThis.setTimeout = (callback, ms) => __bridge.apply(undefined, ['invoke', '__setTimeout', '__call', [callback, ms]], {
          arguments: { reference: true },
          result: { promise: true, copy: true },
        });
        globalThis.clearTimeout = (handle) => __bridge.apply(undefined, ['invoke', '__clearTimeout', '__call', [handle]], {
          arguments: { copy: true },
          result: { copy: true },
        });
        globalThis.config = ${JSON.stringify(sanitizeConfigForScript(context.config))};
        globalThis.variables = ${JSON.stringify(context.variables)};
        globalThis.webhook = ${JSON.stringify(context.webhook ?? null)};
        delete globalThis.__hostBridge;
      `);

      const wrappedScript = `(async () => {\n${trimmed}\n})();`;
      const compiled = await this.isolate.compileScript(wrappedScript, {
        filename: 'script.js',
      });

      try {
        let watchdog: NodeJS.Timeout | undefined;
        const execution = compiled.run(ivmContext, {
          timeout: timeoutMs,
          promise: true,
          copy: true,
        });

        const result = await Promise.race([
          execution,
          new Promise<never>((_, reject) => {
            watchdog = setTimeout(() => {
              bridgeBundle.clearTimers();
              reject(new Error(`Script execution timed out after ${timeoutMs}ms`));
            }, timeoutMs);
          }),
        ]).finally(() => {
          if (watchdog) {
            clearTimeout(watchdog);
          }
        });

        const updatedVariables = await jail.get('variables', { copy: true }) as Record<string, unknown>;
        if (updatedVariables && typeof updatedVariables === 'object') {
          for (const [key, value] of Object.entries(updatedVariables)) {
            context.variables[key] = value;
          }
        }

        return result;
      } finally {
        compiled.release();
      }
    } finally {
      bridgeBundle.clearTimers();
      ivmContext.release();
      bridgeBundle.release();
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.bootstrap.release();
    this.isolate.dispose();
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new Error('Script isolate runtime has been disposed.');
    }
  }
}
