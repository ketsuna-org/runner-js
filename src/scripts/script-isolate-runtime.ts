import ivm from 'isolated-vm';

import { buildHostBridge, sanitizeConfigForScript } from './script-host-bridge.js';
import type { ScriptExecutionContext, ScriptLogger } from './script-context.js';

const DEFAULT_MEMORY_LIMIT_MB = 128;

const BOOTSTRAP_SCRIPT = `
"use strict";
const __hostBridgeHolder = { ref: null };
const __hostSpecs = [];
function __setHostBridge(ref) {
  __hostBridgeHolder.ref = ref;
}
function __setHostSpecs(specs) {
  __hostSpecs.length = 0;
  for (let i = 0; i < specs.length; i++) {
    __hostSpecs.push(specs[i]);
  }
}
function __findHostSpec(id) {
  for (let i = 0; i < __hostSpecs.length; i++) {
    if (__hostSpecs[i].id === id) {
      return __hostSpecs[i];
    }
  }
  return null;
}
function __hostRead(targetId, prop) {
  if (!__hostBridgeHolder.ref) {
    throw new Error('Host bridge is not available.');
  }
  return __hostBridgeHolder.ref.applySync(undefined, ['read', targetId, prop], {
    arguments: { copy: true },
    result: { copy: true },
  });
}
function __hostCall(targetId, method, args) {
  if (!__hostBridgeHolder.ref) {
    return Promise.reject(new Error('Host bridge is not available.'));
  }
  const result = __hostBridgeHolder.ref.apply(undefined, ['invoke', targetId, method, args], {
    arguments: { copy: true },
    result: { promise: true, copy: true },
  });
  return Promise.resolve(result).then(__normalizeHostValue);
}
function __normalizeHostValue(value) {
  if (value && value.type === 'host-method') {
    return (...args) => __hostCall(value.id, value.method, args);
  }
  if (value && typeof value.id === 'string' && value.dynamic) {
    return __makeDynamicHostProxy(value);
  }
  if (value && typeof value.id === 'string' && Array.isArray(value.methods)) {
    return __makeHostProxy(value);
  }
  return value;
}
function __makeDynamicHostProxy(spec) {
  return new Proxy(Object.create(null), {
    get(obj, prop) {
      if (typeof prop === 'symbol') {
        return undefined;
      }
      const key = String(prop);
      if (key === 'then' || key === 'catch' || key === 'finally') {
        return undefined;
      }
      return __normalizeHostValue(__hostRead(spec.id, key));
    },
    set(obj, prop, value) {
      __hostCall(spec.id, '__set', [String(prop), value]);
      return true;
    },
  });
}
function __makeHostProxy(spec, bridge) {
  if (!spec) {
    return null;
  }
  if (spec.dynamic) {
    return __makeDynamicHostProxy(spec);
  }
  const methods = new Set(Array.isArray(spec.methods) ? spec.methods : []);
  const target = Object.assign({}, spec.snapshot || {});

  for (const method of methods) {
    if (method === '__call') {
      target.fetch = (...args) => __hostCall(spec.id, '__call', args);
      continue;
    }
    target[method] = (...args) => __hostCall(spec.id, method, args);
  }

  return new Proxy(target, {
    get(obj, prop) {
      if (typeof prop === 'symbol') {
        return undefined;
      }
      const key = String(prop);
      if (key === 'then' || key === 'catch' || key === 'finally') {
        return undefined;
      }
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        return obj[key];
      }
      return __normalizeHostValue(__hostRead(spec.id, key));
    },
    set(obj, prop, value) {
      if (methods.has(String(prop))) {
        return false;
      }
      __hostCall(spec.id, '__set', [String(prop), value]);
      obj[prop] = value;
      return true;
    },
  });
}
function __buildModule(spec) {
  const mod = Object.assign({}, spec.constants || {});
  for (let i = 0; i < spec.functions.length; i++) {
    const fnName = spec.functions[i];
    mod[fnName] = (...args) => __hostCall(spec.id, fnName, args);
  }
  return mod;
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

      jail.setSync('__hostInvoke', bridgeBundle.bridgeRef);

      const specs = bridgeBundle.objectSpecs.map((spec) => ({
        id: spec.id,
        snapshot: spec.snapshot,
        methods: spec.methods,
        dynamic: spec.dynamic ?? false,
      }));

      await ivmContext.evalSync(`
        const __specs = ${JSON.stringify(specs)};
        const __moduleSpecs = ${JSON.stringify(bridgeBundle.moduleSpecs)};
        const __find = (id) => __specs.find((entry) => entry.id === id) ?? null;
        globalThis.client = __makeHostProxy(__find('client'));
        globalThis.interaction = __makeHostProxy(__find('interaction'));
        globalThis.message = __makeHostProxy(__find('message'));
        globalThis.member = __makeHostProxy(__find('member'));
        globalThis.guild = __makeHostProxy(__find('guild'));
        globalThis.channel = __makeHostProxy(__find('channel'));
        globalThis.db = __makeHostProxy(__find('db'));
        if (globalThis.db) {
          globalThis.db.global = __makeHostProxy(__find('db.global'));
        }
        globalThis.console = __makeHostProxy({
          id: 'console',
          snapshot: {},
          methods: ['log', 'info', 'warn', 'error', 'debug'],
        });
        globalThis.fetch = __makeHostProxy({
          id: '__fetch',
          snapshot: {},
          methods: ['__call'],
        }).fetch;
        globalThis.setTimeout = (callback, ms = 0) =>
          __hostCall('__delay', '__call', [ms]).then(() => callback());
        globalThis.clearTimeout = (handle) => __hostCall('__clearTimeout', '__call', [handle]);
        globalThis.config = ${JSON.stringify(sanitizeConfigForScript(context.config))};
        globalThis.variables = ${JSON.stringify(context.variables)};
        globalThis.webhook = ${JSON.stringify(context.webhook ?? null)};
        globalThis.require = (name) => {
          const spec = __moduleSpecs.find((entry) => entry.name === name);
          if (!spec) {
            throw new Error('Module "' + name + '" is not allowed.');
          }
          return __buildModule(spec);
        };
        __setHostSpecs(__specs);
        __setHostBridge(__hostInvoke);
        delete globalThis.__hostInvoke;
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
      await bridgeBundle.drain(timeoutMs);
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
