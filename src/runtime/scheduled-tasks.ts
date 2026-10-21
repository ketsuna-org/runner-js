import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { CronSchedule } from './cron-expression.js';

/**
 * Planificateur des tâches `scheduled` d'un bot (intervalles et cron).
 *
 * - Un timer chaîné par tâche (`setTimeout`, `unref`), jamais de `setInterval` : le délai est plafonné à
 *   2^31-1 ms (un délai plus long se déclencherait aussitôt) et ré-armé par paliers.
 * - Les intervalles sont ancrés sur l'époque Unix (multiples de N minutes, UTC) : le prochain tir ne dépend
 *   donc ni de l'instant de montage ni du nombre de rechargements. `cron` s'évalue dans son fuseau.
 * - Pas de rattrapage (un retard n'est jamais rejoué), pas de chevauchement d'une même tâche, au plus
 *   `maxConcurrent` exécutions simultanées pour le bot. Une tâche qui arrive à échéance alors que toutes les
 *   places sont prises ATTEND la première place libre (file d'arrivée, une seule entrée par tâche) au lieu
 *   d'être sautée : sans cela, les dernières tâches déclarées d'un bot dont les échéances coïncident (4 tâches
 *   `everyMinutes: 60`) ne tireraient jamais. Une exécution compte jusqu'à la fin RÉELLE du script
 *   (un timeout n'annule rien), pas jusqu'au rejet du timeout.
 * - `reconcile()` compare par signature : un rechargement ne touche pas aux tâches inchangées.
 * - L'instance vit au-dessus du registre de handlers : elle survit au remontage du registre et à la
 *   reconnexion du client.
 */

type TimerHandle = ReturnType<typeof setTimeout>;
type LogLevel = 'info' | 'warn' | 'error' | 'debug';

/** Au-delà, `setTimeout` se déclenche immédiatement (avertissement de dépassement 32 bits). */
export const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
export const MAX_EVERY_MINUTES = 10_080;
export const DEFAULT_MAX_CONCURRENT_RUNS = 3;
/** Délai entre le client prêt (ou le montage) et le tir `runOnStart` : laisse le cache des serveurs se remplir. */
export const DEFAULT_RUN_ON_START_DELAY_MS = 5_000;
/** Au-delà de ce retard sur l'échéance (boucle d'événements bloquée, machine suspendue), un avertissement est émis. */
export const LATE_FIRE_WARN_MS = 60_000;
/** Un marqueur de `runOnStart` plus vieux que ceci est considéré comme périmé. */
export const STARTUP_MARKER_MAX_AGE_MS = 30 * 60_000;

const MAX_ERROR_CHARS = 300;

export interface ScheduledTaskEntry {
  id: string;
  script: string;
  enabled?: boolean;
  everyMinutes?: number;
  cron?: string;
  timezone?: string;
  runOnStart?: boolean;
  timeoutMs?: number;
}

export interface TaskRunOutcome {
  ok: boolean;
  ms: number;
  error?: string;
  stack?: string;
  /**
   * Présent seulement quand le script tourne ENCORE alors que l'exécution est terminée pour l'appelant
   * (timeout) : se résout à la fin réelle du script. Le planificateur garde la place jusque-là.
   */
  settled?: Promise<unknown>;
}

/** Marqueur d'un `runOnStart` en cours : un tir interrompu par un crash ne doit pas être rejoué à l'infini. */
export interface StartupGuard {
  /** Faux si un marqueur d'un tir précédent jamais terminé existe (le tir est alors sauté). */
  begin(key: string): boolean;
  end(key: string): void;
}

export interface ScheduledTasksOptions {
  run: (entry: ScheduledTaskEntry) => Promise<TaskRunOutcome>;
  log: (level: LogLevel, message: string) => void;
  /** Absent = toujours prêt (client sans `isReady`). */
  isReady?: () => boolean;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  maxConcurrent?: number;
  runOnStartDelayMs?: number;
  startupGuard?: StartupGuard;
}

