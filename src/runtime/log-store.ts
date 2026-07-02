import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export interface LogLine {
  ts: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  botId?: string;
  message: string;
}

export class LogStore {
  private readonly lines: LogLine[] = [];
  private readonly maxLines: number;

  constructor(
    private readonly logFile: string,
    maxLines = 2000,
  ) {
    this.maxLines = maxLines;
  }

  async init(): Promise<void> {
    await mkdir(path.dirname(this.logFile), { recursive: true });
  }

  append(level: LogLine['level'], message: string, botId?: string): void {
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

    void appendFile(this.logFile, formatted, 'utf8').catch(() => {
      // ignore file write errors
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
