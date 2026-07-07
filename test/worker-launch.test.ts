import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  isPkgRuntime,
  resolveWorkerLaunch,
  shouldSpawnWorkerProcess,
} from '../src/runtime/worker-launch.js';

describe('worker-launch', () => {
  it('resolves container worker entry to index.js, not bot-worker.js', () => {
    const launch = resolveWorkerLaunch();
    expect(path.basename(launch.executable)).toBe('index.js');
    expect(launch.executable).not.toContain('bot-worker.js');
    expect(launch.args).toEqual([]);
  });

  it('uses fork for node container runtime', () => {
    const launch = resolveWorkerLaunch();
    if (!isPkgRuntime()) {
      expect(shouldSpawnWorkerProcess(launch)).toBe(false);
    }
  });
});
