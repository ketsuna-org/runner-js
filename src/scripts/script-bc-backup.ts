/** `bc.backup` : sauvegarde de la structure d'un serveur (rôles, catégories, salons, permissions). Même format que
 * `$serverSnapshot` / `$serverRestore` du moteur BDFD. Ni messages, ni membres. La restauration ne supprime ni ne
 * modifie jamais rien : elle recrée ce qui manque. */

export interface BackupResult {
  dryRun: boolean;
  createdRoles: string[];
  createdChannels: string[];
  skippedRoles: number;
  skippedChannels: number;
  failed: { kind: 'role' | 'channel'; name: string; error: string }[];
}

export interface BcBackup {
  /** Structure du serveur (par défaut celui du script) en JSON, version 1. */
  snapshot(guildId?: string): Promise<string>;
  /** Recrée ce qui manque. `dryRun` (par défaut vrai) liste sans rien créer. */
  restore(json: string, options?: { dryRun?: boolean; guildId?: string }): Promise<BackupResult>;
}

const TYPE_NAMES: Record<number, string> = { 0: 'text', 2: 'voice', 4: 'category', 5: 'announcement', 13: 'stage', 15: 'forum' };
const TYPE_IDS: Record<string, number> = { text: 0, voice: 2, category: 4, announcement: 5, stage: 13, forum: 15 };

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

interface SnapRole { id: string; name: string; color: number; hoist: boolean; mentionable: boolean; permissions: number | string; position: number }
interface SnapOverwrite { id: string; member: boolean; allow: number | string; deny: number | string }
interface SnapChannel { id: string; name: string; type: string; parent: string | null; position: number; topic?: string; nsfw?: boolean; slowmode?: number; overwrites: SnapOverwrite[] }
interface Snap { v: number; name: string; everyone: number | string | null; roles: SnapRole[]; channels: SnapChannel[] }

const short = (e: unknown): string => String((e as Error)?.message ?? e).replace(/\n/g, ' ').slice(0, 160);

