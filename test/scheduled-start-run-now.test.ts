import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  FileScheduleState,
  ScheduledTasks,
  type ScheduledTaskEntry,
  type TaskRunOutcome,
} from '../src/runtime/scheduled-tasks.js';

const MIN = 60_000;

function harness(nowIso: string, extra: Partial<ConstructorParameters<typeof ScheduledTasks>[0]> = {}) {
  let now = Date.parse(nowIso);
  const runs: string[] = [];
  const timers: Array<{ at: number; cb: () => void; live: boolean }> = [];
  const tasks = new ScheduledTasks({
    now: () => now,
    run: async (entry: ScheduledTaskEntry): Promise<TaskRunOutcome> => {
      runs.push(entry.id);
      return { ok: true, ms: 1 };
    },
    log: () => undefined,
    setTimer: (cb, delay) => {
      const t = { at: now + delay, cb, live: true };
      timers.push(t);
      return t as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (h) => {
      (h as unknown as { live: boolean }).live = false;
    },
    ...extra,
  });
  return { tasks, runs, setNow: (iso: string) => (now = Date.parse(iso)) };
}

describe('startAt', () => {
  it('first run is startAt when in the future, then startAt + k*period', () => {
    const { tasks } = harness('2026-11-02T08:00:00Z');
    tasks.reconcile([{ id: 'a', script: 's', everyMinutes: 60, startAt: '2026-11-02T09:30:00Z' }]);
    expect(tasks.snapshot().tasks[0]!.nextRunAt).toBe('2026-11-02T09:30:00.000Z');
  });

  it('after startAt the grid stays anchored on startAt, not on the epoch', () => {
    const { tasks } = harness('2026-11-02T10:10:00Z');
    tasks.reconcile([{ id: 'a', script: 's', everyMinutes: 60, startAt: '2026-11-02T09:30:00Z' }]);
    expect(tasks.snapshot().tasks[0]!.nextRunAt).toBe('2026-11-02T10:30:00.000Z');
  });

  it('without startAt intervals stay on the Unix epoch grid', () => {
    const { tasks } = harness('2026-11-02T10:10:00Z');
    tasks.reconcile([{ id: 'a', script: 's', everyMinutes: 60 }]);
    expect(tasks.snapshot().tasks[0]!.nextRunAt).toBe('2026-11-02T11:00:00.000Z');
  });

  it('cron never fires before startAt', () => {
    const { tasks } = harness('2026-11-02T08:00:00Z');
    tasks.reconcile([{ id: 'a', script: 's', cron: '0 * * * *', startAt: '2026-11-03T00:00:00Z' }]);
    expect(tasks.snapshot().tasks[0]!.nextRunAt).toBe('2026-11-03T00:00:00.000Z');
  });
});

describe('runNow', () => {
  it('runs the task without moving its timer', async () => {
    const h = harness('2026-11-02T10:10:00Z');
    h.tasks.reconcile([{ id: 'a', script: 's', everyMinutes: 60 }]);
    const before = h.tasks.snapshot().tasks[0]!.nextRunAt;
    const result = await h.tasks.runNow('a');
    expect(result.status).toBe('ok');
    expect(h.runs).toEqual(['a']);
    expect(h.tasks.snapshot().tasks[0]!.nextRunAt).toBe(before);
    expect(h.tasks.snapshot().tasks[0]!.runs).toBe(1);
  });

  it('answers not_found and not_ready', async () => {
    const h = harness('2026-11-02T10:10:00Z', { isReady: () => false });
    h.tasks.reconcile([{ id: 'a', script: 's', everyMinutes: 60 }]);
    expect((await h.tasks.runNow('zzz')).status).toBe('not_found');
    expect((await h.tasks.runNow('a')).status).toBe('not_ready');
  });
});

describe('FileScheduleState', () => {
  it('keeps lastRunAt across scheduler instances', async () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'sched-')), 'bot.json');
    const first = harness('2026-11-02T10:10:00Z', { stateStore: new FileScheduleState(file) });
    first.tasks.reconcile([{ id: 'a', script: 's', everyMinutes: 60 }]);
    await first.tasks.runNow('a');
    const second = harness('2026-11-02T10:20:00Z', { stateStore: new FileScheduleState(file) });
    second.tasks.reconcile([{ id: 'a', script: 's', everyMinutes: 60 }]);
    expect(second.tasks.snapshot().tasks[0]!.lastRunAt).toBe('2026-11-02T10:10:00.000Z');
    expect(MIN).toBe(60_000);
  });
});
