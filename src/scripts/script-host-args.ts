import { isBlockedLocalPath } from './script-host-path.js';

function assertAllowedAttachmentSource(value: unknown, label: string): void {
  if (typeof value === 'string' && isBlockedLocalPath(value)) {
    throw new Error(`${label}: local file paths are blocked — use http(s) URLs or buffers.`);
  }

  if (value == null || typeof value !== 'object' || Buffer.isBuffer(value)) {
    return;
  }

  const record = value as Record<string, unknown>;
  if ('attachment' in record) {
    assertAllowedAttachmentSource(record.attachment, `${label}.attachment`);
  }
}

function assertAllowedAttachmentValue(value: unknown, label: string): void {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      assertAllowedAttachmentValue(value[index], `${label}[${index}]`);
    }
    return;
  }

  assertAllowedAttachmentSource(value, label);
}

export function assertAllowedHostInvokeArgs(args: unknown[]): void {
  for (let index = 0; index < args.length; index += 1) {
    assertAllowedHostArgValue(args[index], `argument ${index}`);
  }
}

function assertAllowedHostArgValue(value: unknown, label: string): void {
  if (typeof value === 'string') {
    return;
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      assertAllowedHostArgValue(value[index], `${label}[${index}]`);
    }
    return;
  }

  if (value == null || typeof value !== 'object' || Buffer.isBuffer(value)) {
    return;
  }

  const record = value as Record<string, unknown>;
  for (const [key, entry] of Object.entries(record)) {
    if (key === 'files' || key === 'file') {
      assertAllowedAttachmentValue(entry, `${label}.${key}`);
      continue;
    }

    if (key === 'attachment') {
      assertAllowedAttachmentSource(entry, `${label}.attachment`);
      continue;
    }

    if (entry != null && typeof entry === 'object' && !Buffer.isBuffer(entry)) {
      assertAllowedHostArgValue(entry, `${label}.${key}`);
    }
  }
}
