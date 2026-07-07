import { describe, expect, it, vi } from 'vitest';

import { createVoiceSessionCleanup } from '../src/scripts/script-host-voice-session.js';

describe('voice session cleanup', () => {
  it('destroys idle voice connections when the script session ends', () => {
    const destroy = vi.fn();
    const session = createVoiceSessionCleanup();
    session.trackConnection({ destroy });

    session.dispose();

    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('stops idle players and destroys their connections', () => {
    const destroy = vi.fn();
    const stop = vi.fn();
    const session = createVoiceSessionCleanup();
    session.trackConnection({ destroy });
    session.trackPlayer({
      state: { status: 'idle' },
      stop,
      once: vi.fn(),
    });

    session.dispose();

    expect(stop).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('keeps playing audio alive until the player becomes idle', () => {
    const destroy = vi.fn();
    const stop = vi.fn();
    const once = vi.fn((event: string, listener: () => void) => {
      if (event === 'idle') {
        listener();
      }
    });
    const session = createVoiceSessionCleanup();
    session.trackConnection({ destroy });
    session.trackPlayer({
      state: { status: 'playing' },
      stop,
      once,
    });

    session.dispose();

    expect(stop).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(once).toHaveBeenCalledWith('idle', expect.any(Function));
  });

  it('keeps playback alive while the player is buffering', () => {
    const destroy = vi.fn();
    const stop = vi.fn();
    const once = vi.fn();
    const session = createVoiceSessionCleanup();
    session.trackConnection({ destroy });
    const player = {
      state: { status: 'buffering' },
      stop,
      once,
    };
    session.trackPlayer(player);

    session.dispose();

    expect(stop).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect(once).toHaveBeenCalledWith('idle', expect.any(Function));
  });

  it('keeps playback alive after play() until the player becomes idle', () => {
    const destroy = vi.fn();
    const stop = vi.fn();
    const once = vi.fn();
    const session = createVoiceSessionCleanup();
    session.trackConnection({ destroy });
    const player = {
      state: { status: 'idle' },
      stop,
      once,
    };
    session.trackPlayer(player);
    session.markPlayerPlayed(player);

    session.dispose();

    expect(stop).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect(once).toHaveBeenCalledWith('idle', expect.any(Function));
  });

  it('does not destroy streams while playback is still active', () => {
    const destroy = vi.fn();
    const once = vi.fn();
    const session = createVoiceSessionCleanup();
    session.trackStream({ destroy });
    session.trackConnection({ destroy: vi.fn() });
    session.trackPlayer({
      state: { status: 'playing' },
      stop: vi.fn(),
      once,
    });

    session.dispose();

    expect(destroy).not.toHaveBeenCalled();
  });

  it('destroys tracked streams on dispose', () => {
    const destroy = vi.fn();
    const session = createVoiceSessionCleanup();
    session.trackStream({ destroy });

    session.dispose();

    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('cleans up after player errors during deferred playback teardown', () => {
    const destroy = vi.fn();
    const once = vi.fn((event: string, listener: () => void) => {
      if (event === 'error') {
        listener();
      }
    });
    const session = createVoiceSessionCleanup();
    session.trackConnection({ destroy });
    const player = {
      state: { status: 'idle' },
      stop: vi.fn(),
      once,
    };
    session.trackPlayer(player);
    session.markPlayerPlayed(player);

    session.dispose();

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(once).toHaveBeenCalledWith('error', expect.any(Function));
  });
});
