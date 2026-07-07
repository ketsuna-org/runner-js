type VoiceConnectionLike = {
  destroy: () => void;
};

type AudioPlayerLike = {
  state: { status: unknown };
  stop: () => void;
  once: (event: string, listener: () => void) => void;
};

type DestroyableStream = {
  destroy: () => void;
};

export interface VoiceSessionCleanup {
  trackConnection(connection: VoiceConnectionLike): void;
  trackPlayer(player: AudioPlayerLike): void;
  trackStream(stream: DestroyableStream): void;
  dispose(): void;
}

const PLAYING_STATUS = 'playing';

export function createVoiceSessionCleanup(): VoiceSessionCleanup {
  const connections = new Set<VoiceConnectionLike>();
  const players = new Set<AudioPlayerLike>();
  const streams = new Set<DestroyableStream>();

  return {
    trackConnection(connection) {
      connections.add(connection);
    },
    trackPlayer(player) {
      players.add(player);
    },
    trackStream(stream) {
      streams.add(stream);
    },
    dispose() {
      for (const stream of streams) {
        try {
          stream.destroy();
        } catch {
          // Ignore stream cleanup errors.
        }
      }
      streams.clear();

      const connectionsToDestroy = [...connections];
      const playersToStop = [...players];
      const playingPlayers = playersToStop.filter(
        (player) => player.state?.status === PLAYING_STATUS,
      );

      for (const player of playersToStop) {
        if (player.state?.status === PLAYING_STATUS) {
          continue;
        }
        try {
          player.stop();
        } catch {
          // Ignore player cleanup errors.
        }
      }

      if (playingPlayers.length === 0) {
        for (const connection of connectionsToDestroy) {
          try {
            connection.destroy();
          } catch {
            // Ignore connection cleanup errors.
          }
        }
        players.clear();
        connections.clear();
        return;
      }

      let idleCallbacks = playingPlayers.length;
      const destroyConnections = () => {
        idleCallbacks -= 1;
        if (idleCallbacks > 0) {
          return;
        }
        for (const connection of connectionsToDestroy) {
          try {
            connection.destroy();
          } catch {
            // Ignore connection cleanup errors.
          }
        }
        players.clear();
        connections.clear();
      };

      for (const player of playingPlayers) {
        player.once('idle', destroyConnections);
      }
    },
  };
}
