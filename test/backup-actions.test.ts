import { describe, expect, test } from 'bun:test';

import { BackupActionError, cleanBackupLabel, createBackupFile, restoreBackupFile } from '../src/scripts/backup-actions.js';
import { FilesGatewayError, type FilesGateway } from '../src/files/files-gateway.js';

function fakeGateway() {
  const store = new Map<string, Uint8Array>();
  const gateway: FilesGateway = {
    async put(_bot, path, data) {
      store.set(path, data);
      return { path, size: data.length, contentType: 'application/json', updatedAt: '' };
    },
    async get(_bot, path) {
      const data = store.get(path);
      if (!data) throw new FilesGatewayError('file_not_found');
      return { data, contentType: 'application/json' };
    },
    async list(_bot, prefix) {
      return [...store.keys()].filter((p) => p.startsWith(prefix)).map((path) => ({ path, size: 1, contentType: '', updatedAt: '' }));
    },
    async delete() {
      return true;
    },
    async exists() {
      return false;
    },
    async url() {
      return '';
    },
  };
  return { gateway, store };
}

const guildFetch = (created: string[]) => ({
  guilds: {
    fetch: async () => ({
      id: '111111111111',
      name: 'Test server',
      roles: {
        fetch: async () => new Map([['111111111111', { id: '111111111111', permissions: { bitfield: 0n } }]]),
      },
      channels: {
        fetch: async () => new Map(),
        create: async (o: { name: string }) => {
          created.push(o.name);
          return { id: '9' };
        },
      },
    }),
  },
});

describe('backup actions', () => {
  test('cleans labels', () => {
    expect(cleanBackupLabel('  Avant\n la\trefonte ')).toBe('Avant la refonte');
    expect(cleanBackupLabel('é'.repeat(200)).length).toBe(80);
  });

  test('creates a file with label and auto, then restores it as a preview', async () => {
    const { gateway, store } = fakeGateway();
    const created: string[] = [];
    const out = await createBackupFile(guildFetch(created), gateway, 'bot1', { guild: '111111111111', label: 'Avant', auto: true });
    expect(out.path).toMatch(/^backups\/111111111111\/\d+\.json$/);
    const saved = JSON.parse(new TextDecoder().decode(store.get(out.path)!));
    expect(saved.v).toBe(1);
    expect(saved.label).toBe('Avant');
    expect(saved.auto).toBe(true);
    const preview = await restoreBackupFile(guildFetch(created), gateway, 'bot1', { guild: '111111111111', backupId: out.id });
    expect(preview.dryRun).toBe(true);
    expect(created).toEqual([]);
  });

  test('rejects bad ids and missing backups', async () => {
    const { gateway } = fakeGateway();
    await expect(createBackupFile({}, gateway, 'b', { guild: 'x' })).rejects.toBeInstanceOf(BackupActionError);
    await expect(restoreBackupFile({}, gateway, 'b', { guild: '111111111111', backupId: '12' })).rejects.toBeInstanceOf(BackupActionError);
    await expect(restoreBackupFile({}, gateway, 'b', { guild: '111111111111', backupId: '1234567890123' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(createBackupFile({}, null, 'b', { guild: '111111111111' })).rejects.toMatchObject({ code: 'unavailable' });
  });
});
