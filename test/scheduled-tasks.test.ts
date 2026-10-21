import { afterEach, describe, expect, it, setSystemTime, vi } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { Client, Events } from 'discord.js';

import { parseJsBotConfig } from '../src/config/js-bot-config.js';
import { clearLastKnownPortalIntents } from '../src/discord/application-intent-sync.js';
import { armDiscordIpBlock, clearDiscordIpBlock } from '../src/discord/discord-auth-errors.js';
import { HandlerRegistry } from '../src/discord/handler-registry.js';
import { CronSchedule, normalizeCronExpression, normalizeCronTimezone } from '../src/runtime/cron-expression.js';
import {
  DEFAULT_RUN_ON_START_DELAY_MS,
  FileStartupGuard,
  MAX_TIMER_DELAY_MS,
  ScheduledTasks,
  STARTUP_MARKER_MAX_AGE_MS,
  type ScheduledTaskEntry,
  type ScheduledTasksOptions,
  type StartupGuard,
  type TaskRunOutcome,
} from '../src/runtime/scheduled-tasks.js';
import type { VariableDatabase } from '../src/runtime/variable-database.js';
import { ScriptExecutor } from '../src/scripts/script-executor.js';
import { JsDiscordRunner } from '../src/worker/js-discord-runner.js';
import vectors from './fixtures/cron-vectors.json';

const SECOND = 1000;
const MIN = 60_000;

type Level = 'info' | 'warn' | 'error' | 'debug';

afterEach(() => {
  if (vi.isFakeTimers()) {
    vi.clearAllTimers();
  }
  vi.useRealTimers();
  setSystemTime();
});

async function flush(turns = 60): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await Promise.resolve();
  }
}

function startAt(iso: string): void {
  vi.useFakeTimers();
  setSystemTime(new Date(iso));
}

type Behaviours = Record<string, () => Promise<void> | void>;

/**
 * Registre réel (avec son planificateur) sur un client EventEmitter (donc sans `isReady`) et un exécuteur
 * factice. L'horloge est celle des faux timers de bun : le temps avance par pas, pour que les exécutions
 * asynchrones lues après chaque pas voient l'heure du tir.
 */
function harness(
  rawConfig: Record<string, unknown>,
  options: { behaviours?: Behaviours; client?: EventEmitter } = {},
) {
  const client = options.client ?? new EventEmitter();
  const runs: Array<{ script: string; at: string }> = [];
  const logs: Array<{ level: Level; message: string }> = [];
  const executor = {
    execute: async (script: string) => {
      runs.push({ script, at: new Date(Date.now()).toISOString() });
      await options.behaviours?.[script]?.();
    },
  } as unknown as ScriptExecutor;
  const config = parseJsBotConfig({ token: 'x', ...rawConfig });
  const registry = new HandlerRegistry(
    client as unknown as Client,
    config,
    'bot-1',
    executor,
    { getGlobalVariables: async () => ({}) } as VariableDatabase,
    (level, message) => logs.push({ level, message }),
  );
  const advance = async (ms: number, step = MIN) => {
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      vi.advanceTimersByTime(Math.min(step, ms - elapsed));
      await flush();
    }
  };
  /** Heures UTC (hh:mm, ou hh:mm:ss si `seconds`) des exécutions, dans l'ordre. */
  const times = (seconds = false) => runs.map((run) => run.at.slice(11, seconds ? 19 : 16));
  return { registry, config, client, runs, logs, advance, times };
}

describe('planificateur : une tâche survit aux rechargements du registre', () => {
  it('RÉGRESSION : une tâche de 60 min dont le registre est remonté à t+50 puis t+100 min tire exactement une fois par échéance', async () => {
    startAt('2026-03-10T00:07:00Z');
    const { registry, config, advance, times } = harness({
      scheduled: [{ id: 'hourly', script: 'tick', everyMinutes: 60 }],
    });
    registry.mount();

    await advance(50 * MIN); // 00:57
    registry.updateConfig(config);
    await advance(50 * MIN); // 01:47
    registry.updateConfig(config);

    // L'échéance de 01:00 est passée entre les deux rechargements : un seul tir, et aucun doublon.
    expect(times()).toEqual(['01:00']);

    await advance(13 * MIN); // 02:00
    expect(times()).toEqual(['01:00', '02:00']);
    registry.clear();
  });

  it('un intervalle de 15 min est ancré sur l’époque : :00 :15 :30 :45 UTC même si le registre naît à :07', async () => {
    startAt('2026-03-10T00:07:00Z');
    const { registry, advance, times } = harness({
      scheduled: [{ id: 'quarter', script: 'tick', everyMinutes: 15 }],
    });
    registry.mount();

    await advance(53 * MIN); // 01:00
    expect(times()).toEqual(['00:15', '00:30', '00:45', '01:00']);
    registry.clear();
  });

  it('aucun tir au démarrage sans runOnStart', async () => {
    startAt('2026-03-10T00:07:00Z');
    const { registry, advance, runs } = harness({
      scheduled: [{ id: 'quiet', script: 'tick', everyMinutes: 60 }],
    });
    registry.mount();
    await advance(30 * SECOND, SECOND);
    expect(runs).toEqual([]);
    registry.clear();
  });

  it('runOnStart : un seul tir au premier montage, pas un de plus après 3 rechargements', async () => {
    startAt('2026-03-10T00:07:00Z');
    const { registry, config, advance, runs } = harness({
      scheduled: [{ id: 'boot', script: 'tick', everyMinutes: 60, runOnStart: true }],
    });
    registry.mount();
    await advance(20 * SECOND, SECOND);
    expect(runs).toHaveLength(1);

    for (let reload = 0; reload < 3; reload += 1) {
      registry.updateConfig(config);
      await advance(20 * SECOND, SECOND);
    }
    expect(runs).toHaveLength(1);
    registry.clear();
  });

  it('cron : `*/5 * * * *` tire toutes les 5 minutes pile', async () => {
    startAt('2026-03-10T00:07:00Z');
    const { registry, advance, times } = harness({
      scheduled: [{ id: 'five', script: 'tick', cron: '*/5 * * * *' }],
    });
    registry.mount();
    await advance(20 * MIN); // 00:27
    expect(times()).toEqual(['00:10', '00:15', '00:20', '00:25']);
    registry.clear();
  });

  it('cron : le cron prime sur everyMinutes (repli de compatibilité ajouté par le Manager)', async () => {
    startAt('2026-03-10T00:07:00Z');
    const { registry, advance, times } = harness({
      scheduled: [{ id: 'both', script: 'tick', cron: '*/10 * * * *', everyMinutes: 10080 }],
    });
    registry.mount();
    await advance(25 * MIN); // 00:32
    expect(times()).toEqual(['00:10', '00:20', '00:30']);
    registry.clear();
  });

  it('cron avec fuseau : `0 9 * * *` Europe/Paris tire à 07:00Z l’été et à 08:00Z l’hiver', async () => {
    startAt('2026-07-01T05:00:00Z');
    const summer = harness({
      scheduled: [{ id: 'nine', script: 'tick', cron: '0 9 * * *', timezone: 'Europe/Paris' }],
    });
    summer.registry.mount();
    await summer.advance(3 * 60 * MIN);
    expect(summer.times()).toEqual(['07:00']);
    summer.registry.clear();
    vi.clearAllTimers();

    setSystemTime(new Date('2026-01-15T05:00:00Z'));
    const winter = harness({
      scheduled: [{ id: 'nine', script: 'tick', cron: '0 9 * * *', timezone: 'Europe/Paris' }],
    });
    winter.registry.mount();
    await winter.advance(4 * 60 * MIN);
    expect(winter.times()).toEqual(['08:00']);
    winter.registry.clear();
  });
});

// ---------------------------------------------------------------------------------------------------------
// Horloge manuelle : timers déterministes, déclenchés dans l'ordre de leur échéance. Sert aux tests du
// planificateur seul (ScheduledTasks), indépendants des faux timers de bun.
// ---------------------------------------------------------------------------------------------------------

type TimerHandle = ReturnType<typeof setTimeout>;

class ManualClock {
  now: number;
  /** Délais de tous les timers armés, dans l'ordre (vérifie le plafond 2^31-1). */
  readonly delays: number[] = [];
  private sequence = 0;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  constructor(iso: string) {
    this.now = Date.parse(iso);
  }

