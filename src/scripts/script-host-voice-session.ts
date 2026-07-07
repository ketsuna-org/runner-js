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
  markPlayerPlayed(player: AudioPlayerLike): void;
  dispose(): void;
}

const ACTIVE_PLAYER_STATUSES = new Set([
  'playing',
  'buffering',
  'paused',
  'autopaused',
]);

function shouldKeepPlaybackAlive(
  player: AudioPlayerLike,
  playedPlayers: Set<AudioPlayerLike>,
): boolean {
  const status = String(player.state?.status ?? '');
  return ACTIVE_PLAYER_STATUSES.has(status) || playedPlayers.has(player);
}

export function createVoiceSessionCleanup(): VoiceSessionCleanup {
  const connections = new Set<VoiceConnectionLike>();
  const players = new Set<AudioPlayerLike>();
  const streams = new Set<DestroyableStream>();
  const playedPlayers = new Set<AudioPlayerLike>();

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
    markPlayerPlayed(player) {
      playedPlayers.add(player);
    },
    dispose() {
      const connectionsToDestroy = [...connections];
      const playersToStop = [...players];
      const streamsToDestroy = [...streams];
      const keepAlivePlayers = playersToStop.filter((player) =>
        shouldKeepPlaybackAlive(player, playedPlayers),
      );

      streams.clear();

      for (const player of playersToStop) {
        if (keepAlivePlayers.includes(player)) {
          continue;
        }
        try {
          player.stop();
        } catch {
          // Ignore player cleanup errors.
        }
      }

      const destroyStreams = () => {
        for (const stream of streamsToDestroy) {
          try {
            stream.destroy();
          } catch {
            // Ignore stream cleanup errors.
          }
        }
      };

      if (keepAlivePlayers.length === 0) {
        destroyStreams();
        for (const connection of connectionsToDestroy) {
          try {
            connection.destroy();
          } catch {
            // Ignore connection cleanup errors.
          }
        }
        players.clear();
        playedPlayers.clear();
        connections.clear();
        return;
      }

      let idleCallbacks = keepAlivePlayers.length;
      const destroyConnections = () => {
        idleCallbacks -= 1;
        if (idleCallbacks > 0) {
          return;
        }
        destroyStreams();
        for (const connection of connectionsToDestroy) {
          try {
            connection.destroy();
          } catch {
            // Ignore connection cleanup errors.
          }
        }
        players.clear();
        playedPlayers.clear();
        connections.clear();
      };

      for (const player of keepAlivePlayers) {
        if (typeof player.once === 'function') {
          player.once('idle', destroyConnections);
        } else {
          destroyConnections();
        }
      }
    },
  };
}
