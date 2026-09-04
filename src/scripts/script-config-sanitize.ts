import type { JsBotConfig } from '../config/js-bot-config.js';

const sanitizedConfigCache = new WeakMap<object, Record<string, unknown>>();

/**
 * Returns a plain config object safe to expose to user scripts:
 * strips token / webhook secrets and redacts nested sensitive keys.
 */
export function sanitizeConfigForScript(config: JsBotConfig): Record<string, unknown> {
  if (config == null || typeof config !== 'object') {
    return {};
  }
  const cached = sanitizedConfigCache.get(config);
  if (cached) {
    return cached;
  }

  const { token: _token, inboundWebhooks, databaseConfig, ...safeConfig } = config;
  const sanitized: Record<string, unknown> = {
    ...safeConfig,
    databaseConfig: databaseConfig ? { type: databaseConfig.type || 'none' } : { type: 'none' },
    inboundWebhooks: (inboundWebhooks ?? []).map(({ secret: _secret, ...webhook }) => webhook),
  };
  const result = copyHostValue(sanitized, { redactSensitive: true }) as Record<string, unknown>;
  sanitizedConfigCache.set(config, result);
  return result;
}

function copyHostValue(
  value: unknown,
  options?: { redactSensitive?: boolean },
  seen: WeakSet<object> = new WeakSet(),
): unknown {
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
    return value.map((entry) => copyHostValue(entry, options, seen));
  }

  if (typeof value === 'object') {
    if (seen.has(value)) {
      return undefined;
    }
    seen.add(value);

    if (typeof (value as { toJSON?: () => unknown }).toJSON === 'function') {
      try {
        return copyHostValue((value as { toJSON: () => unknown }).toJSON(), options, seen);
      } catch {
        // Fall through to manual copy.
      }
    }

    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'token' || key === 'secret' || (options?.redactSensitive && key === 'client')) {
        continue;
      }
      if (typeof entry === 'function') {
        continue;
      }
      try {
        const copied = copyHostValue(entry, options, seen);
        if (copied !== undefined) {
          output[key] = copied;
        }
      } catch {
        // Skip non-serializable fields.
      }
    }
    return output;
  }

  return String(value);
}
