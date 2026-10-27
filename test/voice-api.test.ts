import { describe, expect, it } from 'bun:test';
import type { Client, Guild } from 'discord.js';

import { parseJsBotConfig } from '../src/config/js-bot-config.js';
import { MUSIC_DISABLED_MESSAGE, MusicManager } from '../src/runtime/music/music-manager.js';
import { sanitizeConfigForScript } from '../src/scripts/script-config-sanitize.js';

const fakeClient = { on() {}, off() {}, once() {}, isReady: () => true } as unknown as Client;
const guild = { id: '1' } as unknown as Guild;

describe('configuration lavalink', () => {
  it('est éteinte par défaut', () => {
    expect(parseJsBotConfig({}).lavalink).toBeUndefined();
  });

  it('lit enabled et les serveurs personnels, écarte les entrées invalides', () => {
    const config = parseJsBotConfig({
      lavalink: {
        enabled: true,
        custom_servers: [{ host: 'a.example', port: 'x', password: 'pw', secure: true }, { port: 1 }, 'bad'],
      },
    });
    expect(config.lavalink?.enabled).toBe(true);
    expect(config.lavalink?.custom_servers).toEqual([{ host: 'a.example', port: 2333, password: 'pw', secure: true }]);
  });

  it('ne laisse pas les mots de passe Lavalink aux scripts', () => {
    const config = parseJsBotConfig({
      lavalink: { enabled: true, custom_servers: [{ host: 'a.example', password: 'topsecret' }] },
    });
    const visible = sanitizeConfigForScript(config);
    expect(JSON.stringify(visible)).not.toContain('topsecret');
    expect(visible.lavalink).toEqual({ enabled: true });
  });
});

describe('objet voice', () => {
  it('refuse proprement quand la musique est éteinte (sans Premium)', async () => {
    const manager = new MusicManager(fakeClient, () => {});
    manager.setConfig({ enabled: false, custom_servers: [] });
    const voice = manager.forContext({ guild, userId: '2' });
    expect(voice.enabled).toBe(false);
    await expect(voice.play('song')).rejects.toThrow(MUSIC_DISABLED_MESSAGE);
    await expect(voice.skip()).rejects.toThrow(MUSIC_DISABLED_MESSAGE);
    expect(() => voice.setLoopMode('track')).toThrow(MUSIC_DISABLED_MESSAGE);
  });

  it('les lectures restent sûres sans session', () => {
    const manager = new MusicManager(fakeClient, () => {});
    manager.setConfig({ enabled: true, custom_servers: [] });
    const voice = manager.forContext({ guild, userId: '2' });
    expect(voice.getQueue()).toEqual({
      connected: false,
      channelId: null,
      current: null,
      upcoming: [],
      loop: 'off',
      volume: 100,
      paused: false,
    });
    expect(voice.nowPlaying()).toBeNull();
    expect(voice.isConnected()).toBe(false);
  });

  it('exige un serveur Discord', async () => {
    const manager = new MusicManager(fakeClient, () => {});
    manager.setConfig({ enabled: true, custom_servers: [] });
    await expect(manager.forContext({ guild: null }).join('1')).rejects.toThrow('only be used in a server');
  });
});
