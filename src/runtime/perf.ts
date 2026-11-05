import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Mesure d'UNE exécution (commande, bouton, événement, tâche, webhook) : où passe le temps
 * (hydratation des variables, script), combien d'appels au Manager et à Discord, et leur durée.
 *
 * La sonde voyage dans l'AsyncLocalStorage de l'exécution : le code profond (client du Manager,
 * transport REST de Discord) s'y rattache sans qu'on la passe en paramètre. Hors exécution mesurée
 * (option éteinte), chaque aide est un simple renvoi, sans coût notable.
 *
 * La ligne écrite est `perf {json}`, avec `"aud":"internal"` : télémétrie INTERNE, jamais montrée à
 * un utilisateur (/logs la retire sauf `?audience=internal`), toujours lisible par le MCP admin et
 * l'IA interne. Même format que le runner Dart. Aucun identifiant d'utilisateur, de salon ou de
 * serveur, aucun contenu.
 */

export const PERF_LINE_PREFIX = 'perf ';
export const PERF_FORMAT_VERSION = 1;

// Libellés de routes Manager distincts retenus par exécution ; le reste est regroupé sous « other ».
const MAX_MANAGER_ROUTES = 12;
const MAX_NAME_CHARS = 100;

const storage = new AsyncLocalStorage<PerfProbe>();

export class PerfProbe {
  private readonly startedAt = performance.now();
  private readonly phases = new Map<string, number>();
  private managerCalls = 0;
  private managerMs = 0;
  private readonly managerBy = new Map<string, [number, number]>();
  private discordCalls = 0;
  private discordMs = 0;

  elapsedMs(): number {
    return Math.round(performance.now() - this.startedAt);
  }

  addPhase(name: string, ms: number): void {
    this.phases.set(name, (this.phases.get(name) ?? 0) + ms);
  }

  addManager(route: string, ms: number): void {
    this.managerCalls += 1;
    this.managerMs += ms;
    const key = this.managerBy.has(route) || this.managerBy.size < MAX_MANAGER_ROUTES ? route : 'other';
    const entry = this.managerBy.get(key) ?? [0, 0];
    entry[0] += 1;
    entry[1] += ms;
    this.managerBy.set(key, entry);
  }

  addDiscord(ms: number): void {
    this.discordCalls += 1;
    this.discordMs += ms;
  }

  snapshot(): {
    phases: Record<string, number>;
    managerCalls: number;
    managerMs: number;
    discordCalls: number;
    discordMs: number;
  } {
    return {
      phases: Object.fromEntries([...this.phases].map(([k, v]) => [k, Math.round(v)])),
      managerCalls: this.managerCalls,
      managerMs: Math.round(this.managerMs),
      discordCalls: this.discordCalls,
      discordMs: Math.round(this.discordMs),
    };
  }

  /** Les champs structurés de cette exécution (la ligne de journal en est l'encodage JSON). */
  fields(kind: string, name: string, ok: boolean, ms: number = this.elapsedMs()): Record<string, unknown> {
    const fields: Record<string, unknown> = {
      v: PERF_FORMAT_VERSION,
      aud: 'internal',
      k: kind,
      ...(name ? { n: name.slice(0, MAX_NAME_CHARS) } : {}),
      ok,
      ms,
    };
    if (this.phases.size > 0) {
      fields.ph = Object.fromEntries([...this.phases].map(([k, v]) => [k, Math.round(v)]));
    }
    if (this.managerCalls > 0) {
      fields.mg = {
        n: this.managerCalls,
        ms: Math.round(this.managerMs),
        by: Object.fromEntries(
          [...this.managerBy].map(([route, [n, total]]) => [route, [n, Math.round(total)]]),
        ),
      };
    }
    if (this.discordCalls > 0) {
      fields.dc = { n: this.discordCalls, ms: Math.round(this.discordMs) };
    }
    return fields;
  }

  /** La ligne de journal de cette exécution. */
  line(kind: string, name: string, ok: boolean, ms: number = this.elapsedMs()): string {
    return `${PERF_LINE_PREFIX}${JSON.stringify(this.fields(kind, name, ok, ms))}`;
  }
}

export function currentProbe(): PerfProbe | undefined {
  return storage.getStore();
}

/** Exécute [fn] avec [probe] attachée à son contexte asynchrone. */
export function runWithProbe<T>(probe: PerfProbe, fn: () => Promise<T>): Promise<T> {
  return storage.run(probe, fn);
}

async function timed<T>(fn: () => Promise<T>, record: (ms: number) => void): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    record(performance.now() - start);
  }
}

/** Mesure une phase de l'exécution courante (`prep`, `hydrate`, `script`). Sans sonde : renvoi simple. */
export function perfPhase<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const probe = storage.getStore();
  if (!probe) return fn();
  return timed(fn, (ms) => probe.addPhase(name, ms));
}

/** Mesure un appel au Manager. [route] est un libellé statique (jamais un identifiant). */
export function perfManagerCall<T>(route: string, fn: () => Promise<T>): Promise<T> {
  const probe = storage.getStore();
  if (!probe) return fn();
  return timed(fn, (ms) => probe.addManager(route, ms));
}

/** Mesure un appel à Discord (REST), attente de plafond de débit comprise. */
export function perfDiscordCall<T>(fn: () => Promise<T>): Promise<T> {
  const probe = storage.getStore();
  if (!probe) return fn();
  return timed(fn, (ms) => probe.addDiscord(ms));
}

/**
 * Réglage de la mesure : éteinte par défaut. `BOT_CREATOR_RUNNER_PERF=1` l'allume pour tous les bots
 * de ce runner ; le champ `perf` de la configuration d'un bot l'allume pour lui seul, à chaud (la
 * configuration est relue à chaque synchro). `BOT_CREATOR_RUNNER_PERF_MIN_MS=N` n'écrit que les
 * exécutions d'au moins N ms (les échecs sont toujours écrits).
 */
export const perfSettings = {
  allBots: false,
  minMs: 0,
  configureFromEnv(env: Record<string, string | undefined> = process.env): void {
    const flag = (env.BOT_CREATOR_RUNNER_PERF ?? '').trim().toLowerCase();
    perfSettings.allBots = ['1', 'true', 'on', 'yes'].includes(flag);
    const min = Number.parseInt((env.BOT_CREATOR_RUNNER_PERF_MIN_MS ?? '').trim(), 10);
    perfSettings.minMs = Number.isFinite(min) && min > 0 ? min : 0;
  },
  /** Une sonde pour ce bot, ou undefined si la mesure est éteinte. */
  probeFor(botPerf: boolean): PerfProbe | undefined {
    return perfSettings.allBots || botPerf ? new PerfProbe() : undefined;
  },
  shouldEmit(ms: number, ok: boolean, floorMs = 0): boolean {
    return !ok || ms >= Math.max(perfSettings.minMs, floorMs);
  },
  reset(): void {
    perfSettings.allBots = false;
    perfSettings.minMs = 0;
  },
};
