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

/**
 * File d'attente d'un serveur : la logique pure (boucle, ordre), sans Discord ni Lavalink. Même modèle que la
 * file du runner Dart : des entrées et un curseur, `entries[cursor]` est LA piste courante. Règles communes :
 * - le skip n'est jamais bouclé : sur la dernière piste il arrête la file, même en boucle `queue` ;
 * - la fin naturelle d'une piste respecte la boucle (`track` rejoue, `queue` repart du début) ;
 * - une entrée identique à la piste courante n'est jamais choisie comme suivante (pas de relecture par skip).
 */
export class TrackQueue {
  private entries: QueueTrack[] = [];
  /** Index de la piste courante ; en attente (`idle`), index où la recherche de la suivante commence. */
  private cursor = 0;
  private idle = true;
  loop: LoopMode = 'off';

  get current(): QueueTrack | null {
    return this.idle ? null : (this.entries[this.cursor] ?? null);
  }

  /** Pistes encore à jouer, piste courante exclue. */
  get upcoming(): QueueTrack[] {
    return this.entries.slice(this.nextStart);
  }

  /** Première entrée encore à jouer : après la courante, ou là où le curseur attend si la file est épuisée. */
  private get nextStart(): number {
    return this.idle ? this.cursor : this.cursor + 1;
  }

  /** Ajoute des pistes (juste après la courante avec `next`) dans la limite de `MAX_QUEUE_LENGTH` ; renvoie le nombre ajouté. */
  add(tracks: QueueTrack[], options: { next?: boolean } = {}): number {
    const room = Math.max(0, MAX_QUEUE_LENGTH - this.upcoming.length);
    const accepted = tracks.slice(0, room);
    if (options.next) {
      this.entries.splice(this.nextStart, 0, ...accepted);
    } else {
      this.entries.push(...accepted);
    }
    return accepted.length;
  }

  /**
   * Passe à la piste suivante et la renvoie (`null` si la file est épuisée). `finished` respecte la boucle ;
   * `skip` ne la consulte jamais.
   */
  advance(reason: 'finished' | 'skip'): QueueTrack | null {
    if (reason === 'finished' && this.loop === 'track' && this.current) {
      return this.current;
    }
    const next = this.nextIndex(reason === 'finished' && this.loop === 'queue');
    if (next === null) {
      if (reason === 'finished' && this.loop === 'queue' && this.entries.length > 0) {
        // File d'une seule piste (ou seulement des doublons de la courante) : la boucle la rejoue.
        this.cursor = 0;
        this.idle = false;
        return this.current;
      }
      this.idle = true;
      this.cursor = this.entries.length;
      this.trimPlayed();
      return null;
    }
    this.idle = false;
    this.cursor = next;
    this.trimPlayed();
    return this.current;
  }

  /** Retire la piste `position` (à partir de 1) des pistes à venir. */
  remove(position: number): QueueTrack | null {
    if (!Number.isInteger(position) || position < 1 || position > this.upcoming.length) {
      return null;
    }
    return this.entries.splice(this.nextStart + position - 1, 1)[0] ?? null;
  }

  /** Vide les pistes à venir (la courante continue) ; renvoie le nombre retiré. */
  clear(): number {
    const count = this.upcoming.length;
    this.entries.length = Math.min(this.entries.length, this.nextStart);
    return count;
  }

  /** Vide tout, piste courante comprise (arrêt de la lecture). */
  reset(): void {
    this.entries = [];
    this.cursor = 0;
    this.idle = true;
  }

  shuffle(random: () => number = Math.random): void {
    const tail = this.upcoming;
    for (let i = tail.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [tail[i], tail[j]] = [tail[j]!, tail[i]!];
    }
    this.entries.splice(this.nextStart, tail.length, ...tail);
  }

  private nextIndex(allowLoop: boolean): number | null {
    const current = this.current;
    const different = (entry: QueueTrack) => !current || entry.encoded !== current.encoded;
    for (let i = this.nextStart; i < this.entries.length; i += 1) {
      if (different(this.entries[i]!)) return i;
    }
    if (!allowLoop) return null;
    for (let i = 0; i < this.entries.length; i += 1) {
      if (different(this.entries[i]!)) return i;
    }
    return null;
  }

  /** Sans boucle `queue`, les pistes déjà jouées ne servent plus : la file ne grandit pas avec la session. */
  private trimPlayed(): void {
    if (this.loop === 'queue') return;
    const drop = Math.min(this.cursor, this.entries.length);
    this.entries.splice(0, drop);
    this.cursor -= drop;
  }
}

export function isLoopMode(value: unknown): value is LoopMode {
  return typeof value === 'string' && (LOOP_MODES as readonly string[]).includes(value);
}
