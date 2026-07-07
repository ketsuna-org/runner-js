import type { ModuleRegistry } from './script-host-modules.js';
import {
  isBlockedClientProperty,
  wrapDynamicHostRead,
} from './script-host-dynamic.js';
import { HostObjectRegistry, isHostProxyDescriptor } from './script-host-registry.js';

export async function invokeHostTarget(
  moduleRegistry: ModuleRegistry,
  targets: Map<string, unknown>,
  targetId: string,
  method: string,
  args: unknown[],
  clientRoot?: unknown,
): Promise<unknown> {
  const { registry, wrapHostResult } = moduleRegistry;

  if (method === '__set') {
    const [property, value] = args;
    const target = resolveInvokeTarget(moduleRegistry, registry, targets, targetId);
    if (clientRoot != null && isBlockedClientProperty(clientRoot, target, String(property))) {
      throw new Error('Cannot set "token" on client.');
    }
    (target as Record<string, unknown>)[String(property)] = value;
    return undefined;
  }

  const target = resolveInvokeTarget(moduleRegistry, registry, targets, targetId);

  if (typeof target === 'function') {
    return wrapHostResult(await (target as (...fnArgs: unknown[]) => unknown)(...args));
  }

  const record = target as Record<string, unknown>;
  const fn = record[method];
  if (typeof fn !== 'function') {
    throw new Error(`Host bridge method "${targetId}.${method}" is not available.`);
  }

  return wrapHostResult(await fn.apply(target, args));
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
