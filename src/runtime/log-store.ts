import { appendFile, mkdir, readFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';

import type { LogAudience, LogShipper, ShippedLogRecord } from './log-shipper.js';

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
 * Contexte structuré d'une ligne, pour le journal durable du Manager. Jamais le contenu d'un message Discord.
 * `audience` : user (visible par défaut), support (traces, derrière un interrupteur) ou internal (mesures,
 * jamais montrées à l'utilisateur, toujours lisibles par l'IA interne et le MCP admin).
 */
export interface LogMeta {
  audience?: LogAudience;
  category?: string;
  command?: string;
  guildId?: string;
  channelId?: string;
  userId?: string;
  durationMs?: number;
  errorCode?: string;
  fields?: Record<string, unknown>;
  /** Ligne envoyée au Manager seulement: ni le tampon de l'API de logs, ni le fichier (traces, mesures). */
  shipOnly?: boolean;
}

/** Audience par défaut: les scripts parlent à l'utilisateur, le runner seulement quand ça va mal. */
export function defaultAudience(level: LogLine['level'], origin: LogOrigin): LogAudience {
  if (origin === 'script') {
    return 'user';
  }
  return level === 'warn' || level === 'error' ? 'user' : 'support';
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

// Ligne écrite dans le fichier quand un propriétaire efface les logs d'un bot : à la relecture
// (redémarrage du runner), tout ce qui précède pour ce bot est ignoré.
/** Une ligne de mesure (`perf {json}`), d'audience « internal ». */
export function isInternalLogMessage(message: string): boolean {
  return message.startsWith('perf {');
}

export const LOGS_CLEARED_MARKER = '__logs_cleared__';

export class LogStore {
  private readonly lines: LogLine[] = [];
  private readonly maxLines: number;
  private readonly maxFileBytes: number;
  private fileBytes = 0;
  private readonly keepDebug: boolean;
  private readonly scriptMirror = new Map<string, { windowStart: number; count: number }>();
  private shipper: LogShipper | null = null;
  // Writes are chained so lines keep their order and a rotation never races an append.
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly logFile: string,
    maxLines = 2000,
    // The file used to grow forever on a long-lived node. Past this size it is moved to
    // `<file>.1` (one generation kept, the previous `.1` is replaced).
    maxFileBytes = 10 * 1024 * 1024,
    // Les lignes debug n'entrent ni dans le journal ni dans l'API de logs, sauf BOT_CREATOR_RUNNER_LOG_LEVEL=debug.
    keepDebug = process.env.BOT_CREATOR_RUNNER_LOG_LEVEL?.toLowerCase() === 'debug',
  ) {
    this.maxLines = maxLines;
    this.maxFileBytes = maxFileBytes;
    this.keepDebug = keepDebug;
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

  /** Branche l'envoi vers le journal durable du Manager (absent en local: rien n'est envoyé). */
  setShipper(shipper: LogShipper | null): void {
    this.shipper = shipper;
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
          if (parsed.botId && parsed.message === LOGS_CLEARED_MARKER) {
            const clearedBot = parsed.botId;
            const kept = this.lines.filter((l) => l.botId !== clearedBot);
            this.lines.length = 0;
            this.lines.push(...kept);
            continue;
          }
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
    meta?: LogMeta,
  ): void {
    if (level === 'debug' && !this.keepDebug) {
      return;
    }
    const line: LogLine = {
      ts: new Date().toISOString(),
      level,
      botId,
      message,
    };

    if (botId && this.shipper) {
      this.shipper.enqueue(toShippedRecord(line, origin, meta));
    }
    if (meta?.shipOnly) {
      return;
    }

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

  tail(limit = 200, includeInternal = false): string[] {
    const slice = this.visible(this.lines, includeInternal).slice(-limit);
    return slice.map(
      (line) =>
        `[${line.ts}] [${line.level.toUpperCase()}]${
          line.botId ? ` [bot:${line.botId}]` : ''
        } ${line.message}`,
    );
  }

  /**
   * Vide le journal d'un bot (mémoire de l'API de logs). Le fichier runner.log, partagé par tous
   * les bots, n'est pas réécrit : un marqueur y est ajouté, que la relecture au démarrage respecte. Rend le nombre de lignes retirées.
   */
  clearForBot(botId: string): number {
    const before = this.lines.length;
    const kept = this.lines.filter((line) => line.botId !== botId);
    this.lines.length = 0;
    this.lines.push(...kept);
    const marker = `[${new Date().toISOString()}] [INFO] [bot:${botId}] ${LOGS_CLEARED_MARKER}\n`;
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        await appendFile(this.logFile, marker, 'utf8');
        this.fileBytes += Buffer.byteLength(marker);
      } catch {
        // ignore file write errors
      }
    });
    return before - kept.length;
  }

  /**
   * Les lignes `perf` (audience « internal ») sont retirées AVANT la limite, pour qu'un utilisateur
   * reçoive autant de lignes utiles ; `includeInternal` (`?audience=internal`) est la lecture du
   * Manager pour son MCP admin et l'IA interne.
   */
  private visible(lines: LogLine[], includeInternal: boolean): LogLine[] {
    return includeInternal ? lines : lines.filter((line) => !isInternalLogMessage(line.message));
  }

  tailForBot(botId: string, limit = 200, includeInternal = false): string[] {
    const filtered = this.visible(
      this.lines.filter((line) => line.botId === botId),
      includeInternal,
    );
    return filtered.slice(-limit).map(
      (line) => `[${line.ts}] [${line.level.toUpperCase()}] ${line.message}`,
    );
  }
}

function toShippedRecord(line: LogLine, origin: LogOrigin, meta?: LogMeta): ShippedLogRecord {
  const level = line.level === 'warn' ? 'warning' : line.level;
  const audience = meta?.audience ?? defaultAudience(line.level, origin);
  const record: ShippedLogRecord = {
    bot_id: line.botId ?? '',
    at: line.ts,
    level,
    audience,
    category:
      meta?.category ??
      (origin === 'script' ? (line.level === 'error' ? 'script_error' : 'log') : 'runner'),
    source: 'runner-js',
    message: redactSecrets(line.message),
  };
  if (meta?.command) record.command = meta.command;
  if (meta?.guildId) record.guild_id = meta.guildId;
  if (meta?.channelId) record.channel_id = meta.channelId;
  if (meta?.userId) record.user_id = meta.userId;
  if (meta?.durationMs !== undefined) record.duration_ms = Math.round(meta.durationMs);
  if (meta?.errorCode) record.error_code = meta.errorCode;
  if (meta?.fields) record.fields = meta.fields;
  return record;
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
