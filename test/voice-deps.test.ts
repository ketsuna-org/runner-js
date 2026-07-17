import { describe, expect, it } from 'vitest';

import { getVoiceDependencyStatus } from '../src/runtime/voice-deps.js';

describe('voice dependency status', () => {
  it('reports @discordjs/voice and DAVE library availability', () => {
    const status = getVoiceDependencyStatus();

    expect(status.available).toBe(true);
    expect(status.version).toMatch(/^0\.19\./);
    expect(status.davey).toBe(true);
    expect(status.report).toMatch(/DAVE Libraries/i);
    expect(status.report).toMatch(/@snazzah\/davey:\s*0\./);
  });
});
