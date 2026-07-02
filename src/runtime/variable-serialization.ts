export function serializeVariableValue(value: unknown): { raw: string; type: string } {
  const normalized = normalizeVariableValue(value);
  if (normalized == null) {
    return { raw: 'null', type: 'null' };
  }
  if (typeof normalized === 'boolean') {
    return { raw: String(normalized), type: 'bool' };
  }
  if (typeof normalized === 'number') {
    return { raw: String(normalized), type: 'number' };
  }
  if (typeof normalized === 'string') {
    return { raw: normalized, type: 'string' };
  }
  return { raw: JSON.stringify(normalized), type: 'json' };
}

export function deserializeVariableValue(raw: string, type: string): unknown {
  switch (type) {
    case 'number': {
      const parsed = Number.parseFloat(raw);
      return Number.isFinite(parsed) ? parsed : raw;
    }
    case 'bool':
      return raw.toLowerCase() === 'true';
    case 'null':
      return null;
    case 'json':
      try {
        return normalizeVariableValue(JSON.parse(raw));
      } catch {
        return raw;
      }
    default:
      return raw;
  }
}

export function compareVariableValues(left: unknown, right: unknown, descending: boolean): number {
  const leftNum = coerceSortNumber(left);
  const rightNum = coerceSortNumber(right);
  let cmp = 0;
  if (leftNum != null && rightNum != null) {
    cmp = leftNum - rightNum;
  } else {
    cmp = String(left).localeCompare(String(right));
  }
  return descending ? -cmp : cmp;
}

function coerceSortNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeVariableValue(value: unknown): unknown {
  if (value == null) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeVariableValue(entry));
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) {
      normalized[key] = normalizeVariableValue(entry);
    }
    return normalized;
  }
  return value;
}
