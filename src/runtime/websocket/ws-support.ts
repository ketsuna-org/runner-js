/** Erreur d'une opération WebSocket, avec un code stable (`ws_*`) rendu tel quel aux scripts. */
export class WsException extends Error {
  constructor(
    readonly code: string,
    readonly detail = '',
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'WsException';
  }
}

/** Ce que les scripts (`bc.ws.join/send/close/status`) appellent. */
export interface WebSocketBridge {
  join(source: string, context?: string): Promise<void>;
  send(source: string, message: string): Promise<void>;
  close(source: string): Promise<void>;
  /** `closed`, `connecting`, `open` ou `error`. */
  status(source: string): string;
}

/** Seau de jetons : `perMinute` jetons par minute, rechargés en continu, capacité = `perMinute`. */
export class WsTokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    readonly perMinute: number,
    private readonly clock: () => number = Date.now,
  ) {
    this.tokens = perMinute;
    this.last = clock();
  }

  take(): boolean {
    const now = this.clock();
    const elapsed = now - this.last;
    this.last = now;
    if (elapsed > 0) {
      this.tokens = Math.min(this.perMinute, this.tokens + (elapsed * this.perMinute) / 60000);
    }
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

/** Attente avant une reconnexion : 1 s, 2, 4… plafonnée à 60 s, avec ±20 % de gigue. */
export function wsReconnectDelay(attempt: number, random: () => number = Math.random): number {
  const n = attempt < 1 ? 1 : attempt;
  const base = Math.min(60000, 1000 * 2 ** Math.min(n - 1, 10));
  const jitter = random() * 0.4 - 0.2;
  return Math.round(base * (1 + jitter));
}
