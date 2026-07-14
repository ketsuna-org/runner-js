import { describe, expect, it } from 'vitest';

import {
  DiscordTokenUnauthorizedError,
  isDiscordGatewayFatalClose,
  isDiscordTokenUnauthorized,
} from '../src/discord/discord-auth-errors.js';

describe('isDiscordGatewayFatalClose', () => {
  it('detects disallowed intent close code', () => {
    expect(isDiscordGatewayFatalClose(4014, 'Disallowed Intents')).toBe(true);
  });

  it('detects disallowed intent message without code', () => {
    expect(isDiscordGatewayFatalClose(null, 'Used disallowed intents')).toBe(true);
  });
});

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

  it('detects disallowed intent errors for auto-restart suppression', () => {
    expect(isDiscordTokenUnauthorized(new Error('Used disallowed intents'))).toBe(true);
  });

  it('ignores transient network errors', () => {
    expect(isDiscordTokenUnauthorized(new Error('SocketException: Connection refused'))).toBe(
      false,
    );
  });
});
