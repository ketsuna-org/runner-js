import { describe, expect, it } from 'vitest';

import {
  DiscordTokenUnauthorizedError,
  isDiscordTokenUnauthorized,
} from '../src/discord/discord-auth-errors.js';

describe('isDiscordTokenUnauthorized', () => {
  it('detects DiscordTokenUnauthorizedError', () => {
    expect(
      isDiscordTokenUnauthorized(new DiscordTokenUnauthorizedError('invalid token')),
    ).toBe(true);
  });

  it('detects REST 401 on applications/@me', () => {
    expect(
      isDiscordTokenUnauthorized(
        new Error(
          '401: Unauthorized (0) GET https://discord.com/api/v10/applications/@me',
        ),
      ),
    ).toBe(true);
  });

  it('ignores transient network errors', () => {
    expect(isDiscordTokenUnauthorized(new Error('SocketException: Connection refused'))).toBe(
      false,
    );
  });
});
