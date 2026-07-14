import { describe, expect, it } from 'vitest';

import {
  DiscordTokenUnauthorizedError,
  formatGatewayCloseMessage,
  isDiscordGatewayDisallowedIntentsClose,
  isDiscordGatewayFatalClose,
  isDiscordTokenUnauthorized,
} from '../src/discord/discord-auth-errors.js';

describe('isDiscordGatewayDisallowedIntentsClose', () => {
  it('detects disallowed intent close code', () => {
    expect(isDiscordGatewayDisallowedIntentsClose(4014, 'Disallowed Intents')).toBe(true);
  });

  it('detects disallowed intent message without code', () => {
    expect(isDiscordGatewayDisallowedIntentsClose(null, 'Used disallowed intents')).toBe(true);
  });
});

describe('isDiscordGatewayFatalClose', () => {
  it('does not treat 4014 as fatal', () => {
    expect(isDiscordGatewayFatalClose(4014, 'Disallowed Intents')).toBe(false);
  });

  it('still treats invalid intents as fatal', () => {
    expect(isDiscordGatewayFatalClose(4013, 'Invalid intents')).toBe(true);
  });
});

describe('formatGatewayCloseMessage', () => {
  it('returns actionable message for 4014', () => {
    expect(formatGatewayCloseMessage(4014, 'the reason property is deprecated')).toContain(
      'Disallowed intents (4014)',
    );
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
