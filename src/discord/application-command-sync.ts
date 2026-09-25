import { Routes } from 'discord.js';

/**
 * Names and types of the commands the bot should expose, as Discord expects them.
 *
 * `id` is deliberately absent: Discord assigns it, and the whole point of this
 * module is to stop replacing it.
 */
export interface DesiredApplicationCommand {
  type: number;
  name: string;
  description?: string;
  options?: unknown[];
  default_member_permissions?: string;
}

/** The subset of `@discordjs/rest`'s REST this module needs (so tests can fake it). */
export interface CommandRest {
  get(route: string): Promise<unknown>;
  post(route: string, options: { body: unknown }): Promise<unknown>;
  patch(route: string, options: { body: unknown }): Promise<unknown>;
  delete(route: string): Promise<unknown>;
}

export interface CommandSyncReport {
  created: string[];
  updated: string[];
  removed: string[];
  unchanged: string[];
}

function commandKey(command: { type?: number; name?: string }): string {
  return `${command.type ?? 1}:${command.name ?? ''}`;
}

/**
 * Projects a remote command onto the shape we manage.
 *
 * Discord returns far more than we send (`id`, `version`, `application_id`,
 * `nsfw`, `contexts`, locale maps, `default_member_permissions`, ...). Comparing
 * whole objects would report a difference on EVERY startup and rewrite every
 * command for nothing. We therefore compare only the fields we actually send,
 * recursively — the desired payload is the reference.
 */
function projectRemote(remote: unknown, desired: unknown): unknown {
  if (Array.isArray(desired)) {
    if (!Array.isArray(remote)) {
      return remote;
    }
    return desired.map((entry, index) => projectRemote(remote[index], entry));
  }
  if (desired !== null && typeof desired === 'object') {
    const source =
      remote !== null && typeof remote === 'object' ? (remote as Record<string, unknown>) : {};
    const projected: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(desired as Record<string, unknown>)) {
      projected[key] = projectRemote(source[key], value);
    }
    return projected;
  }
  return remote;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stable(entry)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** True when the remote command already carries everything we manage. */
export function commandMatches(remote: unknown, desired: DesiredApplicationCommand): boolean {
  return stable(projectRemote(remote, desired)) === stable(desired);
}

/**
 * Brings Discord's application commands in line with `desired`, WITHOUT
 * renumbering them.
 *
 * WHY NOT THE BULK OVERWRITE: `PUT /applications/{id}/commands` replaces the
 * whole set, so every command came back with a NEW id on every registration
 * (each startup, each `upsertCommand`, each intents change). The app and the
 * manager keep the ids they know, so all of them went stale at once: the app
 * could no longer edit or delete its own commands (10063 "Unknown application
 * command"), and a comparison by id concluded every command was an orphan.
 *
 * The diff uses the per-command routes instead: same name and type → keep the
 * id and PATCH only what changed, missing → create, extra → delete. Two
 * consequences worth knowing:
 *
 * - a stable configuration costs ZERO requests after the first registration
 *   (today every startup rewrites everything), and
 * - a field we do not send is LEFT ALONE on Discord, because PATCH is partial.
 *   That is what stops a command restricted to administrators from being
 *   reopened to everyone at the next startup.
 *
 * The first registration of a bot with N commands costs N requests instead of
 * one. That is the price of stable identifiers, and it is paid once.
 */
export async function applyCommandDiff(
  rest: CommandRest,
  applicationId: string,
  desired: DesiredApplicationCommand[],
): Promise<CommandSyncReport> {
  const report: CommandSyncReport = { created: [], updated: [], removed: [], unchanged: [] };

  const remote = (await rest.get(Routes.applicationCommands(applicationId))) as Array<{
    id: string;
    type?: number;
    name?: string;
  }>;
  const remaining = new Map<string, { id: string; type?: number; name?: string }>();
  for (const command of remote ?? []) {
    if (command && typeof command.id === 'string') {
      remaining.set(commandKey(command), command);
    }
  }

  for (const command of desired) {
    const key = commandKey(command);
    const existing = remaining.get(key);
    if (!existing) {
      await rest.post(Routes.applicationCommands(applicationId), { body: command });
      report.created.push(command.name);
      continue;
    }
    remaining.delete(key);
    if (commandMatches(existing, command)) {
      report.unchanged.push(command.name);
      continue;
    }
    await rest.patch(Routes.applicationCommand(applicationId, existing.id), { body: command });
    report.updated.push(command.name);
  }

  for (const leftover of remaining.values()) {
    await rest.delete(Routes.applicationCommand(applicationId, leftover.id));
    report.removed.push(leftover.name ?? '');
  }

  return report;
}