  readonly clock = (): number => this.now;

  readonly setTimer = (callback: () => void, delayMs: number): TimerHandle => {
    this.delays.push(delayMs);
    this.sequence += 1;
    this.timers.set(this.sequence, { at: this.now + delayMs, callback });
    return this.sequence as unknown as TimerHandle;
  };

  readonly clearTimer = (handle: TimerHandle): void => {
    this.timers.delete(handle as unknown as number);
  };

  get pending(): number {
    return this.timers.size;
  }

  private earliest(limit = Number.POSITIVE_INFINITY): [number, { at: number; callback: () => void }] | undefined {
    let best: [number, { at: number; callback: () => void }] | undefined;
    for (const entry of this.timers) {
      if (entry[1].at <= limit && (!best || entry[1].at < best[1].at)) best = entry;
    }
    return best;
  }

  /** Avance jusqu'à `until` en déclenchant chaque timer échu ; l'horloge vaut l'échéance pendant son callback. */
  async advanceTo(until: number): Promise<void> {
    for (let due = this.earliest(until); due; due = this.earliest(until)) {
      this.timers.delete(due[0]);
      this.now = Math.max(this.now, due[1].at);
      due[1].callback();
      await flush();
    }
    this.now = Math.max(this.now, until);
  }

  advanceBy(ms: number): Promise<void> {
    return this.advanceTo(this.now + ms);
  }

  /** Saute à `to` puis déclenche le prochain timer échu : un réveil en retard (machine suspendue). */
  async jumpAndFire(to: number): Promise<void> {
    this.now = to;
    const due = this.earliest(to);
    if (due) {
      this.timers.delete(due[0]);
      due[1].callback();
      await flush();
    }
  }

  /** Déclenche le prochain timer sans avancer l'horloge : un réveil en avance. */
  async fireEarliestNow(): Promise<void> {
    const due = this.earliest();
    if (due) {
      this.timers.delete(due[0]);
      due[1].callback();
      await flush();
    }
  }
}

function localDate(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(ms),
  );
}

/** Planificateur seul, sur une horloge manuelle, avec une exécution factice qui note chaque tir. */
function scheduler(clock: ManualClock, overrides: Partial<ScheduledTasksOptions> = {}) {
  const logs: Array<{ level: Level; message: string }> = [];
  const runs: Array<{ id: string; script: string; at: string }> = [];
  const instance = new ScheduledTasks({
    run: async (entry: ScheduledTaskEntry): Promise<TaskRunOutcome> => {
      runs.push({ id: entry.id, script: entry.script, at: new Date(clock.now).toISOString() });
      return { ok: true, ms: 1 };
    },
    log: (level, message) => logs.push({ level, message }),
    now: clock.clock,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...overrides,
  });
  return { instance, logs, runs };
}

const at = (iso: string): number => Date.parse(iso);

describe('cron : vecteurs communs avec le Manager', () => {
  it('accepte toutes les expressions valides, déjà canoniques, et croner sait les évaluer', () => {
    for (const expression of vectors.valid) {
      const checked = normalizeCronExpression(expression);
      expect([expression, checked]).toEqual([expression, { ok: true, canonical: expression }]);
      expect(CronSchedule.parse(expression).ok).toBe(true);
    }
  });

  it('met en forme canonique : espaces, zéros de tête, casse des noms et des macros', () => {
    expect(normalizeCronExpression('  05   9\t* jan  mon-fri ')).toEqual({ ok: true, canonical: '5 9 * JAN MON-FRI' });
    expect(normalizeCronExpression('@DAILY')).toEqual({ ok: true, canonical: '@daily' });
  });

  it('refuse toutes les expressions invalides, même celles que croner accepte (secondes, L, #, ?, @reboot…)', () => {
    for (const { expr, why } of vectors.invalid) {
      expect([expr, why, normalizeCronExpression(expr).ok]).toEqual([expr, why, false]);
      expect([expr, CronSchedule.parse(expr).ok]).toEqual([expr, false]);
    }
  });

  it('refuse un texte trop long et une valeur qui n’est pas du texte', () => {
    expect(normalizeCronExpression(`${'1,'.repeat(60)}1 * * * *`).ok).toBe(false);
    for (const value of [undefined, null, 5, ['* * * * *'], {}]) {
      expect(normalizeCronExpression(value as never).ok).toBe(false);
    }
  });

  it('fuseaux : UTC par défaut, noms IANA connus acceptés, le reste refusé', () => {
    for (const timezone of vectors.timezones.valid) {
      expect([timezone, normalizeCronTimezone(timezone)]).toEqual([timezone, { ok: true, timezone }]);
    }
    for (const timezone of vectors.timezones.invalid) {
      expect([timezone, normalizeCronTimezone(timezone).ok]).toEqual([timezone, false]);
    }
    for (const empty of [undefined, null, '', '   ']) {
      expect(normalizeCronTimezone(empty)).toEqual({ ok: true, timezone: 'UTC' });
    }
    expect(normalizeCronTimezone(42 as never).ok).toBe(false);
  });

  it('prochaines échéances : celles des vecteurs, calculées par croner', () => {
    for (const vector of vectors.next) {
      const parsed = CronSchedule.parse(vector.expr, vector.timezone);
      expect([vector.expr, vector.timezone, parsed.ok]).toEqual([vector.expr, vector.timezone, true]);
      if (!parsed.ok) continue;
      let cursor = Date.parse(vector.from);
      const got: string[] = [];
      for (let index = 0; index < vector.next.length; index += 1) {
        const next = parsed.schedule.next(cursor);
        expect(next).not.toBeNull();
        cursor = next as number;
        got.push(new Date(cursor).toISOString().replace('.000Z', 'Z'));
      }
      expect([vector.expr, vector.timezone, got]).toEqual([vector.expr, vector.timezone, vector.next]);
    }
  });

  it('changements d’heure : exactement un tir par jour local, jamais zéro ni deux', () => {
    for (const vector of vectors.dst) {
      const parsed = CronSchedule.parse(vector.expr, vector.timezone);
      if (!parsed.ok) throw new Error(parsed.reason);
      const start = Date.parse(`${vector.localDate}T00:00:00Z`) - 3 * 86_400_000;
      const perDay = new Map<string, number>();
      for (let cursor = parsed.schedule.next(start); cursor !== null && cursor < start + 7 * 86_400_000; cursor = parsed.schedule.next(cursor)) {
        const day = localDate(cursor, vector.timezone);
        perDay.set(day, (perDay.get(day) ?? 0) + 1);
      }
      expect([vector.timezone, vector.localDate, perDay.get(vector.localDate)]).toEqual([
        vector.timezone,
        vector.localDate,
        vector.fires,
      ]);
      // Les jours voisins (entièrement dans la fenêtre) ont eux aussi un tir exactement.
      const days = [...perDay.entries()].filter(([day]) => day > localDate(start, vector.timezone));
      expect(days.slice(0, 5).every(([, count]) => count === 1)).toBe(true);
    }
  });
});

