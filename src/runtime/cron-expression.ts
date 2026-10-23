import { Cron } from 'croner';

/**
 * Expressions cron et fuseaux des tâches planifiées.
 *
 * Le runner n'accepte qu'un SOUS-ENSEMBLE strict de ce que croner comprend (il évalue, mais ne juge pas) :
 * 5 champs ou une macro @hourly @daily @weekly @monthly @yearly, sans secondes, sans L W # ? H @reboot,
 * dimanche en 0 (jamais 7), pas valable seulement sur `*` ou une plage. Une configuration qui contourne le
 * Manager (import, poussée directe, application) ne peut donc pas obtenir un tir par seconde. Les règles
 * reproduisent `NormalizeCronExpression` / `NormalizeCronTimezone` du Manager, et les mêmes vecteurs
 * (test/fixtures/cron-vectors.json) sont rejoués des deux côtés.
 */

export const MAX_CRON_EXPRESSION_LENGTH = 100;
export const DEFAULT_CRON_TIMEZONE = 'UTC';

const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'] as const;
const DAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;
const MACROS = new Set(['@hourly', '@daily', '@weekly', '@monthly', '@yearly']);
const TIMEZONE_PATTERN = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/;

interface FieldSpec {
  label: string;
  min: number;
  max: number;
  /** Noms à trois lettres acceptés pour ce champ (indexés à partir de `nameBase`). */
  names?: readonly string[];
  nameBase?: number;
}

const FIELD_SPECS: readonly FieldSpec[] = [
  { label: 'minute', min: 0, max: 59 },
  { label: 'hour', min: 0, max: 23 },
  { label: 'day of month', min: 1, max: 31 },
  { label: 'month', min: 1, max: 12, names: MONTH_NAMES, nameBase: 1 },
  { label: 'day of week', min: 0, max: 6, names: DAY_NAMES, nameBase: 0 },
];

export type CronCheck = { ok: true; canonical: string } | { ok: false; reason: string };
export type TimezoneCheck = { ok: true; timezone: string } | { ok: false; reason: string };

class CronSyntaxError extends Error {}

/** 1 ou 2 chiffres ASCII, rien d'autre (ni signe, ni décimale, ni hexadécimal). */
function parseCronNumber(text: string): number | null {
  return /^[0-9]{1,2}$/.test(text) ? Number.parseInt(text, 10) : null;
}

function cronValue(token: string, spec: FieldSpec): string {
  if (token === '') {
    throw new CronSyntaxError(`${spec.label}: missing value`);
  }
  const number = parseCronNumber(token);
  if (number !== null) {
    if (number < spec.min || number > spec.max) {
      throw new CronSyntaxError(`${spec.label}: ${number} is out of range ${spec.min}-${spec.max}`);
    }
    return String(number);
  }
  const upper = token.toUpperCase();
  if (spec.names?.includes(upper)) {
    return upper;
  }
  throw new CronSyntaxError(`${spec.label}: "${token}" is not a valid value`);
}

/** Rang d'une valeur canonique (nombre ou nom), pour comparer les bornes d'une plage. */
function cronOrdinal(value: string, spec: FieldSpec): number {
  const number = parseCronNumber(value);
  if (number !== null) {
    return number;
  }
  return (spec.names?.indexOf(value) ?? -1) + (spec.nameBase ?? 0);
}

function cronItem(item: string, spec: FieldSpec): string {
  const slash = item.indexOf('/');
  const base = slash < 0 ? item : item.slice(0, slash);
  const stepText = slash < 0 ? null : item.slice(slash + 1);
  let step = '';
  if (stepText !== null) {
    const n = parseCronNumber(stepText);
    if (n === null || n < 1 || n > spec.max) {
      throw new CronSyntaxError(`${spec.label}: step "${stepText}" must be a number from 1 to ${spec.max}`);
    }
    step = `/${n}`;
  }
  if (base === '*') {
    return `*${step}`;
  }
  const dash = base.indexOf('-');
  if (dash < 0) {
    if (stepText !== null) {
      throw new CronSyntaxError(`${spec.label}: "${item}" needs a range or *`);
    }
    return cronValue(base, spec);
  }
  const from = cronValue(base.slice(0, dash), spec);
  const to = cronValue(base.slice(dash + 1), spec);
  if (cronOrdinal(from, spec) > cronOrdinal(to, spec)) {
    throw new CronSyntaxError(`${spec.label}: range "${base}" goes backwards`);
  }
  return `${from}-${to}${step}`;
}

function cronField(field: string, spec: FieldSpec): string {
  return field
    .split(',')
    .map((item) => {
      if (item === '') {
        throw new CronSyntaxError(`${spec.label}: empty list item in "${field}"`);
      }
      return cronItem(item, spec);
    })
    .join(',');
}

