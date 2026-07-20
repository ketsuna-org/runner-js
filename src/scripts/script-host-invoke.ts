import type { ModuleRegistry } from './script-host-modules.js';
import { assertAllowedHostInvokeArgs } from './script-host-args.js';
import { assertValidAudioResourceForPlay } from './script-host-voice-play.js';
import { isBlockedClientProperty } from './script-host-dynamic.js';
import {
  HostObjectRegistry,
  type HostMethodRef,
  isHostArgRef,
  isHostListenerRef,
  isHostMethodRef,
  isHostProxyDescriptor,
} from './script-host-registry.js';

const LISTENER_ATTACH_METHODS = new Set(['on', 'once', 'addListener']);

export type HostListenerAttachment = {
  target: { off?: (event: string | symbol, listener: (...args: unknown[]) => void) => void; removeListener?: (event: string | symbol, listener: (...args: unknown[]) => void) => void };
  event: string | symbol;
  listener: (...args: unknown[]) => void;
};

export async function invokeHostTarget(
  moduleRegistry: ModuleRegistry,
  targets: Map<string, unknown>,
  targetId: string,
  method: string,
  args: unknown[],
  clientRoot?: unknown,
  dispatchListener?: (listenerId: number, args: unknown[]) => unknown,
  trackListener?: (attachment: HostListenerAttachment) => void,
): Promise<unknown> {
  return invokeHostTargetInternal(
    moduleRegistry,
    targets,
    targetId,
    method,
    args,
    clientRoot,
    'async',
    dispatchListener,
    trackListener,
  ) as Promise<unknown>;
}

export function invokeHostTargetSync(
  moduleRegistry: ModuleRegistry,
  targets: Map<string, unknown>,
  targetId: string,
  method: string,
  args: unknown[],
  clientRoot?: unknown,
  dispatchListener?: (listenerId: number, args: unknown[]) => unknown,
  trackListener?: (attachment: HostListenerAttachment) => void,
): unknown {
  return invokeHostTargetInternal(
    moduleRegistry,
    targets,
    targetId,
    method,
    args,
    clientRoot,
    'sync',
    dispatchListener,
    trackListener,
  );
}

function invokeHostTargetInternal(
  moduleRegistry: ModuleRegistry,
  targets: Map<string, unknown>,
  targetId: string,
  method: string,
  args: unknown[],
  clientRoot: unknown | undefined,
  mode: 'sync' | 'async',
  dispatchListener?: (listenerId: number, args: unknown[]) => unknown,
  trackListener?: (attachment: HostListenerAttachment) => void,
): unknown {
  const { registry, wrapHostResult } = moduleRegistry;

  const resolvedArgs = args.map((arg) =>
    resolveBridgeArg(moduleRegistry, registry, targets, arg, dispatchListener),
  );
  assertAllowedHostInvokeArgs(resolvedArgs);

  if (method === '__set') {
    const [property, value] = resolvedArgs;
    const target = resolveInvokeTarget(moduleRegistry, registry, targets, targetId);
    if (clientRoot != null && isBlockedClientProperty(clientRoot, target, String(property))) {
      throw new Error('Cannot set "token" on client.');
    }
    (target as Record<string, unknown>)[String(property)] = value;
    return undefined;
  }

  const target = resolveInvokeTarget(moduleRegistry, registry, targets, targetId);

  if (method === 'play' && targetId.startsWith('audio-player:')) {
    assertValidAudioResourceForPlay(resolvedArgs[0]);
    moduleRegistry.voiceSession?.markPlayerPlayed(target as never);
  }

  if (
    trackListener &&
    LISTENER_ATTACH_METHODS.has(method) &&
    typeof resolvedArgs[1] === 'function'
  ) {
    trackListener({
      target: target as HostListenerAttachment['target'],
      event: resolvedArgs[0] as string | symbol,
      listener: resolvedArgs[1] as (...args: unknown[]) => void,
    });
  }

  if (typeof target === 'function') {
    const rawResult = (target as (...fnArgs: unknown[]) => unknown)(...resolvedArgs);
    return finalizeInvokeResult(targetId, method, rawResult, wrapHostResult, mode);
  }

  const record = target as Record<string, unknown>;
  const fn = record[method];
  if (typeof fn !== 'function') {
    throw new Error(`Host bridge method "${targetId}.${method}" is not available.`);
  }

  const rawResult = fn.apply(target, resolvedArgs);
  return finalizeInvokeResult(targetId, method, rawResult, wrapHostResult, mode);
}