describe('ScheduledTasks : échéances (horloge manuelle)', () => {
  it('ancre un intervalle sur l’époque : multiples de N minutes, quel que soit l’instant de montage', async () => {
    const clock = new ManualClock('2026-03-10T00:07:13Z');
    const { instance, runs } = scheduler(clock);
    instance.reconcile([{ id: 'a', script: 's', everyMinutes: 15 }]);
    await clock.advanceTo(at('2026-03-10T01:00:00Z'));
    expect(runs.map((run) => run.at.slice(11, 19))).toEqual(['00:15:00', '00:30:00', '00:45:00', '01:00:00']);
    instance.stop();
  });

  it('1440 min tire à 00:00 UTC et 10080 min le jeudi à 00:00 UTC (ancrage sur l’époque, changement assumé)', async () => {
    const clock = new ManualClock('2026-03-10T08:30:00Z');
    const { instance, runs } = scheduler(clock);
    instance.reconcile([
      { id: 'daily', script: 'd', everyMinutes: 1440 },
      { id: 'weekly', script: 'w', everyMinutes: 10080 },
    ]);
    await clock.advanceTo(at('2026-03-13T00:00:00Z'));
    expect(runs.map((run) => `${run.id}@${run.at.slice(0, 16)}`).sort()).toEqual([
      'daily@2026-03-11T00:00',
      'daily@2026-03-12T00:00',
      'daily@2026-03-13T00:00',
      'weekly@2026-03-12T00:00',
    ]);
    instance.stop();
  });

  it('plafonne chaque délai à 2^31-1 ms : un cron annuel est ré-armé par paliers, sans tir immédiat', async () => {
    const clock = new ManualClock('2026-03-10T00:00:00Z');
    const { instance, runs } = scheduler(clock);
    instance.reconcile([{ id: 'yearly', script: 'y', cron: '@yearly' }]);

    await clock.advanceTo(at('2026-12-31T23:59:59Z'));
    expect(runs).toEqual([]);
    expect(Math.max(...clock.delays)).toBeLessThanOrEqual(MAX_TIMER_DELAY_MS);
    expect(clock.delays.length).toBeGreaterThan(10);
    expect(clock.pending).toBe(1);

    await clock.advanceTo(at('2027-01-01T00:00:00Z'));
    expect(runs.map((run) => run.at)).toEqual(['2027-01-01T00:00:00.000Z']);
    instance.stop();
  });

  it('everyMinutes=10080, horloge avancée de 6 jours : aucun tir ; il tombe le jeudi 00:00 UTC', async () => {
    const clock = new ManualClock('2026-03-09T00:00:00Z'); // lundi
    const { instance, runs } = scheduler(clock);
    instance.reconcile([{ id: 'weekly', script: 'w', everyMinutes: 10080 }]);
    await clock.advanceTo(at('2026-03-11T23:59:59Z'));
    expect(runs).toEqual([]);
    await clock.advanceTo(at('2026-03-12T00:00:00Z'));
    expect(runs).toHaveLength(1);
    instance.stop();
  });

  it('everyMinutes au-dessus de 10080, valide pour l’ancien schéma (20160 min = 2 semaines), reste exécuté', async () => {
    const clock = new ManualClock('2026-03-10T00:00:00Z');
    const { instance, runs, logs } = scheduler(clock);
    instance.reconcile([{ id: 'biweekly', script: 's', everyMinutes: 20_160 }]);

    expect(instance.snapshot().ignored).toEqual([]);
    expect(logs.filter((line) => line.level === 'warn')).toEqual([]);
    const period = 20_160 * MIN;
    const next = (Math.floor(clock.now / period) + 1) * period;
    expect(instance.snapshot().tasks[0]).toMatchObject({
      kind: 'interval',
      schedule: 'every 20160 min',
      nextRunAt: new Date(next).toISOString(),
    });

    await clock.advanceTo(next - 1);
    expect(runs).toEqual([]);
    expect(Math.max(...clock.delays)).toBeLessThanOrEqual(MAX_TIMER_DELAY_MS);
    await clock.advanceTo(next);
    expect(runs.map((run) => run.at)).toEqual([new Date(next).toISOString()]);
    instance.stop();
  });

  it('un intervalle de plusieurs mois reste accepté, mais pas au-delà d’un an', () => {
    const clock = new ManualClock('2026-03-10T00:00:00Z');
    const { instance } = scheduler(clock);
    instance.reconcile([
      { id: 'quarter', script: 's', everyMinutes: 131_040 },
      { id: 'year', script: 's', everyMinutes: 525_600 },
      { id: 'beyond', script: 's', everyMinutes: 525_601 },
    ]);
    const snapshot = instance.snapshot();
    expect(snapshot.tasks.map((task) => task.id)).toEqual(['quarter', 'year']);
    expect(snapshot.ignored).toEqual([
      { id: 'beyond', reason: 'no valid schedule (set a cron expression or everyMinutes between 1 and 525600)' },
    ]);
    instance.stop();
  });

  it('un réveil en retard de plus d’une minute tire UNE fois, avertit, et ne rattrape pas les échéances manquées', async () => {
    const clock = new ManualClock('2026-03-10T00:00:30Z');
    const { instance, runs, logs } = scheduler(clock);
    instance.reconcile([{ id: 'every', script: 's', everyMinutes: 1 }]);
    await clock.jumpAndFire(at('2026-03-10T00:10:30Z'));

    expect(runs).toHaveLength(1);
    expect(logs.some((line) => line.level === 'warn' && line.message.includes('late'))).toBe(true);
    expect(instance.snapshot().tasks[0]!.nextRunAt).toBe('2026-03-10T00:11:00.000Z');
    instance.stop();
  });

  it('un réveil en avance se rendort jusqu’à l’échéance sans tirer', async () => {
    const clock = new ManualClock('2026-03-10T00:00:30Z');
    const { instance, runs } = scheduler(clock);
    instance.reconcile([{ id: 'every', script: 's', everyMinutes: 1 }]);
    await clock.fireEarliestNow();

    expect(runs).toEqual([]);
    expect(clock.pending).toBe(1);
    expect(clock.delays.at(-1)).toBe(30_000);
    await clock.advanceBy(30_000);
    expect(runs).toHaveLength(1);
    instance.stop();
  });

  it('cron et changements d’heure : `30 2 * * *` tire exactement une fois par jour local autour des deux changements', async () => {
    const cases: Array<[string, string, string, string]> = [
      ['Europe/Paris', '2026-03-27T00:00:00Z', '2026-04-01T00:00:00Z', '2026-03-29'],
      ['Europe/Paris', '2026-10-24T00:00:00Z', '2026-10-29T00:00:00Z', '2026-10-25'],
      ['America/New_York', '2026-03-06T12:00:00Z', '2026-03-11T12:00:00Z', '2026-03-08'],
      ['America/New_York', '2026-10-30T12:00:00Z', '2026-11-04T12:00:00Z', '2026-11-01'],
    ];
    for (const [timezone, from, until, changeDay] of cases) {
      const clock = new ManualClock(from);
      const { instance, runs } = scheduler(clock);
      instance.reconcile([{ id: 'night', script: 's', cron: '30 2 * * *', timezone }]);
      await clock.advanceTo(at(until));
      const days = runs.map((run) => localDate(at(run.at), timezone));
      expect([timezone, changeDay, days.length]).toEqual([timezone, changeDay, 5]);
      expect(new Set(days).size).toBe(5);
      expect(days).toContain(changeDay);
      instance.stop();
    }
  });

  it('un cron sans échéance (30 février) n’arme aucun timer et le dit une fois', async () => {
    const clock = new ManualClock('2026-03-10T00:00:00Z');
    const { instance, logs } = scheduler(clock);
    instance.reconcile([{ id: 'never', script: 's', cron: '0 0 30 2 *' }]);
    instance.reconcile([{ id: 'never', script: 's', cron: '0 0 30 2 *' }]);

    expect(clock.pending).toBe(0);
    expect(instance.snapshot().tasks[0]!.nextRunAt).toBeNull();
    expect(logs.filter((line) => line.message.includes('no upcoming run'))).toHaveLength(1);
    instance.stop();
  });
});

