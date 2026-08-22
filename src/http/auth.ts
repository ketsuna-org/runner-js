import type { MiddlewareHandler } from 'hono';

import { isRunnerLoopbackHost, normalizeRunnerApiToken } from '../config/env.js';

export function createAuthMiddleware(apiToken: string, webHost: string): MiddlewareHandler {
  const normalizedToken = normalizeRunnerApiToken(apiToken);

  return async (c, next) => {
    const path = c.req.path;
    const method = c.req.method;

    if (!requiresAuthentication(path, method, normalizedToken, webHost)) {
      return next();
    }

    const header = c.req.header('authorization');
    if (!header?.startsWith('Bearer ')) {
      return c.json({ error: 'Missing or invalid bearer token.' }, 401);
    }

    const provided = normalizeRunnerApiToken(header.slice('Bearer '.length));
    if (provided !== normalizedToken) {
      return c.json({ error: 'Missing or invalid bearer token.' }, 401);
    }

    return next();
  };
}

export function requiresAuthentication(
  url: string,
  method: string,
  apiToken: string,
  webHost: string,
): boolean {
  if (apiToken.length === 0 && isRunnerLoopbackHost(webHost)) {
    return false;
  }

  if (apiToken.length === 0) {
    return false;
  }

  const path = url.split('?')[0] ?? url;
  if (path.includes('/inbound/') && method === 'POST') {
    return false;
  }

  if (method === 'GET' && (path === '/health' || path === '/')) {
    return false;
  }

  return true;
}
