import { createBcBackup, type BackupResult } from './script-bc-backup.js';
import { FilesGatewayError, type FilesGateway } from '../files/files-gateway.js';

/**
 * Actions « sauvegarde » déclenchées par le Manager (écrans de l'app et du Studio) : même format de fichier que le
 * module Sauvegarde du serveur (`backups/<serveur>/<horodatage ms>.json` dans les fichiers du bot), avec en plus les
 * clés facultatives `label` (nom donné par le propriétaire) et `auto` (sauvegarde automatique).
 */

const GUILD_RE = /^[0-9]{5,25}$/;
const ID_RE = /^[0-9]{10,16}$/;
export const BACKUP_MAX_LABEL = 80;
export const BACKUP_MAX_PER_GUILD = 100;

export class BackupActionError extends Error {
  constructor(
    readonly code: 'invalid' | 'not_found' | 'unavailable' | 'quota' | 'too_many' | 'bad_format',
    message: string,
  ) {
    super(message);
    this.name = 'BackupActionError';
  }
}

export function cleanBackupLabel(raw: unknown): string {
  // eslint-disable-next-line no-control-regex
  const text = String(raw ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').split(/\s+/).filter(Boolean).join(' ');
  return [...text].slice(0, BACKUP_MAX_LABEL).join('');
}

function gatewayOf(gateway: FilesGateway | null): FilesGateway {
  if (!gateway) throw new BackupActionError('unavailable', 'Bot files are not available on this runner.');
  return gateway;
}

function checkGuild(guild: string): void {
  if (!GUILD_RE.test(guild)) throw new BackupActionError('invalid', 'guild must be a Discord server id.');
}

export async function createBackupFile(
  client: unknown,
  gateway: FilesGateway | null,
  botId: string,
  options: { guild: string; label?: string; auto?: boolean },
): Promise<{ id: string; path: string; size: number; label: string }> {
  const files = gatewayOf(gateway);
  checkGuild(options.guild);
  const existing = await files.list(botId, `backups/${options.guild}/`, BACKUP_MAX_PER_GUILD + 1, '');
  if (existing.length >= BACKUP_MAX_PER_GUILD) {
    throw new BackupActionError('too_many', `A server keeps at most ${BACKUP_MAX_PER_GUILD} backups: delete one first.`);
  }
  const backup = createBcBackup(() => client, () => options.guild);
  const snapshot = JSON.parse(await backup.snapshot(options.guild)) as Record<string, unknown>;
  const label = cleanBackupLabel(options.label);
  if (label) snapshot.label = label;
  if (options.auto === true) snapshot.auto = true;
  const id = String(Date.now());
  const path = `backups/${options.guild}/${id}.json`;
  try {
    const info = await files.put(botId, path, new TextEncoder().encode(JSON.stringify(snapshot)), 'application/json');
    return { id, path, size: info.size, label };
  } catch (error) {
    if (error instanceof FilesGatewayError && error.code === 'file_quota_exceeded') {
      throw new BackupActionError('quota', 'The storage of the account is full.');
    }
    throw error;
  }
}

export async function restoreBackupFile(
  client: unknown,
  gateway: FilesGateway | null,
  botId: string,
  options: { guild: string; backupId: string; dryRun?: boolean },
): Promise<BackupResult> {
  const files = gatewayOf(gateway);
  checkGuild(options.guild);
  if (!ID_RE.test(options.backupId)) throw new BackupActionError('invalid', 'backupId is not valid.');
  let data: Uint8Array;
  try {
    data = (await files.get(botId, `backups/${options.guild}/${options.backupId}.json`)).data;
  } catch (error) {
    if (error instanceof FilesGatewayError && error.code === 'file_not_found') {
      throw new BackupActionError('not_found', 'Backup not found.');
    }
    throw error;
  }
  const backup = createBcBackup(() => client, () => options.guild);
  try {
    // Aperçu par défaut : seule une demande explicite `dryRun: false` crée quelque chose.
    return await backup.restore(new TextDecoder().decode(data), { dryRun: options.dryRun !== false, guildId: options.guild });
  } catch (error) {
    if (error instanceof SyntaxError || (error as Error)?.message === 'Unsupported backup format.') {
      throw new BackupActionError('bad_format', 'This backup cannot be read.');
    }
    throw error;
  }
}
