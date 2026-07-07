import { mkdtemp, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { assertHttpUrl, isBlockedLocalPath } from './script-host-path.js';

const MAX_FONT_BYTES = 5 * 1024 * 1024;

let fontTempDir: string | null = null;

function fontExtensionFromUrl(url: string): string {
  try {
    const match = new URL(url).pathname.match(/\.(ttf|otf|woff2?)$/i);
    if (match) {
      return `.${match[1]!.toLowerCase()}`;
    }
  } catch {
    // Fall back to .ttf below.
  }
  return '.ttf';
}

async function ensureFontTempDir(): Promise<string> {
  fontTempDir ??= await mkdtemp(path.join(tmpdir(), 'runner-js-fonts-'));
  return fontTempDir;
}

export function assertAllowedFontSource(source: string): void {
  if (isBlockedLocalPath(source)) {
    throw new Error('registerFont: only http(s) URLs are allowed — local file paths are blocked.');
  }
  assertHttpUrl(source, 'registerFont');
}

export async function registerRemoteFont(
  registerFont: (filePath: string, options: { family: string }) => void,
  source: string,
  options: { family: string },
): Promise<void> {
  assertAllowedFontSource(source);

  const response = await fetch(source);
  if (!response.ok) {
    throw new Error(`Failed to fetch font URL (${response.status} ${response.statusText}).`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength === 0) {
    throw new Error('Font URL returned an empty body.');
  }
  if (buffer.byteLength > MAX_FONT_BYTES) {
    throw new Error(
      `Font file is too large (${buffer.byteLength} bytes). Maximum allowed is ${MAX_FONT_BYTES} bytes.`,
    );
  }

  const dir = await ensureFontTempDir();
  const filePath = path.join(dir, `${randomUUID()}${fontExtensionFromUrl(source)}`);
  await writeFile(filePath, buffer);
  registerFont(filePath, options);
}