export interface ScheduledTaskSnapshot {
  id: string;
  kind: 'interval' | 'cron';
  schedule: string;
  /** Prochaine échéance (ISO) ; null si la planification n'a plus d'échéance. */
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastOk: boolean | null;
  lastDurationMs: number | null;
  lastError: string | null;
  running: boolean;
  runs: number;
  failures: number;
  skippedOverlap: number;
  skippedNotReady: number;
  skippedConcurrency: number;
}

export interface ScheduledSnapshot {
  /** Exécutions en cours (y compris celles qui ont dépassé leur timeout et ne sont pas terminées). */
  running: number;
  maxConcurrent: number;
  tasks: ScheduledTaskSnapshot[];
  /** Entrées de la configuration que le planificateur n'exécute pas, avec la raison. */
  ignored: Array<{ id: string; reason: string }>;
}

type ParsedSchedule =
  | { ok: true; kind: 'interval'; periodMs: number; label: string; signature: string }
  | { ok: true; kind: 'cron'; cron: CronSchedule; label: string; signature: string }
  | { ok: false; reason: string };

type SkipReason = 'still running' | 'client not ready' | 'concurrency limit';

interface TaskState {
  entry: ScheduledTaskEntry;
  schedule: Exclude<ParsedSchedule, { ok: false }>;
  signature: string;
  timer: TimerHandle | null;
  target: number | null;
  /** Retiré de la configuration, remplacé ou planificateur arrêté : plus aucun tir ni ré-armement. */
  active: boolean;
  running: boolean;
  runningSince: number | null;
  /** Clé du marqueur du tir `runOnStart` en cours, le cas échéant. */
  startGuardKey: string | null;
  noUpcomingWarned: boolean;
  lastRunAt: number | null;
  lastOk: boolean | null;
  lastDurationMs: number | null;
  lastError: string | null;
  runs: number;
  failures: number;
  skippedOverlap: number;
  skippedNotReady: number;
  skippedConcurrency: number;
  streaks: Partial<Record<SkipReason, number>>;
}

function defaultSetTimer(callback: () => void, delayMs: number): TimerHandle {
  const handle = setTimeout(callback, delayMs);
  (handle as { unref?: () => void }).unref?.();
  return handle;
}

function defaultClearTimer(handle: TimerHandle): void {
  clearTimeout(handle);
}

