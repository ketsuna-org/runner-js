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

  it('destroys tracked streams on dispose', () => {
    const destroy = vi.fn();
    const session = createVoiceSessionCleanup();
    session.trackStream({ destroy });

    session.dispose();

    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