describe('ScheduledTasks : exécutions', () => {
  it('anti-chevauchement : un script de 3 périodes fait sauter 2 échéances, avec un seul avertissement', async () => {
    const clock = new ManualClock('2026-03-10T00:00:30Z');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const { instance, logs } = scheduler(clock, {
      run: async () => {
        calls += 1;
        if (calls === 1) await gate;
        return { ok: true, ms: 1 };
      },
    });
    instance.reconcile([{ id: 'long', script: 's', everyMinutes: 1 }]);

    await clock.advanceTo(at('2026-03-10T00:03:30Z')); // tir de 00:01, sauts de 00:02 et 00:03
    expect(calls).toBe(1);
    expect(instance.snapshot().tasks[0]).toMatchObject({ running: true, skippedOverlap: 2 });
    const skips = logs.filter((line) => line.message.includes('skipped: still running'));
    expect(skips.map((line) => line.level)).toEqual(['warn', 'debug']);

    release();
    await flush();
    await clock.advanceTo(at('2026-03-10T00:04:30Z'));
    expect(calls).toBe(2);
    instance.stop();
  });

  it('un timeout qui libère le script (rejet propre) libère aussi la place : la tâche tire à l’échéance suivante', async () => {
    const clock = new ManualClock('2026-03-10T00:00:30Z');
    let calls = 0;
    const { instance } = scheduler(clock, {
      run: async () => {
        calls += 1;
        return { ok: false, ms: 50, error: 'Script execution timed out after 50ms' };
      },
    });
    instance.reconcile([{ id: 'timeouts', script: 's', everyMinutes: 1 }]);
    await clock.advanceTo(at('2026-03-10T00:03:30Z'));
    expect(calls).toBe(3);
    expect(instance.snapshot().tasks[0]).toMatchObject({ failures: 3, skippedOverlap: 0, running: false });
    instance.stop();
  });

  it('un script qui ignore son timeout garde sa place jusqu’à sa fin réelle : pas de zombies au-delà de la concurrence', async () => {
    const clock = new ManualClock('2026-03-10T00:00:30Z');
    let finish!: () => void;
    const settled = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let calls = 0;
    const { instance, logs } = scheduler(clock, {
      run: async () => {
        calls += 1;
        return calls === 1
          ? { ok: false, ms: 50, error: 'Script execution timed out after 50ms', settled }
          : { ok: true, ms: 1 };
      },
    });
    instance.reconcile([{ id: 'zombie', script: 's', everyMinutes: 1 }]);

    await clock.advanceTo(at('2026-03-10T00:03:30Z'));
    expect(calls).toBe(1);
    expect(instance.snapshot().running).toBe(1);
    expect(instance.snapshot().tasks[0]).toMatchObject({ running: true, skippedOverlap: 2, lastOk: false });
    expect(logs.some((line) => line.level === 'warn' && line.message.includes('still running'))).toBe(true);

    finish();
    await flush();
    expect(instance.snapshot().running).toBe(0);
    await clock.advanceTo(at('2026-03-10T00:04:30Z'));
    expect(calls).toBe(2);
    instance.stop();
  });

  /** Exécution factice dont chaque tir attend qu'on le libère (une E/S en vol) : `settle()` les termine tous. */
  function gatedRuns(clock: ManualClock) {
    const open: Array<() => void> = [];
    const runs: Array<{ id: string; at: string }> = [];
    const run = async (entry: ScheduledTaskEntry): Promise<TaskRunOutcome> => {
      runs.push({ id: entry.id, at: new Date(clock.now).toISOString() });
      await new Promise<void>((resolve) => open.push(resolve));
      return { ok: true, ms: 1 };
    };
    const settle = async () => {
      while (open.length > 0) {
        open.shift()!();
        await flush();
      }
    };
    return { run, runs, settle, inFlight: () => open.length };
  }

  it('plafond de 3 exécutions simultanées par bot : les tâches coïncidentes en trop sont DIFFÉRÉES, pas sautées', async () => {
    const clock = new ManualClock('2026-03-10T00:00:30Z');
    const gated = gatedRuns(clock);
    const { instance, logs } = scheduler(clock, { run: gated.run });
    instance.reconcile(
      ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, script: 's', everyMinutes: 1 })),
    );
    await clock.advanceTo(at('2026-03-10T00:01:30Z'));

    // Le plafond tient : 3 en vol, les 2 autres attendent une place.
    expect(gated.runs.map((run) => run.id)).toEqual(['a', 'b', 'c']);
    expect(instance.snapshot().running).toBe(3);

    // Dès qu'une place se libère, les tâches en attente partent, dans l'ordre d'arrivée.
    await gated.settle();
    expect(gated.runs.map((run) => run.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    const snapshot = instance.snapshot();
    expect(snapshot.running).toBe(0);
    expect(snapshot.tasks.map((task) => [task.id, task.runs, task.skippedConcurrency])).toEqual([
      ['a', 1, 0],
      ['b', 1, 0],
      ['c', 1, 0],
      ['d', 1, 0],
      ['e', 1, 0],
    ]);
    expect(logs.filter((line) => line.message.includes('skipped'))).toEqual([]);
    instance.stop();
  });

  it('4 tâches sur la même échéance (60 min) : la 4e tire à chaque heure, aucune famine', async () => {
    const clock = new ManualClock('2026-03-10T00:10:00Z');
    const gated = gatedRuns(clock);
    const { instance } = scheduler(clock, { run: gated.run });
    instance.reconcile(['a', 'b', 'c', 'd'].map((id) => ({ id, script: 's', everyMinutes: 60 })));

    for (const hour of ['01', '02', '03']) {
      await clock.advanceTo(at(`2026-03-10T${hour}:00:30Z`));
      await gated.settle();
    }
    expect(gated.runs.map((run) => run.id)).toEqual(['a', 'b', 'c', 'd', 'a', 'b', 'c', 'd', 'a', 'b', 'c', 'd']);
    expect(instance.snapshot().tasks.map((task) => task.skippedConcurrency)).toEqual([0, 0, 0, 0]);
    instance.stop();
  });

  it('4 tâches runOnStart : la 4e, différée, tire dès qu’une place se libère et ne rejoue pas ensuite', async () => {
    const clock = new ManualClock('2026-03-10T00:10:00Z');
    const gated = gatedRuns(clock);
    const { instance } = scheduler(clock, { run: gated.run });
    instance.reconcile(
      ['a', 'b', 'c', 'd'].map((id) => ({ id, script: 's', everyMinutes: 60, runOnStart: true })),
    );
    await clock.advanceBy(DEFAULT_RUN_ON_START_DELAY_MS);
    expect(gated.runs.map((run) => run.id)).toEqual(['a', 'b', 'c']);

    await gated.settle();
    expect(gated.runs.map((run) => run.id)).toEqual(['a', 'b', 'c', 'd']);

    // Un rechargement ne le rejoue pas : le tir de démarrage différé compte comme traité.
    instance.reconcile(['a', 'b', 'c', 'd'].map((id) => ({ id, script: 's', everyMinutes: 60, runOnStart: true })));
    await clock.advanceBy(10 * MIN);
    await gated.settle();
    expect(gated.runs).toHaveLength(4);
    instance.stop();
  });

  it('une tâche déjà en attente qui revient à échéance est sautée (concurrency limit), sans rattrapage', async () => {
    const clock = new ManualClock('2026-03-10T00:00:30Z');
    const gated = gatedRuns(clock);
    const { instance, logs } = scheduler(clock, { run: gated.run, maxConcurrent: 1 });
    instance.reconcile([
      { id: 'hog', script: 's', everyMinutes: 1 },
      { id: 'waiter', script: 's', everyMinutes: 1 },
    ]);
    await clock.advanceTo(at('2026-03-10T00:03:30Z'));
    // `hog` tient la seule place depuis 00:01. `waiter` a été mise en attente à 00:01, puis sautée à 00:02 et 00:03.
    expect(gated.runs.map((run) => run.id)).toEqual(['hog']);
    const waiter = instance.snapshot().tasks.find((task) => task.id === 'waiter');
    expect(waiter).toMatchObject({ runs: 0, skippedConcurrency: 2 });
    expect(logs.some((line) => line.level === 'warn' && line.message.includes('Scheduled task waiter skipped: concurrency limit'))).toBe(true);

    await gated.settle();
    // Un seul tir pour `waiter`, pas un par échéance manquée.
    expect(gated.runs.map((run) => run.id)).toEqual(['hog', 'waiter']);
    await gated.settle();
    instance.stop();
  });

  it('une tâche retirée alors qu’elle attend une place ne tire pas', async () => {
    const clock = new ManualClock('2026-03-10T00:00:30Z');
    const gated = gatedRuns(clock);
    const { instance } = scheduler(clock, { run: gated.run, maxConcurrent: 1 });
    instance.reconcile([
      { id: 'hog', script: 's', everyMinutes: 1 },
      { id: 'removed', script: 's', everyMinutes: 1 },
      { id: 'kept', script: 's', everyMinutes: 1 },
    ]);
    await clock.advanceTo(at('2026-03-10T00:01:30Z'));
    expect(gated.runs.map((run) => run.id)).toEqual(['hog']);

    instance.reconcile([
      { id: 'hog', script: 's', everyMinutes: 1 },
      { id: 'kept', script: 's', everyMinutes: 1 },
    ]);
    await gated.settle();
    expect(gated.runs.map((run) => run.id)).toEqual(['hog', 'kept']);
    instance.stop();
  });

  it('stop() vide la file d’attente : rien ne démarre quand la place se libère ensuite', async () => {
    const clock = new ManualClock('2026-03-10T00:00:30Z');
    const gated = gatedRuns(clock);
    const { instance } = scheduler(clock, { run: gated.run, maxConcurrent: 1 });
    instance.reconcile([
      { id: 'hog', script: 's', everyMinutes: 1 },
      { id: 'waiting', script: 's', everyMinutes: 1 },
    ]);
    await clock.advanceTo(at('2026-03-10T00:01:30Z'));
    expect(gated.runs.map((run) => run.id)).toEqual(['hog']);

    instance.stop();
    await gated.settle();
    expect(gated.runs.map((run) => run.id)).toEqual(['hog']);
  });

  it('une exécution qui lève est journalisée en erreur (id, planification, durée) et la tâche est ré-armée', async () => {
    const clock = new ManualClock('2026-03-10T00:00:30Z');
    let calls = 0;
    const { instance, logs } = scheduler(clock, {
      run: async () => {
        calls += 1;
        throw new Error('boom');
      },
    });
    instance.reconcile([{ id: 'broken', script: 's', cron: '* * * * *' }]);
    await clock.advanceTo(at('2026-03-10T00:02:30Z'));

    expect(calls).toBe(2);
    const failure = logs.find((line) => line.level === 'error');
    expect(failure?.message).toMatch(/^Scheduled task broken \(cron "\* \* \* \* \*"\) failed after \d+ms: boom/);
    expect(instance.snapshot().tasks[0]).toMatchObject({ failures: 2, lastOk: false, lastError: 'boom' });
    instance.stop();
  });

  it('un tir réussi est journalisé en debug seulement ; le snapshot dit prochaine échéance et dernier résultat', async () => {
    const clock = new ManualClock('2026-03-10T00:00:30Z');
    const { instance, logs } = scheduler(clock);
    instance.reconcile([{ id: 'quiet', script: 's', everyMinutes: 5 }]);
    await clock.advanceTo(at('2026-03-10T00:05:30Z'));

    expect(logs.filter((line) => line.level !== 'debug')).toEqual([]);
    expect(logs.some((line) => line.level === 'debug' && /^Scheduled task quiet ok in \d+ms$/.test(line.message))).toBe(true);
    expect(instance.snapshot()).toEqual({
      running: 0,
      maxConcurrent: 3,
      tasks: [
        {
          id: 'quiet',
          kind: 'interval',
          schedule: 'every 5 min',
          nextRunAt: '2026-03-10T00:10:00.000Z',
          lastRunAt: '2026-03-10T00:05:00.000Z',
          lastOk: true,
          lastDurationMs: 1,
          lastError: null,
          running: false,
          runs: 1,
          failures: 0,
          skippedOverlap: 0,
          skippedNotReady: 0,
          skippedConcurrency: 0,
        },
      ],
      ignored: [],
    });
    instance.stop();
  });
});