export function createBcBackup(getClient: () => unknown, defaultGuild: () => string): BcBackup {
  async function guildOf(id?: string): Promise<Any> {
    const gid = String(id ?? defaultGuild()).trim();
    if (!/^[0-9]+$/.test(gid)) throw new Error('Invalid guild ID.');
    return (getClient() as Any).guilds.fetch(gid);
  }
  return {
    async snapshot(guildId) {
      const guild = await guildOf(guildId);
      const roles = await guild.roles.fetch();
      const channels = await guild.channels.fetch();
      const snap: Snap = {
        v: 1,
        name: String(guild.name),
        everyone: (() => {
          const r = roles.get(guild.id);
          return r ? Number(r.permissions.bitfield) : null;
        })(),
        roles: [...roles.values()]
          .filter((r: Any) => !r.managed && r.id !== guild.id)
          .map((r: Any) => ({ id: r.id, name: r.name, color: r.color, hoist: r.hoist, mentionable: r.mentionable, permissions: Number(r.permissions.bitfield), position: r.position })),
        channels: [...channels.values()]
          .filter((c: Any) => c && TYPE_NAMES[c.type] !== undefined)
          .map((c: Any) => ({
            id: c.id,
            name: c.name,
            type: TYPE_NAMES[c.type]!,
            parent: c.parentId ?? null,
            position: c.rawPosition ?? c.position ?? 0,
            ...(c.topic ? { topic: String(c.topic) } : {}),
            ...(c.nsfw ? { nsfw: true } : {}),
            ...(c.rateLimitPerUser ? { slowmode: Number(c.rateLimitPerUser) } : {}),
            overwrites: [...(c.permissionOverwrites?.cache?.values() ?? [])].map((o: Any) => ({ id: o.id, member: o.type === 1, allow: Number(o.allow.bitfield), deny: Number(o.deny.bitfield) })),
          })),
      };
      return JSON.stringify(snap);
    },

    async restore(json, options = {}) {
      const snap = JSON.parse(json) as Snap;
      if (!snap || snap.v !== 1) throw new Error('Unsupported backup format.');
      const dryRun = options.dryRun !== false;
      const guild = await guildOf(options.guildId);
      const liveRoles = await guild.roles.fetch();
      const liveChannels = await guild.channels.fetch();
      const result: BackupResult = { dryRun, createdRoles: [], createdChannels: [], skippedRoles: 0, skippedChannels: 0, failed: [] };

      const rolePositions: { role: string; position: number }[] = [];
      const channelPositions: { channel: string; position: number }[] = [];
      const roleMap = new Map<string, string>([[guild.id, guild.id]]);
      const roleByName = new Map<string, string>([...liveRoles.values()].map((r: Any) => [String(r.name).toLowerCase(), String(r.id)]));
      for (const r of snap.roles) {
        const existing = roleByName.get(r.name.toLowerCase());
        if (existing) {
          roleMap.set(r.id, existing);
          result.skippedRoles++;
          continue;
        }
        result.createdRoles.push(r.name);
        if (dryRun) continue;
        try {
          const created = await guild.roles.create({ name: r.name, color: r.color, hoist: r.hoist, mentionable: r.mentionable, permissions: BigInt(r.permissions), reason: 'Backup restore' });
          roleMap.set(r.id, String(created.id));
          rolePositions.push({ role: String(created.id), position: Number(r.position) || 0 });
        } catch (e) {
          result.createdRoles.splice(result.createdRoles.indexOf(r.name), 1);
          result.failed.push({ kind: 'role', name: r.name, error: short(e) });
        }
      }

      const savedCategoryName = new Map(snap.channels.filter((c) => c.type === 'category').map((c) => [c.id, c.name.toLowerCase()]));
      const liveName = new Map<string, string>([...liveChannels.values()].filter(Boolean).map((c: Any) => [String(c.id), String(c.name).toLowerCase()]));
      const liveKeys = new Map<string, string>();
      const liveCategoryByName = new Map<string, string>();
      for (const c of [...liveChannels.values()].filter(Boolean) as Any[]) {
        const type = TYPE_NAMES[c.type];
        if (!type) continue;
        liveKeys.set(`${type}|${String(c.name).toLowerCase()}|${c.parentId ? liveName.get(String(c.parentId)) ?? '' : ''}`, String(c.id));
        if (type === 'category') liveCategoryByName.set(String(c.name).toLowerCase(), String(c.id));
      }

      const ordered = [...snap.channels].sort((a, b) => (a.type === 'category' ? 0 : 1) - (b.type === 'category' ? 0 : 1) || (a.position ?? 0) - (b.position ?? 0));
      const newCategory = new Map<string, string>();
      for (const c of ordered) {
        const parentName = c.parent ? savedCategoryName.get(c.parent) ?? '' : '';
        const existing = liveKeys.get(`${c.type}|${c.name.toLowerCase()}|${parentName}`);
        if (existing) {
          if (c.type === 'category') newCategory.set(c.id, existing);
          result.skippedChannels++;
          continue;
        }
        result.createdChannels.push(c.name);
        if (dryRun) continue;
        try {
          const parent = c.type === 'category' || !c.parent ? undefined : newCategory.get(c.parent) ?? liveCategoryByName.get(parentName);
          const permissionOverwrites = c.overwrites
            .map((o) => ({ id: o.member ? o.id : roleMap.get(o.id), type: o.member ? 1 : 0, allow: BigInt(o.allow), deny: BigInt(o.deny) }))
            .filter((o) => o.id);
          const created = await guild.channels.create({
            name: c.name,
            type: TYPE_IDS[c.type],
            ...(parent ? { parent } : {}),
            ...(c.topic ? { topic: c.topic } : {}),
            ...(c.nsfw && c.type !== 'category' ? { nsfw: true } : {}),
            ...(c.slowmode ? { rateLimitPerUser: c.slowmode } : {}),
            permissionOverwrites,
            reason: 'Backup restore',
          });
          if (c.type === 'category') newCategory.set(c.id, String(created.id));
          channelPositions.push({ channel: String(created.id), position: Number(c.position) || 0 });
        } catch (e) {
          result.createdChannels.splice(result.createdChannels.indexOf(c.name), 1);
          result.failed.push({ kind: 'channel', name: c.name, error: short(e) });
        }
      }
      if (!dryRun) {
        // Remet l'ordre d'origine : seuls les éléments créés par la restauration sont déplacés.
        try { await guild.roles.setPositions(rolePositions.sort((a, b) => a.position - b.position)); } catch { /* au-dessus du rôle du bot */ }
        try { await guild.channels.setPositions(channelPositions.sort((a, b) => a.position - b.position)); } catch { /* refus de Discord */ }
      }
      return result;
    },
  };
}
