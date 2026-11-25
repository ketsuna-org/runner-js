import { describe, expect, test } from 'bun:test';
import { createBcBackup } from '../src/scripts/script-bc-backup.js';

const bits = (n: number) => ({ bitfield: BigInt(n) });

function fakeClient() {
  const created: { roles: unknown[]; channels: unknown[] } = { roles: [], channels: [] };
  const roles = new Map<string, unknown>([
    ['10', { id: '10', name: '@everyone', permissions: bits(1024), managed: false }],
    ['20', { id: '20', name: 'Modo', color: 255, hoist: true, mentionable: false, permissions: bits(8), position: 2, managed: false }],
  ]);
  const channels = new Map<string, unknown>([
    ['1', { id: '1', name: 'Infos', type: 4, parentId: null, rawPosition: 0, permissionOverwrites: { cache: new Map() } }],
    ['2', { id: '2', name: 'general', type: 0, parentId: '1', rawPosition: 0, topic: 'Hello', permissionOverwrites: { cache: new Map([['20', { id: '20', type: 0, allow: bits(1024), deny: bits(0) }]]) } }],
  ]);
  const guild = {
    id: '10',
    name: 'Test',
    roles: { fetch: async () => roles, create: async (o: unknown) => (created.roles.push(o), { id: '99' }) },
    channels: { fetch: async () => channels, create: async (o: unknown) => (created.channels.push(o), { id: '98' }) },
  };
  return { created, client: { guilds: { fetch: async () => guild } } };
}

describe('bc.backup', () => {
  test('snapshot keeps roles, categories, channels and overwrites', async () => {
    const { client } = fakeClient();
    const snap = JSON.parse(await createBcBackup(() => client, () => '10').snapshot());
    expect(snap.v).toBe(1);
    expect(snap.roles.map((r: { name: string }) => r.name)).toEqual(['Modo']);
    expect(snap.channels.map((c: { name: string; type: string }) => `${c.type}:${c.name}`)).toEqual(['category:Infos', 'text:general']);
    expect(snap.channels[1].overwrites[0]).toEqual({ id: '20', member: false, allow: 1024, deny: 0 });
  });

  test('restore only recreates what is missing', async () => {
    const { client, created } = fakeClient();
    const backup = createBcBackup(() => client, () => '10');
    const snap = JSON.parse(await backup.snapshot());
    snap.roles.push({ id: '30', name: 'VIP', color: 0, hoist: false, mentionable: false, permissions: 0, position: 1 });
    snap.channels.push({ id: '3', name: 'annonces', type: 'text', parent: '1', position: 1, overwrites: [{ id: '30', member: false, allow: 1024, deny: 0 }] });
    const dry = await backup.restore(JSON.stringify(snap));
    expect(dry).toMatchObject({ dryRun: true, createdRoles: ['VIP'], createdChannels: ['annonces'], skippedRoles: 1, skippedChannels: 2 });
    expect(created.roles.length + created.channels.length).toBe(0);
    const real = await backup.restore(JSON.stringify(snap), { dryRun: false });
    expect(real.createdChannels).toEqual(['annonces']);
    expect((created.channels[0] as { parent: string; permissionOverwrites: { id: string }[] }).parent).toBe('1');
    expect((created.channels[0] as { permissionOverwrites: { id: string }[] }).permissionOverwrites[0]!.id).toBe('99');
  });
});