describe('ScheduledTasks : runOnStart', () => {
  it('attend le client prêt, tire une fois après le délai, jamais deux fois', async () => {
    const clock = new ManualClock('2026-03-10T00:07:00Z');
    let ready = false;
    const entries = [{ id: 'boot', script: 'b', everyMinutes: 60, runOnStart: true }];
    const { instance, runs, logs } = scheduler(clock, { isReady: () => ready });
    instance.reconcile(entries);

    await clock.advanceBy(120_000);
    expect(runs).toEqual([]);

    ready = true;
    instance.markReady();
    await clock.advanceBy(DEFAULT_RUN_ON_START_DELAY_MS - 1);
    expect(runs).toEqual([]);
    await clock.advanceBy(1);
    expect(runs).toHaveLength(1);
    // Journalisé avant l'exécution.
    expect(logs.some((line) => line.level === 'info' && line.message.includes('runOnStart'))).toBe(true);

    instance.markReady();
    instance.reconcile(entries);
    instance.reconcile(entries);
    await clock.advanceBy(60_000);
    expect(runs).toHaveLength(1);
    instance.stop();
  });

  it('une tâche retirée avant que le client soit prêt ne tire pas', async () => {
    const clock = new ManualClock('2026-03-10T00:07:00Z');
    let ready = false;
    const { instance, runs } = scheduler(clock, { isReady: () => ready });
    instance.reconcile([{ id: 'boot', script: 'b', everyMinutes: 60, runOnStart: true }]);
    instance.reconcile([]);
    ready = true;
    instance.markReady();
    await clock.advanceBy(60_000);
    expect(runs).toEqual([]);
    instance.stop();
  });

  it('après stop() puis un nouveau montage, runOnStart rejoue (c’est un nouveau démarrage)', async () => {
    const clock = new ManualClock('2026-03-10T00:07:00Z');
    const entries = [{ id: 'boot', script: 'b', everyMinutes: 60, runOnStart: true }];
    const { instance, runs } = scheduler(clock);
    instance.reconcile(entries);
    await clock.advanceBy(10_000);
    instance.stop();
    instance.reconcile(entries);
    await clock.advanceBy(10_000);
    expect(runs).toHaveLength(2);
    instance.stop();
  });

  it('un marqueur d’un tir précédent jamais terminé fait sauter runOnStart (pas de boucle de redémarrage)', async () => {
    const clock = new ManualClock('2026-03-10T00:07:00Z');
    const begun: string[] = [];
    const ended: string[] = [];
    let interrupted = true;
    const startupGuard: StartupGuard = {
      begin: (key) => {
        begun.push(key);
        return !interrupted;
      },
      end: (key) => {
        ended.push(key);
      },
    };
    const { instance, runs, logs } = scheduler(clock, { startupGuard });
    instance.reconcile([{ id: 'boot', script: 'freeze();', everyMinutes: 60, runOnStart: true }]);
    await clock.advanceBy(10_000);

    expect(runs).toEqual([]);
    expect(begun).toHaveLength(1);
    expect(ended).toEqual([]);
    expect(logs.some((line) => line.level === 'warn' && line.message.includes('runOnStart skipped'))).toBe(true);
    instance.stop();

    interrupted = false;
    instance.reconcile([{ id: 'boot', script: 'fixed();', everyMinutes: 60, runOnStart: true }]);
    await clock.advanceBy(10_000);
    expect(runs.map((run) => run.script)).toEqual(['fixed();']);
    expect(ended).toEqual([begun[1]]);
    expect(begun[0]).not.toBe(begun[1]); // la clé suit le script : un script corrigé rejoue
    instance.stop();
  });

  it('un arrêt volontaire pendant un tir de démarrage retire le marqueur (ce n’est pas un crash)', async () => {
    const clock = new ManualClock('2026-03-10T00:07:00Z');
    const ended: string[] = [];
    const startupGuard: StartupGuard = { begin: () => true, end: (key) => void ended.push(key) };
    const gate = new Promise<void>(() => undefined);
    const { instance } = scheduler(clock, {
      startupGuard,
      run: async () => {
        await gate;
        return { ok: true, ms: 1 };
      },
    });
    instance.reconcile([{ id: 'boot', script: 'b', everyMinutes: 60, runOnStart: true }]);
    await clock.advanceBy(10_000);
    expect(instance.snapshot().running).toBe(1);
    instance.stop();
    expect(ended).toHaveLength(1);
  });
});

