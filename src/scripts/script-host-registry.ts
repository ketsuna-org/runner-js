export interface HostProxyDescriptor {
  id: string;
  snapshot: Record<string, unknown>;
  methods: string[];
  dynamic?: boolean;
}

export interface HostArgRef {
  __hostArgRef: string;
}

export interface HostMethodRef {
  __hostMethodRef: {
    targetId: string;
    property: string;
  };
}

export interface HostListenerRef {
  __hostListenerRef: number;
}

export function isHostListenerRef(value: unknown): value is HostListenerRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as HostListenerRef).__hostListenerRef === 'number'
  );
}

export function isHostArgRef(value: unknown): value is HostArgRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as HostArgRef).__hostArgRef === 'string'
  );
}

export function isHostMethodRef(value: unknown): value is HostMethodRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as HostMethodRef).__hostMethodRef?.targetId === 'string' &&
    typeof (value as HostMethodRef).__hostMethodRef?.property === 'string'
  );
}

export class HostObjectRegistry {
  private readonly objects = new Map<string, unknown>();
  private sequence = 0;

  register(prefix: string, target: unknown): string {
    const id = `${prefix}:${++this.sequence}`;
    this.objects.set(id, target);
    return id;
  }

  has(id: string): boolean {
    return this.objects.has(id);
  }

  resolve(id: string): unknown {
    const target = this.objects.get(id);
    if (target == null) {
      throw new Error(`Host object "${id}" is not available.`);
    }
    return target;
  }

  clear(): void {
    this.objects.clear();
    this.sequence = 0;
  }
}

export function isHostProxyDescriptor(value: unknown): value is HostProxyDescriptor {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as HostProxyDescriptor).id === 'string' &&
    Array.isArray((value as HostProxyDescriptor).methods)
  );
}
