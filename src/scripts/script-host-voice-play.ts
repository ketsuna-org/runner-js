export function assertValidAudioResourceForPlay(resource: unknown): void {
  if (resource == null || typeof resource !== 'object') {
    throw new Error(
      'player.play(): expected an AudioResource — await createAudioResource() before calling play().',
    );
  }

  const record = resource as Record<string, unknown>;
  if (typeof record.playStream !== 'object' || record.playStream == null) {
    throw new Error(
      'player.play(): expected an AudioResource — await createAudioResource() before calling play().',
    );
  }
}
