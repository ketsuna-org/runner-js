import { describe, expect, it } from 'bun:test';

import { createAuthMiddleware } from '../src/http/auth.js';
import { safeEqual } from '../src/http/safe-equal.js';

describe('safeEqual', () => {
  it('accepts identical strings and rejects any difference, including length', () => {
    expect(safeEqual('s3cret', 's3cret')).toBe(true);
    expect(safeEqual('s3cret', 's3creT')).toBe(false);
    expect(safeEqual('s3cret', 's3cret ')).toBe(false);
    expect(safeEqual('', 's3cret')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
});

describe('API token middleware', () => {
  const run = async (header: string | undefined) => {
    const mw = createAuthMiddleware('tok-123', '0.0.0.0');
    let nextCalled = false;
    let status = 200;
    const c = {
      req: {
        path: '/bots',
        method: 'GET',
        header: (n: string) => (n === 'authorization' ? header : undefined),
      },
      json: (_b: unknown, s: number) => {
        status = s;
        return new Response(null, { status: s });
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await mw(c as any, async () => {
      nextCalled = true;
    });
    return { nextCalled, status };
  };

  it('lets the right token through and refuses a wrong, shorter or missing one', async () => {
    expect((await run('Bearer tok-123')).nextCalled).toBe(true);
    expect((await run('Bearer tok-124')).status).toBe(401);
    expect((await run('Bearer tok')).status).toBe(401);
    expect((await run(undefined)).status).toBe(401);
  });
});
