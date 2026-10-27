export type LoopMode = 'off' | 'track' | 'queue';

export const LOOP_MODES: readonly LoopMode[] = ['off', 'track', 'queue'];

/** Plafond de la file d'attente d'un serveur : une playlist géante ne doit pas occuper la mémoire du nœud. */
export const MAX_QUEUE_LENGTH = 500;

export interface QueueTrack {
  /** Piste encodée Lavalink (jamais exposée aux scripts). */
  encoded: string;
  identifier: string;
  title: string;
  author: string;
  url: string | null;
  durationMs: number;
  isStream: boolean;
  thumbnail: string | null;
  source: string;
  requestedBy: string | null;
}

/** File d'attente d'un serveur : la logique pure (boucle, ordre), sans Discord ni Lavalink. */
export class TrackQueue {
  current: QueueTrack | null = null;
  upcoming: QueueTrack[] = [];
  loop: LoopMode = 'off';

  /** Ajoute des pistes (en tête avec `next`) dans la limite de `MAX_QUEUE_LENGTH` ; renvoie le nombre ajouté. */
  add(tracks: QueueTrack[], options: { next?: boolean } = {}): number {
    const room = Math.max(0, MAX_QUEUE_LENGTH - this.upcoming.length);
    const accepted = tracks.slice(0, room);
    if (options.next) {
      this.upcoming.unshift(...accepted);
    } else {
      this.upcoming.push(...accepted);
    }
    return accepted.length;
  }

  /**
   * Passe à la piste suivante et la renvoie (`null` si la file est vide). `finished` respecte la boucle ;
   * `skip` abandonne la piste courante même en boucle « track ».
   */
  advance(reason: 'finished' | 'skip'): QueueTrack | null {
    const previous = this.current;
    if (previous && reason === 'finished' && this.loop === 'track') {
      return previous;
    }
    if (previous && this.loop === 'queue') {
      this.upcoming.push(previous);
    }
    this.current = this.upcoming.shift() ?? null;
    return this.current;
  }

  /** Retire la piste `position` (à partir de 1) des pistes à venir. */
  remove(position: number): QueueTrack | null {
    if (!Number.isInteger(position) || position < 1 || position > this.upcoming.length) {
      return null;
    }
    return this.upcoming.splice(position - 1, 1)[0] ?? null;
  }

  clear(): number {
    const count = this.upcoming.length;
    this.upcoming = [];
    return count;
  }

  shuffle(random: () => number = Math.random): void {
    for (let i = this.upcoming.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [this.upcoming[i], this.upcoming[j]] = [this.upcoming[j]!, this.upcoming[i]!];
    }
  }
}

export function isLoopMode(value: unknown): value is LoopMode {
  return typeof value === 'string' && (LOOP_MODES as readonly string[]).includes(value);
}