describe('FileStartupGuard', () => {
  it('pose un marqueur au début, le retire à la fin, et refuse un second début tant qu’il existe', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'startup-guard-'));
    try {
      const guard = new FileStartupGuard(path.join(directory, 'bot'));
      expect(guard.begin('tick-abc')).toBe(true);
      expect(guard.begin('tick-abc')).toBe(false);
      expect(guard.begin('other-abc')).toBe(true);
      guard.end('tick-abc');
      expect(guard.begin('tick-abc')).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('un marqueur périmé (plus de 30 minutes) est ignoré', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'startup-guard-'));
    try {
      const guard = new FileStartupGuard(directory);
      expect(guard.begin('tick-abc')).toBe(true);
      const marker = path.join(directory, 'tick-abc.running');
      expect(existsSync(marker)).toBe(true);
      const old = new Date(Date.now() - STARTUP_MARKER_MAX_AGE_MS - 60_000);
      utimesSync(marker, old, old);
      expect(guard.begin('tick-abc')).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('un disque inutilisable ne bloque pas la tâche', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'startup-guard-'));
    try {
      const blocker = path.join(directory, 'file');
      writeFileSync(blocker, 'x');
      const guard = new FileStartupGuard(path.join(blocker, 'sub')); // un fichier là où il faut un dossier
      expect(guard.begin('tick-abc')).toBe(true);
      expect(() => guard.end('tick-abc')).not.toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('ScheduledTasks : réconciliation', () => {
  it('une tâche inchangée garde son timer ; seul son script est remplacé pour le tir suivant', async () => {
    const clock = new ManualClock('2026-03-10T00:07:00Z');
    const { instance, runs } = scheduler(clock);
    instance.reconcile([{ id: 'a', script: 'v1', everyMinutes: 60 }]);
    const nextRunAt = instance.snapshot().tasks[0]!.nextRunAt;
    const armed = clock.delays.length;

    instance.reconcile([{ id: 'a', script: 'v2', everyMinutes: 60 }]);
    instance.reconcile([{ id: 'a', script: 'v3', everyMinutes: 60 }]);
    expect(clock.delays).toHaveLength(armed);
    expect(clock.pending).toBe(1);
    expect(instance.snapshot().tasks[0]!.nextRunAt).toBe(nextRunAt);

    await clock.advanceTo(at('2026-03-10T01:00:00Z'));
    expect(runs.map((run) => run.script)).toEqual(['v3']);
    instance.stop();
  });

  it('une signature qui change (planification, fuseau, runOnStart, timeoutMs) ré-arme sans laisser de timer orphelin', () => {
    const clock = new ManualClock('2026-03-10T00:07:00Z');
    const { instance } = scheduler(clock);
    const base = { id: 'a', script: 's', cron: '0 9 * * *', timezone: 'UTC' };
    instance.reconcile([base]);
    const armed = clock.delays.length;

    for (const changed of [
      { ...base, cron: '0 10 * * *' },
      { ...base, timezone: 'Europe/Paris' },
      { ...base, timeoutMs: 1000 },
      { ...base, runOnStart: true },
      { ...base, cron: undefined, everyMinutes: 30 },
    ]) {
      instance.reconcile([changed]);
      expect(clock.pending).toBe(1);
    }
    expect(clock.delays.length).toBe(armed + 5);
    instance.stop();
  });

  it('une tâche absente ou désactivée est annulée', () => {
    const clock = new ManualClock('2026-03-10T00:07:00Z');
    const { instance } = scheduler(clock);
    instance.reconcile([
      { id: 'a', script: 's', everyMinutes: 5 },
      { id: 'b', script: 's', everyMinutes: 5 },
      { id: 'c', script: 's', everyMinutes: 5 },
    ]);
    expect(clock.pending).toBe(3);
    instance.reconcile([{ id: 'a', script: 's', everyMinutes: 5 }, { id: 'b', script: 's', everyMinutes: 5, enabled: false }]);
    expect(clock.pending).toBe(1);
    expect(instance.snapshot().tasks.map((task) => task.id)).toEqual(['a']);
    instance.reconcile(undefined);
    expect(clock.pending).toBe(0);
  });

  it('refuse sans rejet les secondes, @reboot, L, ?, un fuseau inconnu et une planification absente ; avertit une fois', () => {
    const clock = new ManualClock('2026-03-10T00:07:00Z');
    const { instance, logs } = scheduler(clock);
    const entries: ScheduledTaskEntry[] = [
      { id: 'six', script: 's', cron: '* * * * * *' },
      { id: 'reboot', script: 's', cron: '@reboot' },
      { id: 'last', script: 's', cron: '0 0 L * *' },
      { id: 'question', script: 's', cron: '0 0 ? * *' },
      { id: 'zone', script: 's', cron: '0 9 * * *', timezone: 'Mars/Phobos' },
      { id: 'none', script: 's' },
      { id: 'zero', script: 's', everyMinutes: 0 },
      { id: 'huge', script: 's', everyMinutes: 600_000 },
      { id: 'fraction', script: 's', everyMinutes: 1.5 },
      // `cron` fait foi : un cron invalide n'est PAS remplacé par le repli everyMinutes du Manager.
      { id: 'fallback', script: 's', cron: '* * * * * *', everyMinutes: 10_080 },
    ];
    instance.reconcile(entries);
    instance.reconcile(entries);

    expect(clock.pending).toBe(0);
    const snapshot = instance.snapshot();
    expect(snapshot.tasks).toEqual([]);
    expect(snapshot.ignored.map((item) => item.id)).toEqual(entries.map((entry) => entry.id));
    expect(logs.filter((line) => line.level === 'warn' && line.message.includes('ignored'))).toHaveLength(entries.length);
    instance.stop();
  });

  it('un cron vide ou blanc retombe sur everyMinutes ; un cron valide prime sur everyMinutes', async () => {
    const clock = new ManualClock('2026-03-10T00:00:30Z');
    const { instance, runs } = scheduler(clock);
    instance.reconcile([
      { id: 'blank', script: 's', cron: '   ', everyMinutes: 5 },
      { id: 'both', script: 's', cron: '*/10 * * * *', everyMinutes: 10_080 },
    ]);
    expect(instance.snapshot().tasks.map((task) => [task.id, task.kind])).toEqual([
      ['blank', 'interval'],
      ['both', 'cron'],
    ]);
    await clock.advanceTo(at('2026-03-10T00:10:30Z'));
    expect(runs.map((run) => `${run.id}@${run.at.slice(11, 16)}`).sort()).toEqual([
      'blank@00:05',
      'blank@00:10',
      'both@00:10',
    ]);
    instance.stop();
  });

  it('une entrée redevenue valide n’est plus signalée comme ignorée', () => {
    const clock = new ManualClock('2026-03-10T00:07:00Z');
    const { instance } = scheduler(clock);
    instance.reconcile([{ id: 'a', script: 's', cron: '* * * * * *' }]);
    expect(instance.snapshot().ignored).toHaveLength(1);
    instance.reconcile([{ id: 'a', script: 's', cron: '* * * * *' }]);
    expect(instance.snapshot().ignored).toEqual([]);
    expect(instance.snapshot().tasks).toHaveLength(1);
    instance.stop();
  });
});

describe('ScheduledTasks : arrêt', () => {
  it('annule les timers, journalise les exécutions en vol, ne ré-arme pas et reste réutilisable', async () => {
    const clock = new ManualClock('2026-03-10T00:00:30Z');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { instance, logs } = scheduler(clock, {
      run: async () => {
        await gate;
        return { ok: true, ms: 1 };
      },
    });
    const entries = [{ id: 'busy', script: 's', everyMinutes: 1 }];
    instance.reconcile(entries);
    await clock.advanceTo(at('2026-03-10T00:01:30Z'));
    expect(instance.snapshot().running).toBe(1);

    instance.stop();
    expect(clock.pending).toBe(0);
    expect(instance.snapshot().tasks).toEqual([]);
    expect(
      logs.some((line) => line.level === 'info' && line.message.includes('still running when the scheduler stopped')),
    ).toBe(true);

    release();
    await flush();
    expect(clock.pending).toBe(0);
    expect(instance.snapshot().running).toBe(0);

    instance.reconcile(entries);
    expect(clock.pending).toBe(1);
    instance.stop();
  });
});

describe('tâche planifiée : timeout et fin réelle du script (exécution réelle)', () => {
  const sleepScript = 'await new Promise((resolve) => setTimeout(resolve, 200)); return 42;';

  it('registre : runScheduled rend un résultat échoué dont `settled` ne se résout qu’à la fin réelle du script', async () => {
    const executor = new ScriptExecutor(5000);
    const registry = new HandlerRegistry(
      new EventEmitter() as unknown as Client,
      parseJsBotConfig({ token: 'x' }),
      'bot-1',
      executor,
      { getGlobalVariables: async () => ({}) } as VariableDatabase,
      () => undefined,
    );
    const startedAt = Date.now();
    const outcome = await registry.runScheduled({ id: 'slow', script: sleepScript, timeoutMs: 40 });

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('timed out after 40ms');
    expect(Date.now() - startedAt).toBeLessThan(150);
    expect(outcome.settled).toBeDefined();
    await outcome.settled;
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(190);

    const fast = await registry.runScheduled({ id: 'fast', script: 'return 1;' });
    expect(fast.ok).toBe(true);
    expect(fast.settled).toBeUndefined();
    executor.dispose();
  });

  it('registre : le timeout d’une tâche ne dépasse jamais scriptTimeoutMs', async () => {
    const executor = new ScriptExecutor(5000);
    const registry = new HandlerRegistry(
      new EventEmitter() as unknown as Client,
      parseJsBotConfig({ token: 'x', scriptTimeoutMs: 30 }),
      'bot-1',
      executor,
      { getGlobalVariables: async () => ({}) } as VariableDatabase,
      () => undefined,
    );
    const outcome = await registry.runScheduled({ id: 'slow', script: sleepScript, timeoutMs: 5000 });
    expect(outcome.error).toContain('timed out after 30ms');
    await outcome.settled;
    executor.dispose();
  });
});

describe('JsDiscordRunner : le planificateur survit à la reconnexion', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    clearLastKnownPortalIntents();
    clearDiscordIpBlock();
    delete (globalThis as Record<string, unknown>).__schedTicks;
  });

  /** Login simulé : le client n'est « prêt » qu'après ClientReady, comme en vrai. */
  function mockDiscord() {
    vi.spyOn(Client.prototype, 'login').mockResolvedValue('token');
    let connected = false;
    vi.spyOn(Client.prototype, 'isReady').mockImplementation((() => connected) as never);
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ flags: 0 }), { status: 200 }),
    ) as unknown as typeof fetch;
    return {
      setConnected: (value: boolean) => {
        connected = value;
      },
    };
  }

  it('une reconnexion pour changement d’intents ne rejoue pas runOnStart et garde les échéances ; stop() arrête tout', async () => {
    startAt('2026-03-10T00:07:00Z');
    const discord = mockDiscord();
    (globalThis as Record<string, unknown>).__schedTicks = 0;
    const ticks = () => (globalThis as Record<string, unknown>).__schedTicks as number;
    const logs: Array<{ level: Level; message: string }> = [];
    const config = () =>
      parseJsBotConfig({
        token: 'token',
        scheduled: [
          {
            id: 'tick',
            script: 'globalThis.__schedTicks = (globalThis.__schedTicks ?? 0) + 1;',
            everyMinutes: 15,
            runOnStart: true,
          },
        ],
      });
    const runner = new JsDiscordRunner(
      'bot-sched',
      config(),
      { getGlobalVariables: async () => ({}) } as unknown as VariableDatabase,
      (level, message) => logs.push({ level, message }),
    );
    const internals = runner as unknown as { client: Client; scheduler: ScheduledTasks };
    const step = async (ms: number) => {
      vi.advanceTimersByTime(ms);
      await flush(300);
    };

    await runner.start();
    const scheduler = internals.scheduler;
    const firstClient = internals.client;
    // mount() a lieu avant le login : la tâche est armée, runOnStart attend ClientReady.
    expect(scheduler.snapshot().tasks.map((task) => task.id)).toEqual(['tick']);
    await step(30_000);
    expect(ticks()).toBe(0);

    discord.setConnected(true);
    firstClient.emit(Events.ClientReady, firstClient as never);
    await step(DEFAULT_RUN_ON_START_DELAY_MS);
    expect(ticks()).toBe(1);

    // Changement d'intents : reload() reconnecte (nouveau client, nouveau registre), pas le planificateur.
    vi.spyOn(
      runner as unknown as { resolveEffectiveIntents: () => Promise<Record<string, boolean>> },
      'resolveEffectiveIntents',
    ).mockResolvedValue({ Guilds: true, 'Guild Messages': true });
    const nextRunAt = scheduler.snapshot().tasks[0]!.nextRunAt;
    discord.setConnected(false);
    await runner.reload(config());
    const secondClient = internals.client;
    expect(secondClient).not.toBe(firstClient);
    expect(internals.scheduler).toBe(scheduler);
    expect(scheduler.snapshot().tasks.map((task) => [task.id, task.nextRunAt])).toEqual([['tick', nextRunAt]]);

    discord.setConnected(true);
    secondClient.emit(Events.ClientReady, secondClient as never);
    await step(60_000);
    expect(ticks()).toBe(1); // runOnStart n'est pas rejoué

    // L'échéance de 00:15 (ancrée sur l'époque) tire une fois sur le nouveau client.
    await step(15 * 60_000);
    expect(ticks()).toBe(2);
    expect(scheduler.snapshot().tasks[0]!.runs).toBe(2);

    await runner.stop();
    expect(scheduler.snapshot().tasks).toEqual([]);
    await step(60 * 60_000);
    expect(ticks()).toBe(2);
    expect(logs.filter((line) => line.level === 'error')).toEqual([]);
    expect(runner.getScheduledSnapshot().tasks).toEqual([]);
  });

  it.each([
    ['blocage d’IP Discord actif', 'block'],
    ['échec de la résolution des intents', 'intents'],
  ] as const)(
    'une reconnexion décidée par reload() qui échoue (%s) arrête le planificateur : aucune tâche armée sans client',
    async (_name, cause) => {
      startAt('2026-03-10T00:07:00Z');
      const discord = mockDiscord();
      (globalThis as Record<string, unknown>).__schedTicks = 0;
      const logs: Array<{ level: Level; message: string }> = [];
      const config = (token: string) =>
        parseJsBotConfig({
          token,
          scheduled: [
            { id: 'tick', script: 'globalThis.__schedTicks = (globalThis.__schedTicks ?? 0) + 1;', everyMinutes: 1 },
          ],
        });
      const runner = new JsDiscordRunner(
        'bot-sched',
        config('token'),
        { getGlobalVariables: async () => ({}) } as unknown as VariableDatabase,
        (level, message) => logs.push({ level, message }),
      );
      const internals = runner as unknown as { client: Client | null; registry: unknown };
      await runner.start();
      discord.setConnected(true);
      expect(runner.getScheduledSnapshot().tasks.map((task) => task.id)).toEqual(['tick']);

      const resolve = vi.spyOn(
        runner as unknown as { resolveEffectiveIntents: () => Promise<Record<string, boolean>> },
        'resolveEffectiveIntents',
      );
      if (cause === 'block') {
        resolve.mockResolvedValue({ Guilds: true });
        armDiscordIpBlock(120);
      } else {
        // Le premier appel est celui de reload() ; le second, dans start(), échoue après teardown().
        resolve.mockResolvedValueOnce({ Guilds: true }).mockRejectedValue(new Error('intents unavailable'));
      }

      // Un jeton différent force start() : le client et le registre sont détruits avant l'échec.
      await expect(runner.reload(config('other-token'))).rejects.toThrow();
      expect(internals.client).toBeNull();
      expect(internals.registry).toBeNull();

      // Sans client ni registre, plus rien ne doit rester armé (ni exposé dans le statut).
      expect(runner.getScheduledSnapshot().tasks).toEqual([]);
      vi.advanceTimersByTime(5 * 60_000);
      await flush(300);
      expect((globalThis as Record<string, unknown>).__schedTicks).toBe(0);
      expect(logs.filter((line) => line.message.includes('skipped'))).toEqual([]);
      await runner.stop();
    },
  );

  describe('marqueur de runOnStart dans le dossier d’état', () => {
    const script = 'globalThis.__schedTicks = (globalThis.__schedTicks ?? 0) + 1;';
    const markerFile = (stateDir: string) =>
      path.join(
        stateDir,
        'scheduled-start',
        'bot-sched',
        `tick-${createHash('sha1').update(script).digest('hex').slice(0, 12)}.running`,
      );

    async function startWithStateDir(stateDir: string) {
      startAt('2026-03-10T00:07:00Z');
      const discord = mockDiscord();
      (globalThis as Record<string, unknown>).__schedTicks = 0;
      const logs: Array<{ level: Level; message: string }> = [];
      const runner = new JsDiscordRunner(
        'bot-sched',
        parseJsBotConfig({
          token: 'token',
          scheduled: [{ id: 'tick', script, everyMinutes: 60, runOnStart: true }],
        }),
        { getGlobalVariables: async () => ({}) } as unknown as VariableDatabase,
        (level, message) => logs.push({ level, message }),
        undefined,
        undefined,
        { stateDir },
      );
      await runner.start();
      const client = (runner as unknown as { client: Client }).client;
      discord.setConnected(true);
      client.emit(Events.ClientReady, client as never);
      vi.advanceTimersByTime(DEFAULT_RUN_ON_START_DELAY_MS);
      await flush(300);
      return { runner, logs };
    }

    it('un runOnStart terminé ne laisse aucun marqueur', async () => {
      const stateDir = mkdtempSync(path.join(os.tmpdir(), 'runner-state-'));
      try {
        const { runner } = await startWithStateDir(stateDir);
        expect((globalThis as Record<string, unknown>).__schedTicks).toBe(1);
        expect(existsSync(markerFile(stateDir))).toBe(false);
        await runner.stop();
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
      }
    });

    it('le marqueur d’un runOnStart interrompu par un crash empêche son rejeu, avec un avertissement', async () => {
      const stateDir = mkdtempSync(path.join(os.tmpdir(), 'runner-state-'));
      try {
        mkdirSync(path.dirname(markerFile(stateDir)), { recursive: true });
        writeFileSync(markerFile(stateDir), 'interrupted');
        const { runner, logs } = await startWithStateDir(stateDir);
        expect((globalThis as Record<string, unknown>).__schedTicks).toBe(0);
        expect(logs.some((line) => line.level === 'warn' && line.message.includes('runOnStart skipped'))).toBe(true);
        expect(existsSync(markerFile(stateDir))).toBe(true); // le marqueur reste : les redémarrages suivants sautent aussi
        await runner.stop();
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
      }
    });
  });
});

