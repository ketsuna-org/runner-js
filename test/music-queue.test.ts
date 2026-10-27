import { describe, expect, it } from 'bun:test';

import { MAX_QUEUE_LENGTH, TrackQueue, isLoopMode, type QueueTrack } from '../src/runtime/music/queue.js';

function track(id: string): QueueTrack {
  return {
    encoded: `enc-${id}`,
    identifier: id,
    title: `Title ${id}`,
    author: 'Author',
    url: null,
    durationMs: 1000,
    isStream: false,
    thumbnail: null,
    source: 'test',
    requestedBy: null,
  };
}

describe('TrackQueue', () => {
  it('lit les pistes dans l ordre et se vide', () => {
    const queue = new TrackQueue();
    queue.add([track('a'), track('b')]);
    expect(queue.advance('finished')?.identifier).toBe('a');
    expect(queue.advance('finished')?.identifier).toBe('b');
    expect(queue.advance('finished')).toBeNull();
    expect(queue.current).toBeNull();
  });

  it('place une piste en tête avec next', () => {
    const queue = new TrackQueue();
    queue.add([track('a'), track('b')]);
    queue.add([track('c')], { next: true });
    expect(queue.upcoming.map((t) => t.identifier)).toEqual(['c', 'a', 'b']);
  });

  it('boucle sur la piste, sauf quand on la passe', () => {
    const queue = new TrackQueue();
    queue.loop = 'track';
    queue.add([track('a'), track('b')]);
    queue.advance('finished');
    expect(queue.advance('finished')?.identifier).toBe('a');
    expect(queue.advance('skip')?.identifier).toBe('b');
  });

  it('boucle sur la file', () => {
    const queue = new TrackQueue();
    queue.loop = 'queue';
    queue.add([track('a'), track('b')]);
    queue.advance('finished');
    expect(queue.advance('finished')?.identifier).toBe('b');
    expect(queue.advance('finished')?.identifier).toBe('a');
  });

  it('retire par rang à partir de 1 et refuse un rang invalide', () => {
    const queue = new TrackQueue();
    queue.add([track('a'), track('b'), track('c')]);
    expect(queue.remove(2)?.identifier).toBe('b');
    expect(queue.remove(0)).toBeNull();
    expect(queue.remove(5)).toBeNull();
    expect(queue.upcoming.map((t) => t.identifier)).toEqual(['a', 'c']);
  });

  it('mélange sans perdre de piste', () => {
    const queue = new TrackQueue();
    queue.add([track('a'), track('b'), track('c'), track('d')]);
    queue.shuffle(() => 0);
    expect(queue.upcoming.map((t) => t.identifier).sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('plafonne la file', () => {
    const queue = new TrackQueue();
    const many = Array.from({ length: MAX_QUEUE_LENGTH + 20 }, (_, i) => track(String(i)));
    expect(queue.add(many)).toBe(MAX_QUEUE_LENGTH);
    expect(queue.add([track('x')])).toBe(0);
  });

  it('reconnaît les modes de boucle', () => {
    expect(isLoopMode('queue')).toBe(true);
    expect(isLoopMode('all')).toBe(false);
  });
});
