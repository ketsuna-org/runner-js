import type { FastifyRequest } from 'fastify';

import { isRunnerLoopbackHost, normalizeRunnerApiToken } from '../config/env.js';

export function createAuthHook(apiToken: string, webHost: string) {
  const normalizedToken = normalizeRunnerApiToken(apiToken);

  return async function authHook(request: FastifyRequest): Promise<void> {
    if (!requiresAuthentication(request.url, request.method, normalizedToken, webHost)) {
      return;
    }

    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw createUnauthorizedError();
    }

    const provided = normalizeRunnerApiToken(header.slice('Bearer '.length));
    if (provided !== normalizedToken) {
      throw createUnauthorizedError();
    }
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

function createUnauthorizedError(): Error & { statusCode: number } {
  const error = new Error('Missing or invalid bearer token.') as Error & {
    statusCode: number;
  };
  error.statusCode = 401;
  return error;
}
