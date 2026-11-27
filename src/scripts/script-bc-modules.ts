/**
 * `bc.module.*` et `bc.command.*` : les modules installés et les commandes du bot, lus dans la
 * configuration réelle du bot. Parité avec `$moduleList`, `$moduleInfo`, `$moduleFeature`,
 * `$moduleSetting`, `$setModuleSetting`, `$commandList` et `$commandInfo` (BDFD) : mêmes champs, mêmes
 * erreurs, même cœur (`modules/module-query.ts`).
 *
 * Écrire un réglage exige « Gérer le serveur » pour la personne qui a lancé la commande ou cliqué, et
 * n'existe que dans une interaction : refusé dans une tâche planifiée ou un événement. Seuls les réglages
 * par serveur se modifient ; les fonctionnalités et les textes sont ceux du bot entier.
 */
import {
  commandInfo,
  commandList,
  moduleCount,
  moduleFeature,
  moduleInfo,
  moduleList,
  moduleSetting,
  settingVariable,
  validateModuleSettingWrite,
  type ModuleQueryDoc,
  type QueryCommand,
} from '../modules/module-query.js';

export interface BcModulesContext {
  config?: { modules?: Record<string, unknown>; translations?: unknown; commands?: unknown[] };
  interaction?: unknown;
  guild?: unknown;
  db?: unknown;
}

export interface BcModule {
  /** Identifiants (ou noms, `format: 'name'`) des modules installés. `filter` : all, enabled, configurable. */
  list(options?: { filter?: string; format?: 'id' | 'name' }): string[];
  count(filter?: string): number;
  /** `installed`, `enabled` : booléen ; `commands`, `features`, `settings` : tableau ; `name`, `version` : texte. */
  info(id: string, field?: string): string | boolean | string[];
  /** `enabled` : booléen ; `requires` : tableau ; `name` : texte. */
  feature(id: string, feature: string, field?: string): string | boolean | string[];
  /** Réglage du serveur courant (ou de `guildId`). `value` rend un nombre, un booléen ou un texte selon le type. */
  setting(id: string, key: string, field?: string, guildId?: string): Promise<string | number | boolean | string[]>;
  /** Écrit un réglage du serveur courant (valeur validée par le manifeste). Exige « Gérer le serveur ». */
  setSetting(id: string, key: string, value: unknown): Promise<void>;
}

export interface BcCommand {
  /** Noms des commandes. `filter` : slash (défaut), all, custom, module:<id>. */
  list(options?: { filter?: string }): string[];
  /** `exists` : booléen ; `subcommands`, `options`, `usage` : tableau ; `name`, `description`, `type`, `module` : texte. */
  info(name: string, field?: string): string | boolean | string[];
}

const SEP = '\u001f';
const split = (text: string): string[] => (text === '' ? [] : text.split(SEP));
const asRec = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;
const text = (v: unknown): string => (v === undefined || v === null ? '' : String(v));

export function createBcModules(context: BcModulesContext): { module: BcModule; command: BcCommand } {
  const doc = (): ModuleQueryDoc => ({
    modules: context.config?.modules ?? {},
    translations: asRec(context.config?.translations),
  });
  const commands = (): QueryCommand[] => (context.config?.commands ?? []).filter((c): c is QueryCommand => asRec(c) !== undefined);
  const locale = (): string => {
    const i = asRec(context.interaction);
    return text(i?.locale) || text(i?.guildLocale);
  };
  const guildOf = (): string => text(asRec(context.interaction)?.guildId ?? asRec(context.guild)?.id);

  const LIST_FIELDS = new Set(['commands', 'features', 'settings', 'requires', 'subcommands', 'options', 'usage', 'choices']);
  const BOOL_FIELDS = new Set(['installed', 'enabled', 'exists', 'set']);
  const typed = (field: string, value: string): string | boolean | string[] =>
    LIST_FIELDS.has(field) ? split(value) : BOOL_FIELDS.has(field) ? value === 'true' : value;

  const mod: BcModule = {
    list: (options) =>
      split(moduleList(doc(), { separator: SEP, filter: options?.filter, format: options?.format, locale: locale() })),
    count: (filter) => Number(moduleCount(doc(), filter)),
    info: (id, field = 'name') => {
      const f = text(field).trim().toLowerCase() || 'name';
      return typed(f, moduleInfo(doc(), text(id), f, { separator: SEP, locale: locale() }));
    },
    feature: (id, feature, field = 'enabled') => {
      const f = text(field).trim().toLowerCase() || 'enabled';
      return typed(f, moduleFeature(doc(), text(id), text(feature), f, { separator: SEP, locale: locale() }));
    },
    setting: async (id, key, field = 'value', guildId) => {
      const f = text(field).trim().toLowerCase() || 'value';
      const gid = text(guildId) || guildOf();
      const read = async (variable: string): Promise<string | undefined> => {
        if (!/^[0-9]+$/.test(gid)) throw new Error('Module settings need a server.');
        const db = asRec(context.db)?.guild as { get(key: string, id?: string): Promise<unknown> } | undefined;
        if (!db) throw new Error('The bot has no storage available.');
        const v = await db.get(variable, gid);
        return v === undefined || v === null ? undefined : String(v);
      };
      const out = await moduleSetting(doc(), text(id), text(key), f, read, { separator: SEP, locale: locale() });
      if (f === 'value' || f === 'default' || f === 'min' || f === 'max') {
        if (f === 'min' || f === 'max') return out === '' ? out : Number(out);
        const type = await moduleSetting(doc(), text(id), text(key), 'type', read);
        if (type === 'number' && out !== '') return Number(out);
        if (type === 'toggle' && out !== '') return out === 'true';
        return out;
      }
      return typed(f, out);
    },
    setSetting: async (id, key, value) => {
      const i = asRec(context.interaction);
      const user = text(asRec(i?.user)?.id);
      if (!i || !/^[0-9]+$/.test(user)) {
        throw new Error('Module settings can only be changed from a command or a button used by a person.');
      }
      const gid = guildOf();
      if (!/^[0-9]+$/.test(gid)) throw new Error('Module settings need a server.');
      const perms = asRec(i.memberPermissions) as { has?: (p: string) => boolean } | undefined;
      if (typeof perms?.has !== 'function' || !perms.has('ManageGuild')) {
        throw new Error('You need the Manage Server permission to change module settings.');
      }
      const write = validateModuleSettingWrite(doc(), text(id), text(key), text(value));
      const db = asRec(context.db)?.guild as { set(key: string, value: unknown, id?: string): Promise<void> } | undefined;
      if (!db) throw new Error('The bot has no storage available.');
      await db.set(write.variable, write.value, gid);
    },
  };

  const cmd: BcCommand = {
    list: (options) => split(commandList(commands(), doc(), { separator: SEP, filter: options?.filter })),
    info: (name, field = 'description') => {
      const f = text(field).trim().toLowerCase() || 'description';
      return typed(f, commandInfo(commands(), doc(), text(name), f, { separator: SEP, locale: locale() }));
    },
  };
  return { module: mod, command: cmd };
}

export { settingVariable };