function finalizeInvokeResult(
  targetId: string,
  method: string,
  rawResult: unknown,
  wrapHostResult: (value: unknown) => unknown,
  mode: 'sync' | 'async',
): unknown {
  if (mode === 'sync') {
    if (rawResult != null && typeof (rawResult as Promise<unknown>).then === 'function') {
      throw new Error(`Host bridge method "${targetId}.${method}" is async — use await.`);
    }
    return wrapHostResult(rawResult);
  }

  return Promise.resolve(rawResult).then((value) => wrapHostResult(value));
}

function resolveBridgeArg(
  moduleRegistry: ModuleRegistry,
  registry: HostObjectRegistry,
  targets: Map<string, unknown>,
  value: unknown,
  dispatchListener?: (listenerId: number, args: unknown[]) => unknown,
): unknown {
  if (isHostProxyDescriptor(value) || isHostArgRef(value)) {
    const id = isHostArgRef(value) ? value.__hostArgRef : value.id;
    return resolveInvokeTarget(moduleRegistry, registry, targets, id);
  }

  if (isHostMethodRef(value)) {
    return resolveHostMethodRef(moduleRegistry, registry, targets, value);
  }

  if (isHostListenerRef(value)) {
    if (!dispatchListener) {
      throw new Error('Host listener bridge is not available.');
    }
    const listenerId = value.__hostListenerRef;
    const { wrapHostResult } = moduleRegistry;
    return (...args: unknown[]) =>
      dispatchListener(
        listenerId,
        args.map((arg) => finalizeHostValue(wrapHostResult, arg)),
      );
  }

  if (Array.isArray(value)) {
    return value.map((entry) =>
      resolveBridgeArg(moduleRegistry, registry, targets, entry, dispatchListener),
    );
  }

  if (value != null && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      output[key] = resolveBridgeArg(moduleRegistry, registry, targets, entry, dispatchListener);
    }
    return output;
  }

  return value;
}

function resolveHostMethodRef(
  moduleRegistry: ModuleRegistry,
  registry: HostObjectRegistry,
  targets: Map<string, unknown>,
  value: HostMethodRef,
): unknown {
  const target = resolveInvokeTarget(
    moduleRegistry,
    registry,
    targets,
    value.__hostMethodRef.targetId,
  );
  const fn = (target as Record<string, unknown>)[value.__hostMethodRef.property];
  if (typeof fn !== 'function') {
    throw new Error(
      `Host property "${value.__hostMethodRef.property}" on "${value.__hostMethodRef.targetId}" is not a function.`,
    );
  }
  return fn.bind(target);
}

export function resolveInvokeTarget(
  moduleRegistry: ModuleRegistry,
  registry: HostObjectRegistry,
  targets: Map<string, unknown>,
  targetId: string,
): unknown {
  if (registry.has(targetId)) {
    return registry.resolve(targetId);
  }

  const moduleTarget = moduleRegistry.getInvokeTarget(targetId);
  if (moduleTarget != null) {
    return moduleTarget;
  }

  const target = targets.get(targetId);
  if (target == null) {
    throw new Error(`Host bridge target "${targetId}" is not available.`);
  }

  return target;
}

export function finalizeHostValue(
  wrapHostResult: (value: unknown) => unknown,
  value: unknown,
): unknown {
  if (isHostProxyDescriptor(value)) {
    return value;
  }
  return wrapHostResult(value);
}
