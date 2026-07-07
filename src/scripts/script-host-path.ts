const HTTP_URL_PATTERN = /^https?:\/\//i;
const DATA_URL_PATTERN = /^data:/i;

export function assertHttpUrl(source: string, apiName: string): void {
  const trimmed = source.trim();
  if (!HTTP_URL_PATTERN.test(trimmed)) {
    throw new Error(`${apiName}: only http(s) URLs are allowed — local file paths are blocked.`);
  }
}

export function assertHttpOrDataUrl(source: string, apiName: string): void {
  const trimmed = source.trim();
  if (!HTTP_URL_PATTERN.test(trimmed) && !DATA_URL_PATTERN.test(trimmed)) {
    throw new Error(`${apiName}: only http(s) or data URLs are allowed — local file paths are blocked.`);
  }
}

export function isBlockedLocalPath(source: string): boolean {
  const trimmed = source.trim();
  if (HTTP_URL_PATTERN.test(trimmed) || DATA_URL_PATTERN.test(trimmed)) {
    return false;
  }
  if (/^file:/i.test(trimmed)) {
    return true;
  }
  if (trimmed.startsWith('/')) {
    return true;
  }
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) {
    return true;
  }
  if (trimmed.startsWith('./') || trimmed.startsWith('../') || trimmed.startsWith('~')) {
    return true;
  }
  // Bare relative paths (no URL scheme) are treated as filesystem paths.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    return true;
  }
  return false;
}