function truncate(text: string): string {
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}...` : text;
}

/** Une expression ou un fuseau lu dans la configuration est affiché entre guillemets, sans contrôle ni excès. */
function printable(text: unknown): string {
  return truncate(String(text).replace(/[\x00-\x1f\x7f]/g, ' '));
}

function describeSchedule(entry: ScheduledTaskEntry): ParsedSchedule {
  const cron = typeof entry.cron === 'string' ? entry.cron.trim() : '';
  const flags = `${entry.runOnStart === true ? 1 : 0}|${entry.timeoutMs ?? ''}`;
  if (cron) {
    const parsed = CronSchedule.parse(cron, entry.timezone);
    if (!parsed.ok) {
      return { ok: false, reason: `${parsed.reason} (cron "${printable(cron)}")` };
    }
    return {
      ok: true,
      kind: 'cron',
      cron: parsed.schedule,
      label: parsed.schedule.describe(),
      signature: `cron|${parsed.schedule.expression}|${parsed.schedule.timezone}|${flags}`,
    };
  }
  const every = entry.everyMinutes;
  if (typeof every === 'number' && Number.isInteger(every) && every >= 1 && every <= MAX_EVERY_MINUTES) {
    return {
      ok: true,
      kind: 'interval',
      periodMs: every * 60_000,
      label: `every ${every} min`,
      signature: `every|${every}||${flags}`,
    };
  }
  return {
    ok: false,
    reason: `no valid schedule (set a cron expression or everyMinutes between 1 and ${MAX_EVERY_MINUTES})`,
  };
}

export class ScheduledTasks {
  private readonly tasks = new Map<string, TaskState>();
  private readonly pendingStart = new Set<string>();
  private readonly startTimers = new Set<TimerHandle>();
  /** Tâches dont le `runOnStart` a déjà été traité depuis le démarrage de ce planificateur. */
  private readonly startHandled = new Set<string>();
  private readonly ignored = new Map<string, string>();
  private readonly ignoredWarned = new Map<string, string>();
  /** Tâches arrivées à échéance sans place libre, dans l'ordre d'arrivée, avec la cause de leur tir. */
  private readonly waiting = new Map<TaskState, 'schedule' | 'start'>();
  private active = 0;

  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => TimerHandle;
  private readonly clearTimer: (handle: TimerHandle) => void;
  private readonly maxConcurrent: number;
  private readonly runOnStartDelayMs: number;

  constructor(private readonly options: ScheduledTasksOptions) {
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimer ?? defaultSetTimer;
    this.clearTimer = options.clearTimer ?? defaultClearTimer;
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_RUNS);
    this.runOnStartDelayMs = Math.max(0, options.runOnStartDelayMs ?? DEFAULT_RUN_ON_START_DELAY_MS);
  }

  /**
   * Aligne les tâches armées sur la configuration. Une tâche absente ou désactivée est annulée ; une tâche
   * dont la signature (planification, fuseau, runOnStart, timeoutMs) change est ré-armée ; une tâche inchangée
   * garde son timer, seul son script est remplacé (le tir suivant exécute le nouveau).
   */
  reconcile(entries: readonly ScheduledTaskEntry[] | null | undefined): void {
    const wanted = new Map<string, { entry: ScheduledTaskEntry; schedule: Exclude<ParsedSchedule, { ok: false }> }>();
    this.ignored.clear();

    for (const entry of entries ?? []) {
      if (!entry || typeof entry.id !== 'string' || entry.enabled === false) {
        continue;
      }
      if (wanted.has(entry.id)) {
        this.ignore(entry.id, 'duplicate task id');
        continue;
      }
      const parsed = describeSchedule(entry);
      if (!parsed.ok) {
        this.ignore(entry.id, parsed.reason);
        continue;
      }
      this.ignoredWarned.delete(entry.id);
      wanted.set(entry.id, { entry, schedule: parsed });
    }
    for (const id of this.ignoredWarned.keys()) {
      if (!this.ignored.has(id)) {
        this.ignoredWarned.delete(id);
      }
    }

    for (const [id, task] of this.tasks) {
      if (!wanted.has(id)) {
        this.remove(task);
        this.tasks.delete(id);
        this.pendingStart.delete(id);
        this.startHandled.delete(id);
      }
    }

    for (const [id, { entry, schedule }] of wanted) {
      const existing = this.tasks.get(id);
      if (existing) {
        existing.entry = entry;
        if (existing.signature !== schedule.signature) {
          this.cancelTimer(existing);
          existing.schedule = schedule;
          existing.signature = schedule.signature;
          existing.noUpcomingWarned = false;
          this.arm(existing);
        }
        continue;
      }
      const task = this.createTask(entry, schedule);
      this.tasks.set(id, task);
      this.arm(task);
      if (entry.runOnStart === true && !this.startHandled.has(id)) {
        this.startHandled.add(id);
        if (this.ready()) {
          this.scheduleStart(task);
        } else {
          this.pendingStart.add(id);
        }
      }
    }
  }

  /** Le client est prêt : les `runOnStart` en attente partent (après le délai de démarrage). */
  markReady(): void {
    const pending = [...this.pendingStart];
    this.pendingStart.clear();
    for (const id of pending) {
      const task = this.tasks.get(id);
      if (task?.active) {
        this.scheduleStart(task);
      }
    }
  }

  /** Annule tous les timers. Les exécutions en cours ne sont pas interrompues (un script ne s'annule pas). */
  stop(): void {
    const now = this.now();
    for (const task of this.tasks.values()) {
      if (task.running) {
        this.options.log(
          'info',
          `Scheduled task ${task.entry.id} was still running when the scheduler stopped (running for ${now - (task.runningSince ?? now)}ms)`,
        );
        // Arrêt volontaire : le marqueur ne doit pas faire croire à un crash au prochain démarrage.
        if (task.startGuardKey !== null) {
          this.options.startupGuard?.end(task.startGuardKey);
          task.startGuardKey = null;
        }
      }
      this.remove(task);
    }
    this.tasks.clear();
    for (const handle of this.startTimers) {
      this.clearTimer(handle);
    }
    this.startTimers.clear();
    this.pendingStart.clear();
    this.waiting.clear();
    this.startHandled.clear();
    this.ignored.clear();
    this.ignoredWarned.clear();
  }

  snapshot(): ScheduledSnapshot {
    return {
      running: this.active,
      maxConcurrent: this.maxConcurrent,
      tasks: [...this.tasks.values()].map((task) => ({
        id: task.entry.id,
        kind: task.schedule.kind,
        schedule: task.schedule.label,
        nextRunAt: task.target === null ? null : new Date(task.target).toISOString(),
        lastRunAt: task.lastRunAt === null ? null : new Date(task.lastRunAt).toISOString(),
        lastOk: task.lastOk,
        lastDurationMs: task.lastDurationMs,
        lastError: task.lastError,
        running: task.running,
        runs: task.runs,
        failures: task.failures,
        skippedOverlap: task.skippedOverlap,
        skippedNotReady: task.skippedNotReady,
        skippedConcurrency: task.skippedConcurrency,
      })),
      ignored: [...this.ignored].map(([id, reason]) => ({ id, reason })),
    };
  }

  private ready(): boolean {
    return this.options.isReady ? this.options.isReady() : true;
  }

  private ignore(id: string, reason: string): void {
    this.ignored.set(id, reason);
    // Un rechargement ne répète pas l'avertissement tant que la raison ne change pas.
    if (this.ignoredWarned.get(id) !== reason) {
      this.ignoredWarned.set(id, reason);
      this.options.log('warn', `Scheduled task ${id} ignored: ${reason}`);
    }
  }

  private createTask(
    entry: ScheduledTaskEntry,
    schedule: Exclude<ParsedSchedule, { ok: false }>,
  ): TaskState {
    return {
      entry,
      schedule,
      signature: schedule.signature,
      timer: null,
      target: null,
      active: true,
      running: false,
      runningSince: null,
      startGuardKey: null,
      noUpcomingWarned: false,
      lastRunAt: null,
      lastOk: null,
      lastDurationMs: null,
      lastError: null,
      runs: 0,
      failures: 0,
      skippedOverlap: 0,
      skippedNotReady: 0,
      skippedConcurrency: 0,
      streaks: {},
    };
  }

  private remove(task: TaskState): void {
    task.active = false;
    this.waiting.delete(task);
    this.cancelTimer(task);
    task.target = null;
  }

  private cancelTimer(task: TaskState): void {
    if (task.timer !== null) {
      this.clearTimer(task.timer);
      task.timer = null;
    }
  }

  private nextTarget(task: TaskState, now: number): number | null {
    const { schedule } = task;
    if (schedule.kind === 'interval') {
      return (Math.floor(now / schedule.periodMs) + 1) * schedule.periodMs;
    }
    return schedule.cron.next(now);
  }

  private arm(task: TaskState): void {
    if (!task.active) {
      return;
    }
    let target: number | null;
    try {
      target = this.nextTarget(task, this.now());
    } catch (error) {
      target = null;
      this.options.log(
        'error',
        `Scheduled task ${task.entry.id}: cannot compute the next run (${error instanceof Error ? error.message : String(error)})`,
      );
      task.noUpcomingWarned = true;
    }
    task.target = target;
    if (target === null) {
      if (!task.noUpcomingWarned) {
        task.noUpcomingWarned = true;
        this.options.log('warn', `Scheduled task ${task.entry.id} has no upcoming run (${task.schedule.label})`);
      }
      return;
    }
    this.wakeAt(task, target);
  }

  private wakeAt(task: TaskState, target: number): void {
    const delay = Math.min(Math.max(target - this.now(), 0), MAX_TIMER_DELAY_MS);
    task.timer = this.setTimer(() => this.onWake(task), delay);
  }

  private onWake(task: TaskState): void {
    task.timer = null;
    if (!task.active) {
      return;
    }
    const now = this.now();
    const target = task.target;
    // Délai plafonné (échéance lointaine) ou réveil en avance : on se rendort jusqu'à l'échéance.
    if (target !== null && now < target) {
      this.wakeAt(task, target);
      return;
    }
    try {
      const late = target === null ? 0 : now - target;
      if (late > LATE_FIRE_WARN_MS) {
        this.options.log(
          'warn',
          `Scheduled task ${task.entry.id} woke up ${Math.round(late / 1000)}s late (blocked event loop or suspended machine): running once, missed runs are not replayed`,
        );
      }
      this.dispatch(task, 'schedule');
    } catch (error) {
      this.options.log(
        'error',
        `Scheduled task ${task.entry.id}: scheduling error (${error instanceof Error ? error.message : String(error)})`,
      );
    } finally {
      // Ré-armement garanti, même si le tir lève : la prochaine échéance se calcule depuis maintenant.
      this.arm(task);
    }
  }

  private scheduleStart(task: TaskState): void {
    const handle = this.setTimer(() => {
      this.startTimers.delete(handle);
      if (!task.active) {
        return;
      }
      this.dispatch(task, 'start');
    }, this.runOnStartDelayMs);
    this.startTimers.add(handle);
  }

  private startKey(task: TaskState): string {
    const digest = createHash('sha1').update(task.entry.script).digest('hex').slice(0, 12);
    return `${task.entry.id}-${digest}`;
  }

  private dispatch(task: TaskState, trigger: 'schedule' | 'start'): void {
    if (task.running) {
      this.skip(task, 'still running');
      return;
    }
    if (!this.ready()) {
      this.skip(task, 'client not ready');
      return;
    }
    if (this.active >= this.maxConcurrent) {
      this.defer(task, trigger);
      return;
    }
    this.waiting.delete(task);
    let guardKey: string | null = null;
    if (trigger === 'start') {
      const guard = this.options.startupGuard;
      const key = this.startKey(task);
      if (guard && !guard.begin(key)) {
        this.options.log(
          'warn',
          `Scheduled task ${task.entry.id}: runOnStart skipped, the previous startup run never finished (crash or freeze). Edit the task script to run it again.`,
        );
        return;
      }
      guardKey = guard ? key : null;
      // Journalisé AVANT l'exécution : si le process meurt pendant ce tir, la trace existe.
      this.options.log('info', `Scheduled task ${task.entry.id}: running once at startup (runOnStart)`);
    }
    task.streaks = {};
    this.execute(task, guardKey).catch(() => undefined);
  }

  /**
   * Toutes les places sont prises : la tâche attend la première qui se libère (voir `drainWaiting`). Elle n'attend
   * qu'une fois : si son échéance suivante arrive avant qu'une place se libère, cette échéance-là est sautée
   * (pas de rattrapage). Un tir de démarrage (`runOnStart`) en attente n'est jamais rétrogradé en tir ordinaire.
   */
  private defer(task: TaskState, trigger: 'schedule' | 'start'): void {
    const queued = this.waiting.get(task);
    if (queued !== undefined) {
      if (trigger === 'start') {
        this.waiting.set(task, 'start');
      }
      this.skip(task, 'concurrency limit');
      return;
    }
    this.waiting.set(task, trigger);
    this.options.log('debug', `Scheduled task ${task.entry.id} deferred: waiting for a free slot (${this.active}/${this.maxConcurrent} running)`);
  }

  /** Une place vient de se libérer : les tâches en attente partent dans l'ordre d'arrivée, tant qu'il reste de la place. */
  private drainWaiting(): void {
    for (const [task, trigger] of this.waiting) {
      if (this.active >= this.maxConcurrent) {
        return;
      }
      this.waiting.delete(task);
      if (!task.active) {
        continue;
      }
      try {
        this.dispatch(task, trigger);
      } catch (error) {
        this.options.log(
          'error',
          `Scheduled task ${task.entry.id}: scheduling error (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    }
  }

  private async execute(task: TaskState, guardKey: string | null): Promise<void> {
    const startedAt = this.now();
    task.running = true;
    task.runningSince = startedAt;
    task.startGuardKey = guardKey;
    this.active += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      task.running = false;
      task.runningSince = null;
      task.startGuardKey = null;
      this.active -= 1;
      this.drainWaiting();
    };

    let outcome: TaskRunOutcome;
    try {
      outcome = await this.options.run(task.entry);
    } catch (error) {
      outcome = {
        ok: false,
        ms: this.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      };
    }

    try {
      if (guardKey !== null) {
        this.options.startupGuard?.end(guardKey);
      }
      this.record(task, startedAt, outcome);
    } finally {
      if (outcome.settled) {
        this.options.log(
          'warn',
          `Scheduled task ${task.entry.id} timed out but its script is still running: the task keeps its place until the script ends`,
        );
        outcome.settled.then(release, release);
      } else {
        release();
      }
    }
  }

  private record(task: TaskState, startedAt: number, outcome: TaskRunOutcome): void {
    const id = task.entry.id;
    task.runs += 1;
    task.lastRunAt = startedAt;
    task.lastOk = outcome.ok;
    task.lastDurationMs = outcome.ms;
    if (outcome.ok) {
      task.lastError = null;
      this.options.log('debug', `Scheduled task ${id} ok in ${outcome.ms}ms`);
      return;
    }
    task.failures += 1;
    const message = outcome.error ?? 'unknown error';
    task.lastError = truncate(message);
    const stack = outcome.stack ? `\n${outcome.stack}` : '';
    this.options.log(
      'error',
      `Scheduled task ${id} (${task.schedule.label}) failed after ${outcome.ms}ms: ${message}${stack}`,
    );
  }

  private skip(task: TaskState, reason: SkipReason): void {
    const streak = (task.streaks[reason] ?? 0) + 1;
    task.streaks[reason] = streak;
    if (reason === 'still running') task.skippedOverlap += 1;
    else if (reason === 'client not ready') task.skippedNotReady += 1;
    else task.skippedConcurrency += 1;
    // Un avertissement au premier saut d'une série, puis un tous les dix : pas de flot de journaux.
    const loud = streak === 1 || streak % 10 === 0;
    this.options.log(
      loud ? 'warn' : 'debug',
      `Scheduled task ${task.entry.id} skipped: ${reason}${streak > 1 ? ` (${streak} in a row)` : ''}`,
    );
  }
}

/**
 * Marqueurs sur disque (un fichier par tâche et par script) : un `runOnStart` qui a figé ou tué le process
 * ne se rejoue pas au redémarrage suivant, sans quoi un script bloquant ferait boucler le pod.
 */
export class FileStartupGuard implements StartupGuard {
  constructor(private readonly directory: string) {}

  private fileFor(key: string): string {
    return path.join(this.directory, `${key.replace(/[^\w.-]/g, '_').slice(0, 120)}.running`);
  }

  begin(key: string): boolean {
    try {
      const file = this.fileFor(key);
      if (existsSync(file) && Date.now() - statSync(file).mtimeMs < STARTUP_MARKER_MAX_AGE_MS) {
        return false;
      }
      mkdirSync(this.directory, { recursive: true });
      writeFileSync(file, new Date().toISOString());
    } catch {
      // Disque indisponible : on ne bloque pas la tâche pour autant.
    }
    return true;
  }

  end(key: string): void {
    try {
      rmSync(this.fileFor(key), { force: true });
    } catch {
      // Rien à faire : le marqueur expirera.
    }
  }
}
