import { describe, expect, test } from 'bun:test';
import { AlertError, type GuildAlertsApi } from '../src/runtime/alerts/guild-alerts-api.js';
import { createBcAlert } from '../src/scripts/script-bc-alert.js';

function setup(options: { manage?: boolean; noApi?: boolean; guild?: string } = {}) {
  const calls: unknown[][] = [];
  const stored = [
    { id: 'a1', name: 'Live', source_kind: 'twitch', source: { login: 'garder' }, channel_id: '111', action: 'both', status: 'active', last_error: '' },
    { id: 'a2', name: 'Blog', source_kind: 'rss', source: { url: 'https://x.test/feed' }, channel_id: '222', action: 'workflow', status: 'paused', last_error: 'boom' },
  ];
  const api: GuildAlertsApi = {
    list: async (g) => (calls.push(['list', g]), { automations: stored, view: {} }),
    create: async (b) => (calls.push(['create', b]), 'new1'),
    setStatus: async (g, id, enable) => void calls.push(['status', g, id, enable]),
    remove: async (g, id) => void calls.push(['remove', g, id]),
  };
  const member = { permissions: { has: (p: string) => options.manage !== false && p === 'ManageGuild' } };
  const client = { guilds: { fetch: async () => ({ members: { fetch: async () => member } }) } };
  const alert = createBcAlert({
    botId: () => 'bot-1',
    guildId: () => options.guild ?? '999',
    userId: () => '42',
    getClient: () => client,
    apiFor: () => (options.noApi ? null : api),
  });
  return { alert, calls };
}

describe('bc.alert', () => {
  test('create makes the alert, starts it and returns its id', async () => {
    const { alert, calls } = setup();
    const id = await alert.create({ source: 'Twitch', value: ' garder ', channelId: '<#123>', action: 'both' });
    expect(id).toBe('new1');
    expect(calls[0]).toEqual([
      'create',
      { guild_id: '999', actor_id: '42', name: 'twitch · garder', source_kind: 'twitch', source: { login: 'garder' }, channel_id: '123', action: 'both' },
    ]);
    expect(calls[1]).toEqual(['status', '999', 'new1', true]);
  });

  test('writes need Manage Server', async () => {
    const { alert, calls } = setup({ manage: false });
    await expect(alert.pause('a1')).rejects.toThrow('alert_forbidden: Manage Server permission is required.');
    await expect(alert.create({ source: 'rss', value: 'https://x', channelId: '1' })).rejects.toThrow('alert_forbidden');
    expect(calls).toEqual([]);
  });

  test('pause, resume and delete reach the Manager', async () => {
    const { alert, calls } = setup();
    await alert.pause('a1');
    await alert.resume('a1');
    await alert.delete('a2');
    expect(calls).toEqual([['status', '999', 'a1', false], ['status', '999', 'a1', true], ['remove', '999', 'a2']]);
  });

  test('count, list and info read the server alerts', async () => {
    const { alert } = setup({ manage: false });
    expect(await alert.count()).toBe(2);
    expect(await alert.count({ activeOnly: true })).toBe(1);
    expect((await alert.list()).map((a) => a.name)).toEqual(['Live', 'Blog']);
    expect(await alert.info('a2')).toEqual({
      id: 'a2', name: 'Blog', source: 'https://x.test/feed', kind: 'rss', channelId: '222', action: 'workflow', status: 'paused', lastError: 'boom',
    });
    await expect(alert.info('nope')).rejects.toThrow('alert_not_found');
  });

  test('bad input and missing pieces say what is wrong', async () => {
    await expect(setup().alert.create({ source: 'mastodon', value: 'x', channelId: '1' })).rejects.toThrow('Unknown alert source');
    await expect(setup().alert.create({ source: 'rss', value: 'x', channelId: 'abc' })).rejects.toThrow('Invalid channel ID');
    await expect(setup().alert.create({ source: 'rss', value: 'x', channelId: '1', action: 'x' })).rejects.toThrow('Unknown alert action');
    await expect(setup({ noApi: true }).alert.count()).rejects.toThrow('alert_unavailable');
    await expect(setup({ guild: '' }).alert.count()).rejects.toThrow('alert_guild_required');
    const error = await setup({ noApi: true }).alert.count().catch((e) => e);
    expect(error).toBeInstanceOf(AlertError);
  });
});
