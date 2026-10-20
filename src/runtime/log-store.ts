import { appendFile, mkdir, readFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';

export interface LogLine {
  ts: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  botId?: string;
  message: string;
}

// Lignes toujours recopiées sur stdout, quel que soit leur niveau : `kubectl logs` doit montrer
// pourquoi un bot ne démarre pas ou s'est déconnecté (le fichier runner.log n'est pas visible).
const STDOUT_MIRRORED_PREFIXES = ['Bot start failed', 'Fatal disconnect', 'Intent warning'];

// Jetons Discord (3 segments base64url) et en-têtes `Bot <token>` : jamais écrits sur stdout.
const DISCORD_TOKEN_PATTERN = /[\w-]{23,28}\.[\w-]{6,7}\.[\w-]{27,}/g;
const BOT_AUTH_PATTERN = /\bBot\s+[\w.-]{20,}/g;

function redactSecrets(text: string): string {
  return text.replace(DISCORD_TOKEN_PATTERN, '[redacted]').replace(BOT_AUTH_PATTERN, 'Bot [redacted]');
}

// Une ligne mirroir = une ligne stdout : les retours à la ligne (et autres caractères de contrôle)
// d'un message sont rendus visibles, sinon un script pourrait forger une ligne du runner.
const CONTROL_CHARS_PATTERN = /\r\n|[\r\n\u2028\u2029]|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const MAX_MIRRORED_LINE_CHARS = 2000;

function sanitizeMirrorLine(text: string): string {
  const flat = redactSecrets(text).replace(CONTROL_CHARS_PATTERN, (char) =>
    char === '\r\n' || char === '\n' ? '\\n' : char === '\r' ? '\\r' : ' ',
  );
  return flat.length > MAX_MIRRORED_LINE_CHARS
    ? `${flat.slice(0, MAX_MIRRORED_LINE_CHARS)}... [truncated ${flat.length - MAX_MIRRORED_LINE_CHARS} chars]`
    : flat;
}

/**
 * `runner` : lignes émises par le runner lui-même. `script` : tout ce que produisent les scripts
 * et handlers (console.warn/error, « Handler script failed ») ; le volume suit le trafic.
 */
export type LogOrigin = 'runner' | 'script';

// Plafond par bot des lignes d'origine script recopiées sur stdout (le fichier les garde toutes).
const SCRIPT_MIRROR_WINDOW_MS = 60_000;
const SCRIPT_MIRROR_MAX_LINES_PER_WINDOW = 20;

function shouldMirrorToStdout(
  level: LogLine['level'],
  message: string,
  origin: LogOrigin,
): boolean {
  if (origin === 'script') {
    // Jamais les préfixes inconditionnels : un script ne doit pas se faire passer pour le runner.
    return level === 'warn' || level === 'error';
  }
  return (
    level === 'warn' ||
    level === 'error' ||
    STDOUT_MIRRORED_PREFIXES.some((prefix) => message.startsWith(prefix))
  );
}

export class LogStore {
  private readonly lines: LogLine[] = [];
  private readonly maxLines: number;
  private readonly maxFileBytes: number;
  private fileBytes = 0;
  private readonly scriptMirror = new Map<string, { windowStart: number; count: number }>();
  // Writes are chained so lines keep their order and a rotation never races an append.
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly logFile: string,
    maxLines = 2000,
    // The file used to grow forever on a long-lived node. Past this size it is moved to
    // `<file>.1` (one generation kept, the previous `.1` is replaced).
    maxFileBytes = 10 * 1024 * 1024,
  ) {
    this.maxLines = maxLines;
    this.maxFileBytes = maxFileBytes;
  }

  async init(): Promise<void> {
    await mkdir(path.dirname(this.logFile), { recursive: true });
    await this.hydrateFromFile();
    try {
      this.fileBytes = (await stat(this.logFile)).size;
    } catch {
      this.fileBytes = 0;
    }
  }

  /** Resolves once every queued write (and rotation) has reached the disk. */
  flush(): Promise<void> {
    return this.writeQueue;
  }

  private static readonly MAX_LOG_AGE_MS = 7 * 24 * 60 * 60 * 1000;

  private async hydrateFromFile(): Promise<void> {
    try {
      const raw = await readFile(this.logFile, 'utf8');
      const lines = raw.split('\n').filter((line) => line.trim().length > 0);
      const slice = lines.slice(-this.maxLines);
      const now = Date.now();
      for (const line of slice) {
        const parsed = parseStoredLogLine(line);
        if (parsed) {
          const logTime = new Date(parsed.ts).getTime();
          if (Number.isFinite(logTime) && now - logTime > LogStore.MAX_LOG_AGE_MS) {
            continue; // Skip logs older than 7 days TTL
          }
          this.lines.push(parsed);
        }
      }
    } catch {
      // fresh log file
    }
  }

  /** true tant que le bot reste sous le plafond de lignes script ; une seule ligne signale la coupure. */
  private allowScriptMirror(botId: string | undefined): boolean {
    const key = botId ?? '';
    const now = Date.now();
    let entry = this.scriptMirror.get(key);
    if (!entry || now - entry.windowStart >= SCRIPT_MIRROR_WINDOW_MS) {
      entry = { windowStart: now, count: 0 };
      this.scriptMirror.set(key, entry);
    }
    entry.count += 1;
    if (entry.count === SCRIPT_MIRROR_MAX_LINES_PER_WINDOW + 1) {
      console.log(
        sanitizeMirrorLine(
          `[${new Date(now).toISOString()}] [WARN]${botId ? ` [bot:${botId}]` : ''} ` +
            `Script log lines suppressed on stdout (more than ${SCRIPT_MIRROR_MAX_LINES_PER_WINDOW} per minute); runner.log keeps them all`,
        ),
      );
    }
    return entry.count <= SCRIPT_MIRROR_MAX_LINES_PER_WINDOW;
  }

  append(
    level: LogLine['level'],
    message: string,
    botId?: string,
    origin: LogOrigin = 'runner',
  ): void {
    const line: LogLine = {
      ts: new Date().toISOString(),
      level,
      botId,
      message,
    };

    this.lines.push(line);
    if (this.lines.length > this.maxLines) {
      this.lines.splice(0, this.lines.length - this.maxLines);
    }

    const formatted = `[${line.ts}] [${line.level.toUpperCase()}]${
      botId ? ` [bot:${botId}]` : ''
    } ${message}\n`;

    if (
      shouldMirrorToStdout(level, message, origin) &&
      (origin !== 'script' || this.allowScriptMirror(botId))
    ) {
      // Une ligne, même texte que dans le fichier (retours à la ligne rendus visibles, longueur bornée).
      console.log(sanitizeMirrorLine(formatted.trimEnd()));
    }

    this.writeQueue = this.writeQueue.then(async () => {
      try {
        if (this.maxFileBytes > 0 && this.fileBytes >= this.maxFileBytes) {
          await rename(this.logFile, `${this.logFile}.1`);
          this.fileBytes = 0;
        }
        await appendFile(this.logFile, formatted, 'utf8');
        this.fileBytes += Buffer.byteLength(formatted);
      } catch {
        // ignore file write errors
      }
    });
  }

  tail(limit = 200): string[] {
    const slice = this.lines.slice(-limit);
    return slice.map(
      (line) =>
        `[${line.ts}] [${line.level.toUpperCase()}]${
          line.botId ? ` [bot:${line.botId}]` : ''
        } ${line.message}`,
    );
  }

  tailForBot(botId: string, limit = 200): string[] {
    const filtered = this.lines.filter((line) => line.botId === botId);
    return filtered.slice(-limit).map(
      (line) => `[${line.ts}] [${line.level.toUpperCase()}] ${line.message}`,
    );
  }
}

const storedLogLine =
  /^\[([^\]]+)\] \[([A-Z]+)\](?: \[bot:([^\]]+)\])? (.*)$/;

function parseStoredLogLine(line: string): LogLine | null {
  const match = storedLogLine.exec(line.trim());
  if (!match) {
    return null;
  }

  const level = match[2].toLowerCase();
  if (level !== 'info' && level !== 'warn' && level !== 'error' && level !== 'debug') {
    return null;
  }

  return {
    ts: match[1],
    level,
    botId: match[3] || undefined,
    message: match[4],
  };
}