describe('planificateur : erreurs et client prêt', () => {
  it('un script qui échoue journalise une erreur avec l’id et la durée, sans rejet non géré, et la tâche tire de nouveau', async () => {
    startAt('2026-03-10T00:07:00Z');
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const { registry, advance, logs, times } = harness(
        { scheduled: [{ id: 'flaky', script: 'boom', everyMinutes: 5 }] },
        {
          behaviours: {
            boom: () => {
              throw new Error('kaput');
            },
          },
        },
      );
      registry.mount();
      await advance(10 * MIN); // 00:17
      await new Promise((resolve) => setImmediate(resolve));

      expect(times()).toEqual(['00:10', '00:15']);
      const failure = logs.find((line) => line.level === 'error' && line.message.includes('kaput'));
      expect(failure?.message).toContain('Scheduled task flaky');
      expect(failure?.message).toMatch(/failed after \d+ms/);
      expect(unhandled).toEqual([]);
      registry.clear();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('client non prêt : le tir est sauté avec un avertissement ; client sans isReady : il s’exécute', async () => {
    startAt('2026-03-10T00:07:00Z');
    let ready = false;
    const client = Object.assign(new EventEmitter(), { isReady: () => ready });
    const { registry, advance, times, logs } = harness(
      { scheduled: [{ id: 'gated', script: 'tick', everyMinutes: 5 }] },
      { client },
    );
    registry.mount();

    await advance(6 * MIN); // 00:13 : l'échéance de 00:10 tombe client non prêt
    expect(times()).toEqual([]);
    expect(
      logs.some((line) => line.level === 'warn' && line.message.includes('skipped: client not ready')),
    ).toBe(true);

    ready = true;
    await advance(5 * MIN); // 00:18
    expect(times()).toEqual(['00:15']);
    registry.clear();
  });
});

describe('planificateur : arrêt', () => {
  it('après clear() plus aucun tir et plus aucun timer', async () => {
    startAt('2026-03-10T00:07:00Z');
    const { registry, advance, runs } = harness({
      scheduled: [
        { id: 'a', script: 'tick', everyMinutes: 5 },
        { id: 'b', script: 'tick', cron: '*/7 * * * *' },
      ],
    });
    registry.mount();
    await advance(6 * MIN);
    const before = runs.length;
    expect(before).toBeGreaterThan(0);

    registry.clear();
    expect(vi.getTimerCount()).toBe(0);
    await advance(30 * MIN);
    expect(runs).toHaveLength(before);
  });

  it('clear() pendant un run en vol : pas de ré-armement ; clear() puis mount() ne double pas les timers', async () => {
    startAt('2026-03-10T00:07:00Z');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { registry, advance, runs } = harness(
      { scheduled: [{ id: 'slow', script: 'slow', everyMinutes: 5 }] },
      { behaviours: { slow: () => gate } },
    );
    registry.mount();
    await advance(4 * MIN); // 00:11, tir de 00:10 en vol
    expect(runs).toHaveLength(1);

    registry.clear();
    release();
    await flush();
    expect(vi.getTimerCount()).toBe(0);

    registry.mount();
    registry.mount();
    expect(vi.getTimerCount()).toBe(1);
    registry.clear();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('planificateur : réconciliation au rechargement', () => {
  it('un script seul modifié garde l’échéance et exécute le nouveau script au tir suivant', async () => {
    startAt('2026-03-10T00:07:00Z');
    const { registry, config, advance, runs } = harness({
      scheduled: [{ id: 'job', script: 'v1', everyMinutes: 60 }],
    });
    registry.mount();
    await advance(23 * MIN); // 00:30

    registry.updateConfig({
      ...config,
      scheduled: config.scheduled.map((entry) => ({ ...entry, script: 'v2' })),
    });
    await advance(31 * MIN); // 01:01
    expect(runs.map((run) => [run.script, run.at.slice(11, 16)])).toEqual([['v2', '01:00']]);
    registry.clear();
  });

  it('une tâche supprimée ou désactivée voit son timer annulé', async () => {
    startAt('2026-03-10T00:07:00Z');
    const { registry, config, advance, runs } = harness({
      scheduled: [
        { id: 'keep', script: 'keep', everyMinutes: 60 },
        { id: 'drop', script: 'drop', everyMinutes: 60 },
        { id: 'off', script: 'off', everyMinutes: 60 },
      ],
    });
    registry.mount();
    expect(vi.getTimerCount()).toBe(3);

    registry.updateConfig({
      ...config,
      scheduled: [
        config.scheduled[0]!,
        { ...config.scheduled[2]!, enabled: false },
      ],
    });
    expect(vi.getTimerCount()).toBe(1);
    await advance(60 * MIN);
    expect(runs.map((run) => run.script)).toEqual(['keep']);
    registry.clear();
  });

  it('un cron modifié est ré-armé sur sa nouvelle planification', async () => {
    startAt('2026-03-10T00:07:00Z');
    const { registry, config, advance, times } = harness({
      scheduled: [{ id: 'job', script: 'tick', cron: '*/5 * * * *' }],
    });
    registry.mount();
    await advance(5 * MIN); // 00:12 : 00:10 a tiré
    registry.updateConfig({
      ...config,
      scheduled: config.scheduled.map((entry) => ({ ...entry, cron: '*/10 * * * *' })),
    });
    await advance(20 * MIN); // 00:32
    expect(times()).toEqual(['00:10', '00:20', '00:30']);
    registry.clear();
  });

  it('une entrée sans planification valide ou au fuseau inconnu est ignorée avec un avertissement, sans rejeter la configuration', async () => {
    startAt('2026-03-10T00:07:00Z');
    const { registry, advance, times, logs } = harness({
      scheduled: [
        { id: 'empty', script: 'tick' },
        { id: 'sec', script: 'tick', cron: '* * * * * *' },
        { id: 'tz', script: 'tick', cron: '0 9 * * *', timezone: 'Mars/Phobos' },
        { id: 'good', script: 'tick', everyMinutes: 5 },
      ],
    });
    registry.mount();
    await advance(10 * MIN);

    expect(times()).toEqual(['00:10', '00:15']); // 'good' seule
    for (const id of ['empty', 'sec', 'tz']) {
      expect(
        logs.some((line) => line.level === 'warn' && line.message.includes(`Scheduled task ${id} ignored`)),
      ).toBe(true);
    }
    registry.clear();
  });
});
