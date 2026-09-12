import { describe, expect, it, mock } from 'bun:test';

import * as realVoice from '@discordjs/voice';

import type { VoiceDependencyStatus } from '../src/runtime/voice-deps.js';

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

type CapturedLog = { level: LogLevel; message: string };

type VoiceDepsModule = {
  getVoiceDependencyStatus: () => VoiceDependencyStatus;
  logVoiceDependencyStatus: (
    log: (level: LogLevel, message: string) => void,
  ) => VoiceDependencyStatus | Promise<VoiceDependencyStatus>;
  resetVoiceDependencyStatusCacheForTests: () => void;
};

let importSeq = 0;

/**
 * Import voice-deps fresh for every test. Each import uses a unique query string
 * so Bun re-evaluates the module and binds whatever `@discordjs/voice` mock (if
 * any) is active at that moment.
 */
async function loadVoiceDeps(): Promise<VoiceDepsModule> {
  importSeq += 1;
  return (await import(`../src/runtime/voice-deps.js?case=${importSeq}`)) as VoiceDepsModule;
}

function createCapturingLog(): { entries: CapturedLog[]; log: (l: LogLevel, m: string) => void } {
  const entries: CapturedLog[] = [];
  const log = (level: LogLevel, message: string) => {
    entries.push({ level, message });
  };
  return { entries, log };
}

function messagesAt(entries: CapturedLog[], level: LogLevel): string[] {
  return entries.filter((entry) => entry.level === level).map((entry) => entry.message);
}

/** Await the status so this suite works with either the sync or async signature. */
async function callLogStatus(
  mod: VoiceDepsModule,
  log: (level: LogLevel, message: string) => void,
): Promise<VoiceDependencyStatus> {
  return await mod.logVoiceDependencyStatus(log);
}

describe('voice dependency status detection', () => {
  it('reports @discordjs/voice 0.19.x and confirms DAVE is present', async () => {
    const mod = await loadVoiceDeps();
    const status = await mod.getVoiceDependencyStatus();

    expect(status.available).toBe(true);
    expect(status.version).toMatch(/^0\.19\./);
    expect(status.davey).toBe(true);
    expect(status.daveyState).toBe('present');
    expect(status.daveyVersion).toMatch(/^0\./);
    // The raw report stays available on the status object for diagnostics.
    expect(status.report).toMatch(/DAVE Libraries/i);
    expect(status.report).toMatch(/@snazzah\/davey:\s*0\./);
  });

  it('emits no alarming warning and no info-level dependency report when DAVE is present', async () => {
    const mod = await loadVoiceDeps();
    const { entries, log } = createCapturingLog();

    const status = await callLogStatus(mod, log);

    expect(status.davey).toBe(true);
    expect(status.daveyState).toBe('present');

    const warnings = messagesAt(entries, 'warn');
    expect(warnings.some((message) => /voice joins will fail/i.test(message))).toBe(false);
    expect(warnings).toHaveLength(0);

    // The raw dependency report must not be echoed at info level anymore.
    const infos = messagesAt(entries, 'info');
    expect(infos.some((message) => message.includes('Core Dependencies'))).toBe(false);
    expect(infos.some((message) => message.includes('[VoiceDeps]'))).toBe(false);

    // The voice readiness line is still expected at info level.
    expect(infos.some((message) => /@discordjs\/voice\s+0\.19\./.test(message))).toBe(true);
  });

  // NOTE: this test mocks the whole `@discordjs/voice` module. Bun does not
  // reliably un-mock a module specifier within the same run, so it MUST stay the
  // last test in this file; earlier tests use fresh, cache-busted imports of the
  // real module and are unaffected.
  it('never emits a false "voice joins will fail" warning when the report is unreadable but DAVE is loadable', async () => {
    mock.module('@discordjs/voice', () => ({
      ...realVoice,
      generateDependencyReport: () => {
        throw new Error('report unavailable in compiled build');
      },
    }));

    const mod = await loadVoiceDeps();
    const { entries, log } = createCapturingLog();

    const status = await callLogStatus(mod, log);

    // DAVE is genuinely importable here; the fix must fall back to a real import
    // and never mistake an unreadable report for a missing library.
    expect(status.available).toBe(true);
    expect(status.report).toBeUndefined();
    expect(status.davey).toBe(true);
    expect(status.daveyState).toBe('present');

    const warnings = messagesAt(entries, 'warn');
    expect(warnings.some((message) => /voice joins will fail/i.test(message))).toBe(false);

    // A missing report must not be echoed as an info-level dependency dump.
    const infos = messagesAt(entries, 'info');
    expect(infos.some((message) => message.includes('Core Dependencies'))).toBe(false);
    expect(infos.some((message) => message.includes('[VoiceDeps]'))).toBe(false);
  });
});
