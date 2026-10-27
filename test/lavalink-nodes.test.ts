import { beforeEach, describe, expect, it } from 'bun:test';

import {
  parsePublicList,
  probeNode,
  resetPublicListCache,
  selectNodes,
  type FetchLike,
} from '../src/runtime/music/lavalink-nodes.js';

const listBody = [
  { identifier: 'fast', host: 'fast.example', port: 443, password: 'pw', secure: true, version: 'v4' },
  { identifier: 'slow', host: 'slow.example', port: '2333', password: 'pw', secure: false, version: 'v4' },
  { identifier: 'old', host: 'old.example', port: 2333, password: 'pw', version: 'v3' },
  { identifier: 'dead', host: 'dead.example', port: 2333, password: 'pw', version: 'v4' },
  { host: '' },
  'junk',
];

function fakeFetch(): FetchLike {
  return async (input, init) => {
    const url = String(input);
    if (url.includes('lavalink-list')) {
      return new Response(JSON.stringify(listBody), { status: 200 });
    }
    if (url.includes('dead.example')) throw new Error('unreachable');
    if (url.includes('slow.example')) await new Promise((r) => setTimeout(r, 30));
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    return new Response('4.0.0', { status: auth === 'pw' ? 200 : 401 });
  };
}

describe('lavalink-nodes', () => {
  beforeEach(() => resetPublicListCache());

  it('ne garde que les entrées v4 valides de la liste publique', () => {
    const entries = parsePublicList(listBody);
    expect(entries.map((e) => e.host)).toEqual(['fast.example', 'slow.example', 'dead.example']);
    expect(entries[1]!.port).toBe(2333);
  });

  it('sonde avec le mot de passe et rejette une réponse en erreur', async () => {
    const fetchImpl = fakeFetch();
    expect(await probeNode({ host: 'fast.example', port: 443, password: 'pw', secure: true }, fetchImpl)).not.toBeNull();
    expect(await probeNode({ host: 'fast.example', port: 443, password: 'bad', secure: true }, fetchImpl)).toBeNull();
    expect(await probeNode({ host: 'dead.example', port: 1, password: 'pw', secure: false }, fetchImpl)).toBeNull();
  });

  it('classe les serveurs publics joignables puis ajoute les personnels en repli', async () => {
    const nodes = await selectNodes(
      [{ host: 'mine.example', port: 2333, password: 'secret', secure: false }],
      fakeFetch(),
    );
    expect(nodes.map((n) => `${n.group}:${n.host}`)).toEqual([
      'public:fast.example',
      'public:slow.example',
      'custom:mine.example',
    ]);
  });

  it('garde les serveurs personnels quand la liste publique est injoignable', async () => {
    const failing: FetchLike = async () => {
      throw new Error('offline');
    };
    const nodes = await selectNodes([{ host: 'mine.example', port: 2333, password: 'p', secure: false }], failing);
    expect(nodes.map((n) => n.host)).toEqual(['mine.example']);
  });
});
