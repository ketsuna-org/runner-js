import { format, formatWithOptions, inspect, types } from 'node:util';

const UTIL_TYPE_PREDICATES = [
  'isArray',
  'isArrayBuffer',
  'isAsyncFunction',
  'isBigInt64Array',
  'isBigUint64Array',
  'isBoolean',
  'isBuffer',
  'isDataView',
  'isDate',
  'isExternal',
  'isFloat32Array',
  'isFloat64Array',
  'isFunction',
  'isGeneratorFunction',
  'isInt8Array',
  'isInt16Array',
  'isInt32Array',
  'isMap',
  'isModuleNamespaceObject',
  'isNativeError',
  'isNull',
  'isNumber',
  'isObject',
  'isPromise',
  'isRegExp',
  'isSet',
  'isString',
  'isSymbol',
  'isTypedArray',
  'isUint8Array',
  'isUint8ClampedArray',
  'isUint16Array',
  'isUint32Array',
  'isWeakMap',
  'isWeakSet',
] as const;

export function getUtilModuleConstants(): Record<string, unknown> {
  const predicates: Record<string, unknown> = {};
  for (const name of UTIL_TYPE_PREDICATES) {
    const predicate = types[name as keyof typeof types];
    if (typeof predicate === 'function') {
      predicates[name] = predicate;
    }
  }
  return { types: predicates };
}

export function buildUtilModule() {
  const module: Record<string, unknown> = {
    inspect: (value: unknown, options?: unknown) =>
      inspect(value, options as never),
    format: (formatString: string, ...args: unknown[]) => format(formatString, ...args),
    formatWithOptions: (options: unknown, formatString: string, ...args: unknown[]) =>
      formatWithOptions(options as never, formatString, ...args),
  };

  const predicates: Record<string, unknown> = {};
  for (const name of UTIL_TYPE_PREDICATES) {
    const predicate = types[name as keyof typeof types];
    if (typeof predicate === 'function') {
      predicates[name] = predicate;
      module[name] = predicate;
    }
  }
  module.types = predicates;
  return module;
}
