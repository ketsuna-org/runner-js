export function normalizeScopedStorageKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.startsWith('bc_') && trimmed.length > 3) {
    return trimmed.substring(3);
  }
  return trimmed;
}

export function toScopedReferenceKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length === 0 || trimmed.startsWith('bc_')) {
    return trimmed;
  }
  return `bc_${trimmed}`;
}
