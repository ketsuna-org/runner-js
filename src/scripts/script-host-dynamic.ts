import type { ModuleRegistry } from './script-host-modules.js';
import {
  type HostProxyDescriptor,
  isHostProxyDescriptor,
} from './script-host-registry.js';

export interface HostMethodBridge {
  type: 'host-method';
  id: string;
  method: string;
}

export const CLIENT_BLOCKED_PROPERTIES = new Set(['token']);

export function isHostMethodBridge(value: unknown): value is HostMethodBridge {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as HostMethodBridge).type === 'host-method' &&
    typeof (value as HostMethodBridge).id === 'string' &&
    typeof (value as HostMethodBridge).method === 'string'
  );
}

export function isBlockedClientProperty(
  clientRoot: unknown,
  target: unknown,
  property: string,
): boolean {
  return CLIENT_BLOCKED_PROPERTIES.has(property) && target === clientRoot;
}

export function wrapDynamicHostRead(
  moduleRegistry: ModuleRegistry,
  targetId: string,
  property: string,
  value: unknown,
): unknown {
  if (value == null) {
    return value;
  }

  if (typeof value === 'function') {
    return {
      type: 'host-method',
      id: targetId,
      method: property,
    } satisfies HostMethodBridge;
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Buffer.isBuffer(value)) {
    return value.toString('base64');
  }

  if (Array.isArray(value)) {
    return value.map((entry) => wrapDynamicHostRead(moduleRegistry, targetId, property, entry));
  }

  const wrapped = moduleRegistry.wrapHostResult(value);
  if (isHostProxyDescriptor(wrapped)) {
    return asDynamicDescriptor(wrapped);
  }

  if (typeof value === 'object') {
    const id = moduleRegistry.registry.register('host', value);
    return asDynamicDescriptor({
      id,
      snapshot: {},
      methods: [],
    });
  }

  return String(value);
}

export function asDynamicDescriptor(descriptor: HostProxyDescriptor): HostProxyDescriptor {
  return {
    ...descriptor,
    dynamic: true,
  };
}