/**
 * Valide une expression cron de 5 champs (ou une macro) et la rend sous forme canonique : champs séparés par
 * un seul espace, nombres sans zéro de tête, noms JAN-DEC et SUN-SAT en majuscules, macros en minuscules.
 * Jamais d'exception : un refus est un `{ ok: false, reason }`.
 */
export function normalizeCronExpression(input: unknown): CronCheck {
  if (typeof input !== 'string') {
    return { ok: false, reason: 'not a text value' };
  }
  const expression = input.trim();
  if (!expression) {
    return { ok: false, reason: 'empty expression' };
  }
  if (expression.length > MAX_CRON_EXPRESSION_LENGTH) {
    return { ok: false, reason: `longer than ${MAX_CRON_EXPRESSION_LENGTH} characters` };
  }
  if (!/^[\x20\x09\x21-\x7e]+$/.test(expression)) {
    return { ok: false, reason: 'only printable ASCII is allowed' };
  }
  const fields = expression.split(/[ \t]+/);
  if (fields.length === 1 && fields[0]!.startsWith('@')) {
    const macro = fields[0]!.toLowerCase();
    return MACROS.has(macro)
      ? { ok: true, canonical: macro }
      : { ok: false, reason: 'unsupported macro (use @hourly, @daily, @weekly, @monthly or @yearly)' };
  }
  if (fields.length !== FIELD_SPECS.length) {
    return {
      ok: false,
      reason: `expected 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}`,
    };
  }
  try {
    return { ok: true, canonical: fields.map((field, index) => cronField(field, FIELD_SPECS[index]!)).join(' ') };
  } catch (error) {
    if (error instanceof CronSyntaxError) {
      return { ok: false, reason: error.message };
    }
    throw error;
  }
}

/**
 * Fuseau IANA (Europe/Paris, UTC…). Absent ou vide = UTC. « Local » est refusé (il dépendrait de la machine) ;
 * un nom que l'environnement ne connaît pas (Intl) aussi.
 */
export function normalizeCronTimezone(input: unknown): TimezoneCheck {
  if (input === undefined || input === null) {
    return { ok: true, timezone: DEFAULT_CRON_TIMEZONE };
  }
  if (typeof input !== 'string') {
    return { ok: false, reason: 'not a text value' };
  }
  const timezone = input.trim();
  if (!timezone) {
    return { ok: true, timezone: DEFAULT_CRON_TIMEZONE };
  }
  if (timezone.length > 64 || !TIMEZONE_PATTERN.test(timezone) || timezone.toLowerCase() === 'local') {
    return { ok: false, reason: 'not an IANA time zone name' };
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    return { ok: false, reason: 'unknown time zone' };
  }
  return { ok: true, timezone };
}

/** Expression cron validée, évaluée par croner (DST géré : un seul tir par jour local, jamais zéro ni deux). */
export class CronSchedule {
  private constructor(
    readonly expression: string,
    readonly timezone: string,
    private readonly cron: Cron,
  ) {}

  static parse(
    expression: unknown,
    timezone?: unknown,
  ): { ok: true; schedule: CronSchedule } | { ok: false; reason: string } {
    const checkedExpression = normalizeCronExpression(expression);
    if (!checkedExpression.ok) {
      return { ok: false, reason: `invalid cron expression: ${checkedExpression.reason}` };
    }
    const checkedTimezone = normalizeCronTimezone(timezone);
    if (!checkedTimezone.ok) {
      return { ok: false, reason: `invalid time zone: ${checkedTimezone.reason}` };
    }
    try {
      const cron = new Cron(checkedExpression.canonical, { timezone: checkedTimezone.timezone });
      return {
        ok: true,
        schedule: new CronSchedule(checkedExpression.canonical, checkedTimezone.timezone, cron),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: `invalid cron expression: ${message}` };
    }
  }

  /** Prochain instant (ms depuis l'époque) STRICTEMENT après `afterMs`, ou null s'il n'y en a plus. */
  next(afterMs: number): number | null {
    let cursor = afterMs;
    // Garde-fou : une évaluation qui ne progresse pas (jamais constatée) ne doit pas boucler.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const date = this.cron.nextRun(new Date(cursor));
      if (!date) {
        return null;
      }
      const candidate = date.getTime();
      if (candidate > afterMs) {
        return candidate;
      }
      cursor = candidate;
    }
    return null;
  }

  describe(): string {
    return this.timezone === DEFAULT_CRON_TIMEZONE
      ? `cron "${this.expression}"`
      : `cron "${this.expression}" (${this.timezone})`;
  }
}
