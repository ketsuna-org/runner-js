import ivm from 'isolated-vm';

import { ScriptBridgeHost } from './script-bridge-host.js';
import { sanitizeConfigForScript } from './script-host-bridge.js';
import type { ScriptExecutionContext, ScriptLogger } from './script-context.js';

const DEFAULT_MEMORY_LIMIT_MB = 128;

const BOOTSTRAP_SCRIPT = `
(function() {
  "use strict";

  let __sessionId = 0;
  let __bridgeRef = null;
  let __drainDeadline = 0;
  const __hostSpecs = [];
  const __pendingHostWork = new Set();
  const __hostProxyTargets = new WeakMap();
  let __listenerSeq = 0;
  const __hostListeners = new Map();

  globalThis.__registerHostListener = (fn) => {
    const id = ++__listenerSeq;
    __hostListeners.set(id, fn);
    return id;
  };

  globalThis.__dispatchHostListener = (id, args) => {
    const fn = __hostListeners.get(id);
    if (typeof fn !== 'function') {
      return undefined;
    }
    const normalizedArgs = args.map((arg) => __normalizeHostValue(arg));
    const result = fn(...normalizedArgs);
    if (result != null && typeof result.then === 'function') {
      __trackHostPromise(Promise.resolve(result));
    }
    return result;
  };

  function __markHostProxyTarget(proxy, spec) {
    __hostProxyTargets.set(proxy, spec.id);
    return proxy;
  }

  function __sanitizeHostArg(value) {
    if (value == null) {
      return value;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'function') {
      if (value.__hostMethodRef) {
        return { __hostMethodRef: value.__hostMethodRef };
      }
      return { __hostListenerRef: globalThis.__registerHostListener(value) };
    }
    const hostId = __hostProxyTargets.get(value);
    if (hostId) {
      return { __hostArgRef: hostId };
    }
    if (Array.isArray(value)) {
      return value.map(__sanitizeHostArg);
    }
    if (typeof value === 'object') {
      const output = {};
      for (const key of Object.keys(value)) {
        output[key] = __sanitizeHostArg(value[key]);
      }
      return output;
    }
    return value;
  }

  function __sanitizeHostArgs(args) {
    return args.map(__sanitizeHostArg);
  }

  function __setSession(id) {
    __sessionId = id;
  }

  function __setBridgeRef(ref) {
    __bridgeRef = ref;
  }

  function __setDrainDeadline(ms) {
    __drainDeadline = Date.now() + ms;
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

  function __trackHostPromise(promise) {
    __pendingHostWork.add(promise);
    promise.finally(() => __pendingHostWork.delete(promise));
    return promise;
  }

  async function __drainPendingHostWork() {
    while (__pendingHostWork.size > 0 && Date.now() < __drainDeadline) {
      const pending = Array.from(__pendingHostWork);
      await Promise.allSettled(pending);
    }
  }

  function __hostRead(targetId, prop) {
    if (!__bridgeRef) {
      throw new Error('Host bridge is not available.');
    }
    return __bridgeRef.applySync(undefined, [__sessionId, 'read', targetId, prop], {
      arguments: { copy: true },
      result: { copy: true },
    });
  }

  function __hostCall(targetId, method, args) {
    if (!__bridgeRef) {
      return Promise.reject(new Error('Host bridge is not available.'));
    }
    const result = __bridgeRef.apply(undefined, [
      __sessionId,
      'invoke',
      targetId,
      method,
      __sanitizeHostArgs(args),
    ], {
      arguments: { copy: true },
      result: { promise: true, copy: true },
    });
    return __trackHostPromise(Promise.resolve(result).then(__normalizeHostValue));
  }

  function __hostCallSync(targetId, method, args) {
    if (!__bridgeRef) {
      throw new Error('Host bridge is not available.');
    }
    return __normalizeHostValue(__bridgeRef.applySync(undefined, [
      __sessionId,
      'invokeSync',
      targetId,
      method,
      __sanitizeHostArgs(args),
    ], {
      arguments: { copy: true },
      result: { copy: true },
    }));
  }

  function __normalizeHostValue(value) {
    if (value && value.type === 'host-method') {
      const fn = value.sync
        ? (...args) => __hostCallSync(value.id, value.method, args)
        : (...args) => __trackHostPromise(__hostCall(value.id, value.method, args));
      fn.__hostMethodRef = { targetId: value.id, property: value.method };
      return fn;
    }
    if (value && typeof value.id === 'string' && value.dynamic) {
      return __makeDynamicHostProxy(value);
    }
    if (value && typeof value.id === 'string' && Array.isArray(value.methods)) {
      return __makeHostProxy(value);
    }
    return value;
  }

  function __hostProxyToStringValue(spec, hint) {
    if (hint === 'number') {
      return NaN;
    }
    try {
      const json = __hostRead(spec.id, '__json');
      if (json == null) {
        return '[HostObject]';
      }
      if (typeof json === 'string') {
        return json;
      }
      return JSON.stringify(json);
    } catch {
      return '[HostObject]';
    }
  }

  function __hostProxyCoercion(spec) {
    return function(hint) {
      return __hostProxyToStringValue(spec, hint);
    };
  }

  function __handleHostProxySymbol(spec, prop) {
    if (prop === Symbol.toPrimitive) {
      return __hostProxyCoercion(spec);
    }
    if (prop === Symbol.toStringTag) {
      return 'HostProxy';
    }
    return undefined;
  }

  function __hostProxyToJson(spec) {
    return () => __hostRead(spec.id, '__json');
  }

  function __makeDynamicHostProxy(spec) {
    return __markHostProxyTarget(new Proxy(Object.create(null), {
      get(obj, prop) {
        const symbolValue = __handleHostProxySymbol(spec, prop);
        if (symbolValue !== undefined) {
          return symbolValue;
        }
        if (typeof prop === 'symbol') {
          return undefined;
        }
        const key = String(prop);
        if (key === 'then' || key === 'catch' || key === 'finally') {
          return undefined;
        }
        if (key === 'toJSON') {
          return __hostProxyToJson(spec);
        }
        if (key === 'toString' || key === 'valueOf') {
          return () => __hostProxyToStringValue(spec, 'string');
        }
        return __normalizeHostValue(__hostRead(spec.id, key));
      },
      set(obj, prop, value) {
        __trackHostPromise(__hostCall(spec.id, '__set', [String(prop), value]));
        return true;
      },
    }), spec);
  }

  function __makeHostProxy(spec) {
    if (!spec) {
      return null;
    }
    if (spec.dynamic) {
      return __makeDynamicHostProxy(spec);
    }
    const methods = new Set(Array.isArray(spec.methods) ? spec.methods : []);
    const syncMethods = new Set(Array.isArray(spec.syncMethods) ? spec.syncMethods : []);
    const target = Object.assign({}, spec.snapshot || {});

    for (const method of methods) {
      if (method === '__call') {
        target.fetch = (...args) => __hostCall(spec.id, '__call', args);
        continue;
      }
      target[method] = syncMethods.has(method)
        ? (...args) => __hostCallSync(spec.id, method, args)
        : (...args) => __hostCall(spec.id, method, args);
    }

    return __markHostProxyTarget(new Proxy(target, {
      get(obj, prop) {
        const symbolValue = __handleHostProxySymbol(spec, prop);
        if (symbolValue !== undefined) {
          return symbolValue;
        }
        if (typeof prop === 'symbol') {
          return undefined;
        }
        const key = String(prop);
        if (key === 'then' || key === 'catch' || key === 'finally') {
          return undefined;
        }
        if (key === 'toJSON') {
          return __hostProxyToJson(spec);
        }
        if (key === 'toString' || key === 'valueOf') {
          return () => __hostProxyToStringValue(spec, 'string');
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
        __trackHostPromise(__hostCall(spec.id, '__set', [String(prop), value]));
        obj[prop] = value;
        return true;
      },
    }), spec);
  }

  function __looksLikeBlockedLocalPath(value) {
    if (typeof value !== 'string') {
      return false;
    }
    const trimmed = value.trim();
    if (/^https?:\\/\\//i.test(trimmed) || /^data:/i.test(trimmed)) {
      return false;
    }
    if (/^file:/i.test(trimmed) || trimmed.charAt(0) === '/' || /^[A-Za-z]:[\\\\/]/.test(trimmed)) {
      return true;
    }
    if (trimmed.startsWith('./') || trimmed.startsWith('../') || trimmed.startsWith('~')) {
      return true;
    }
    if (!/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
      return true;
    }
    return false;
  }

  function __makeModuleFunction(specId, fnName, sync) {
    const invoke = (...args) =>
      sync ? __hostCallSync(specId, fnName, args) : __hostCall(specId, fnName, args);
    const callable = function (...args) {
      return invoke(...args);
    };
    return new Proxy(callable, {
      construct(_target, args) {
        return invoke(...args);
      },
    });
  }

  function __buildModule(spec) {
    const mod = Object.assign({}, spec.constants || {});
    const syncFunctions = new Set(Array.isArray(spec.syncFunctions) ? spec.syncFunctions : []);
    for (let i = 0; i < spec.functions.length; i++) {
      const fnName = spec.functions[i];
      if (fnName === 'createAudioResource' || fnName === 'loadImage' || fnName === 'registerFont') {
        mod[fnName] = (...args) =>
          __looksLikeBlockedLocalPath(args[0])
            ? __hostCallSync(spec.id, fnName, args)
            : __hostCall(spec.id, fnName, args);
        continue;
      }
      mod[fnName] = __makeModuleFunction(spec.id, fnName, syncFunctions.has(fnName));
    }
    return mod;
  }

  globalThis.__sandboxSetup = {
    setSession: __setSession,
    setBridgeRef: __setBridgeRef,
    setDrainDeadline: __setDrainDeadline,
    setHostSpecs: __setHostSpecs,
    makeHostProxy: __makeHostProxy,
    buildModule: __buildModule,
  };
  globalThis.__drainPendingHostWork = __drainPendingHostWork;
  globalThis.setTimeout = (callback, ms = 0) =>
    __trackHostPromise(__hostCall('__delay', '__call', [ms]).then(() => callback()));
  globalThis.clearTimeout = (handle) =>
    __trackHostPromise(__hostCall('__clearTimeout', '__call', [handle]));

  const __globalEval = eval;
  globalThis.eval = (code) => {
    const source = String(code);
    const trimmed = source.trim();
    const needsAsyncWrapper =
      new RegExp('\\\\bawait\\\\b').test(source) ||
      new RegExp('\\\\breturn\\\\b').test(source) ||
      /[;{}]/.test(trimmed) ||
      trimmed.indexOf(String.fromCharCode(10)) !== -1;

    if (needsAsyncWrapper) {
      const looksLikeStatements =
        new RegExp('\\\\breturn\\\\b').test(source) ||
        /[;{}]/.test(trimmed) ||
        trimmed.indexOf(String.fromCharCode(10)) !== -1;
      const body = looksLikeStatements ? source : ('return (' + source + ')');
      const fn = __globalEval('(async () => {' + String.fromCharCode(10) + body + String.fromCharCode(10) + '})');
      return __trackHostPromise(Promise.resolve(fn()).then(__normalizeHostValue));
    }

    const result = __globalEval(source);
    if (result != null && typeof result.then === 'function') {
      return __trackHostPromise(Promise.resolve(result));
    }
    return result;
  };

  if (typeof queueMicrotask === 'function') {
    const __nativeQueueMicrotask = queueMicrotask;
    globalThis.queueMicrotask = (callback) => {
      __nativeQueueMicrotask(() => {
        __trackHostPromise(Promise.resolve().then(() => callback()));
      });
    };
  }
})();
`;

