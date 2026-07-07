import ivm from 'isolated-vm';

import type { JsBotConfig } from '../config/js-bot-config.js';
import { invokeHostTarget, resolveInvokeTarget } from './script-host-invoke.js';
import { isBlockedClientProperty, wrapDynamicHostRead } from './script-host-dynamic.js';
import type { ModuleRegistry } from './script-host-modules.js';
import { createScriptModuleRegistry, type ModuleSpec } from './script-module-specs.js';
import type { ScriptDb } from './script-db.js';
import type { ScriptExecutionContext, ScriptLogger } from './script-context.js';

export interface HostObjectSpec {
  id: string;
  snapshot: Record<string, unknown>;
  methods: string[];
  target: unknown;
  dynamic?: boolean;
}

export interface HostBridgeBundle {
  bridgeRef: ivm.Reference<
    (kind: string, arg1: string, arg2: unknown, arg3?: unknown) => unknown
  >;
  objectSpecs: HostObjectSpec[];
  moduleSpecs: ModuleSpec[];
  moduleRegistry: ModuleRegistry;
  release: () => void;
  clearTimers: () => void;
  drain: (timeoutMs: number) => Promise<void>;
}

const DB_METHODS = ['get', 'set', 'delete', 'has', 'list', 'reset'] as const;
const DB_GLOBAL_METHODS = ['get', 'set', 'delete', 'has'] as const;
const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;

function registerDynamicHost(
  register: (spec: HostObjectSpec) => void,
  id: string,
  target: unknown,
): void {
  register({
    id,
    target,
    snapshot: {},
    methods: [],
    dynamic: true,
  });
}

export function buildHostBridge(
  context: ScriptExecutionContext,
  logger: ScriptLogger,
): HostBridgeBundle {
  const targets = new Map<string, unknown>();
  const objectSpecs: HostObjectSpec[] = [];
  const timers = new Set<NodeJS.Timeout>();
  const { moduleRegistry, moduleSpecs } = createScriptModuleRegistry(context);
  let released = false;
  let bridgeInFlight = 0;

  const register = (spec: HostObjectSpec) => {
    targets.set(spec.id, spec.target);
    objectSpecs.push(spec);
  };

  if (context.client) {
    registerDynamicHost(register, 'client', context.client);
  }

  if (context.interaction) {
    registerDynamicHost(register, 'interaction', context.interaction);
  }

  if (context.message) {
    registerDynamicHost(register, 'message', context.message);
  }

  if (context.member) {
    registerDynamicHost(register, 'member', context.member);
  }

  if (context.guild) {
    registerDynamicHost(register, 'guild', context.guild);
  }

  if (context.channel) {
    registerDynamicHost(register, 'channel', context.channel);
  }

  if (context.db) {
    registerDbTargets(context.db, register);
  }

  register({
    id: 'console',
    target: logger,
    snapshot: {},
    methods: [...CONSOLE_METHODS],
  });

  targets.set('__fetch', fetch);
  targets.set('__delay', (ms = 0) =>
    new Promise<void>((resolve) => {
      const handle = setTimeout(() => resolve(), Number(ms) || 0);
      timers.add(handle);
    }),
  );
  targets.set('__clearTimeout', (handle: NodeJS.Timeout) => {
    clearTimeout(handle);
    timers.delete(handle);
  });

  const invoke = async (targetId: string, method: string, args: unknown[]) => {
    if (released) {
      return undefined;
    }

    if (targetId === '__fetch') {
      const response = await fetch(...(args as Parameters<typeof fetch>));
      return moduleRegistry.wrapHostResult(await responseToPlain(response));
    }

    return invokeHostTarget(
      moduleRegistry,
      targets,
      targetId,
      method,
      args,
      context.client,
    );
  };

  const readPropertySync = (targetId: string, property: string): unknown => {
    const target = resolveInvokeTarget(
      moduleRegistry,
      moduleRegistry.registry,
      targets,
      targetId,
    );

    if (
      context.client != null &&
      isBlockedClientProperty(context.client, target, property)
    ) {
      return undefined;
    }

    const value = (target as Record<string, unknown>)[property];
    const spec = objectSpecs.find((entry) => entry.id === targetId);

    if (spec?.dynamic || moduleRegistry.registry.has(targetId)) {
      return wrapDynamicHostRead(moduleRegistry, targetId, property, value);
    }

    return copyHostValue(value);
  };

  const bridgeDispatch = (
    kind: string,
    arg1: string,
    arg2: unknown,
    arg3?: unknown,
  ): unknown => {
    if (released) {
      return undefined;
    }

    if (kind === 'read') {
      return readPropertySync(arg1, arg2 as string);
    }

    bridgeInFlight += 1;
    return invoke(arg1, arg2 as string, arg3 as unknown[]).finally(() => {
      bridgeInFlight -= 1;
    });
  };

  const drain = async (timeoutMs: number): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (bridgeInFlight > 0 && Date.now() < deadline) {
      await delay(10);
    }
  };

  const bridgeRef = new ivm.Reference(bridgeDispatch);

  return {
    bridgeRef,
    objectSpecs,
    moduleSpecs,
    moduleRegistry,
    release: () => {
      released = true;
      for (const handle of timers) {
        clearTimeout(handle);
      }
      timers.clear();
      targets.clear();
      moduleRegistry.registry.clear();
      bridgeRef.release();
    },
    clearTimers: () => {
      for (const handle of timers) {
        clearTimeout(handle);
      }
      timers.clear();
    },
    drain,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function sanitizeConfigForScript(config: JsBotConfig): Record<string, unknown> {
  const { token: _token, ...safeConfig } = config;
  return copyHostValue(safeConfig) as Record<string, unknown>;
}

function registerDbTargets(
  db: ScriptDb,
  register: (spec: HostObjectSpec) => void,
): void {
  register({
    id: 'db',
    target: db,
    snapshot: {},
    methods: [...DB_METHODS],
  });
  register({
    id: 'db.global',
    target: db.global,
    snapshot: {},
    methods: [...DB_GLOBAL_METHODS],
  });
}

async function responseToPlain(response: Response): Promise<Record<string, unknown>> {
  const bodyText = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    url: response.url,
    headers: Object.fromEntries(response.headers.entries()),
    body: bodyText,
  };
}

function copyHostValue(value: unknown): unknown {
  if (value == null) {
    return value;
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (Buffer.isBuffer(value)) {
    return value.toString('base64');
  }

  if (Array.isArray(value)) {
    return value.map((entry) => copyHostValue(entry));
  }

  if (typeof value === 'object') {
    if (typeof (value as { toJSON?: () => unknown }).toJSON === 'function') {
      try {
        return copyHostValue((value as { toJSON: () => unknown }).toJSON());
      } catch {
        // Fall through to manual copy.
      }
    }

    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (typeof entry === 'function') {
        continue;
      }
      try {
        output[key] = copyHostValue(entry);
      } catch {
        // Skip non-serializable fields.
      }
    }
    return output;
  }

  return String(value);
}