import type { ScriptRuntime } from './script-runtime.js';

export class ScriptIsolateRuntime implements ScriptRuntime {
  private readonly isolate: ivm.Isolate;
  private readonly bootstrap: ivm.Script;
  private readonly bridgeHost: ScriptBridgeHost;
  private disposed = false;

  constructor(memoryLimitMb = DEFAULT_MEMORY_LIMIT_MB) {
    this.isolate = new ivm.Isolate({ memoryLimit: memoryLimitMb });
    this.bootstrap = this.isolate.compileScriptSync(BOOTSTRAP_SCRIPT, {
      filename: 'bootstrap.js',
    });
    this.bridgeHost = new ScriptBridgeHost();
  }

  async execute(
    script: string,
    context: ScriptExecutionContext,
    logger: ScriptLogger,
    timeoutMs: number,
  ): Promise<unknown> {
    return this.executeInIsolate(script, context, logger, timeoutMs);
  }

  private async executeInIsolate(
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

    const ivmContext = await this.isolate.createContext();
    const jail = ivmContext.global;
    let sessionId = 0;
    let listenerDispatchRef: { release(): void } | null = null;

    try {
      await jail.set('global', jail.derefInto());
      this.bootstrap.runSync(ivmContext);

      const dispatchRef = ivmContext.evalClosureSync(
        'return function(id, args) { return globalThis.__dispatchHostListener(id, args); }',
        [],
        { result: { reference: true } },
      );
      listenerDispatchRef = dispatchRef;

      sessionId = this.bridgeHost.createSession(context, logger, (listenerId, args) =>
        dispatchRef.applySync(undefined, [listenerId, args], {
          arguments: { copy: true },
          result: { copy: true },
        }),
      );
      const { objectSpecs, moduleSpecs } = this.bridgeHost.getSessionSpecs(sessionId);

      jail.setSync('__hostBridge', this.bridgeHost.bridgeRef);

      const specs = objectSpecs.map((spec) => ({
        id: spec.id,
        snapshot: spec.snapshot,
        methods: spec.methods,
        dynamic: spec.dynamic ?? false,
      }));

      await ivmContext.evalSync(`
        const setup = globalThis.__sandboxSetup;
        setup.setSession(${sessionId});
        setup.setBridgeRef(__hostBridge);
        setup.setDrainDeadline(${timeoutMs});
        setup.setHostSpecs(${JSON.stringify(specs)});
        const __specs = ${JSON.stringify(specs)};
        const __moduleSpecs = ${JSON.stringify(moduleSpecs)};
        const __find = (id) => __specs.find((entry) => entry.id === id) ?? null;
        globalThis.client = setup.makeHostProxy(__find('client'));
        globalThis.interaction = setup.makeHostProxy(__find('interaction'));
        globalThis.message = setup.makeHostProxy(__find('message'));
        globalThis.member = setup.makeHostProxy(__find('member'));
        globalThis.guild = setup.makeHostProxy(__find('guild'));
        globalThis.channel = setup.makeHostProxy(__find('channel'));
        globalThis.db = setup.makeHostProxy(__find('db'));
        if (globalThis.db) {
          globalThis.db.global = setup.makeHostProxy(__find('db.global'));
          const __wrapScopedDb = (scopeId) => {
            const api = setup.makeHostProxy(__find(scopeId));
            return {
              set: (...args) => api.set(...args),
              get: (...args) => api.get(...args),
              delete: (...args) => api.delete(...args),
              list: async (key, order, limit, offset, filter) => {
                if (typeof filter !== 'function') {
                  return api.list(key, order, limit, offset);
                }
                const rows = await api.list(key, order ?? 'desc', 1000, 0);
                const filtered = rows.filter(filter);
                const off = offset ?? 0;
                const lim = limit ?? filtered.length;
                return filtered.slice(off, off + lim);
              },
              find: async (filter) => {
                if (typeof filter !== 'function') {
                  throw new Error(scopeId + '.find requires a filter function.');
                }
                const rows = await api.find();
                return rows.filter(filter);
              },
              reset: (...args) => api.reset(...args),
            };
          };
          globalThis.db.user = __wrapScopedDb('db.user');
          globalThis.db.guild = __wrapScopedDb('db.guild');
          globalThis.db.channel = __wrapScopedDb('db.channel');
          globalThis.db.message = __wrapScopedDb('db.message');
          globalThis.db.guildMember = __wrapScopedDb('db.guildMember');
        }
        globalThis.console = setup.makeHostProxy({
          id: 'console',
          snapshot: {},
          methods: ['log', 'info', 'warn', 'error', 'debug'],
        });
        globalThis.fetch = setup.makeHostProxy({
          id: '__fetch',
          snapshot: {},
          methods: ['__call'],
        }).fetch;
        globalThis.config = ${JSON.stringify(sanitizeConfigForScript(context.config))};
        globalThis.variables = ${JSON.stringify(context.variables)};
        globalThis.webhook = ${JSON.stringify(context.webhook ?? null)};
        globalThis.require = (name) => {
          const spec = __moduleSpecs.find((entry) => entry.name === name);
          if (!spec) {
            throw new Error('Module "' + name + '" is not allowed.');
          }
          return setup.buildModule(spec);
        };
        delete globalThis.__sandboxSetup;
        delete globalThis.__hostBridge;
      `);

      const wrappedScript = `(async () => {
try {
${trimmed}
} finally {
  await __drainPendingHostWork();
}
})();`;
      const compiled = await this.isolate.compileScript(wrappedScript, {
        filename: 'script.js',
      });

      try {
        const execution = compiled.run(ivmContext, {
          timeout: timeoutMs,
          promise: true,
          copy: true,
        });

        let result: unknown;
        try {
          result = await Promise.race([
            execution,
            new Promise<never>((_, reject) => {
              setTimeout(() => {
                reject(new Error(`Script execution timed out after ${timeoutMs}ms`));
              }, timeoutMs);
            }),
          ]);
        } finally {
          await execution.catch(() => undefined);
        }

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
      await this.bridgeHost.closeSession(sessionId, timeoutMs);
      try {
        listenerDispatchRef?.release();
      } catch {
        // Ignore release errors after context teardown.
      }
      ivmContext.release();
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.bridgeHost.dispose();
    this.bootstrap.release();
    this.isolate.dispose();
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new Error('Script isolate runtime has been disposed.');
    }
  }
}
