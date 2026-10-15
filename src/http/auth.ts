import type { MiddlewareHandler } from 'hono';

import { isRunnerLoopbackHost, normalizeRunnerApiToken } from '../config/env.js';
import { safeEqual } from './safe-equal.js';

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
    if (!safeEqual(provided, normalizedToken)) {
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
  if (method === 'POST' && isInboundWebhookPath(path)) {
    return false;
  }

  if (method === 'GET' && (path === '/health' || path === '/')) {
    return false;
  }

  return true;
}

/**
 * Webhook entrant : `POST /bots/:id/inbound/<clé>`, la seule route publique en écriture (son
 * secret est vérifié par la route elle-même). Le chemin doit COMMENCER par `/bots/<id>/inbound/`
 * avec une clé non vide : un `includes('/inbound/')` laissait passer sans jeton n'importe quel
 * chemin portant ce fragment, y compris derrière un préfixe ou un `..` normalisé plus loin
 * (MB-23, SEC-052).
 */
export function isInboundWebhookPath(path: string): boolean {
  if (path.includes('\\') || path.includes('%')) {
    return false;
  }
  const segments = path.split('/');
  // ['', 'bots', '<id>', 'inbound', '<clé>', ...]
  if (segments.length < 5 || segments[0] !== '' || segments[1] !== 'bots' || segments[3] !== 'inbound') {
    return false;
  }
  const tail = segments.slice(2);
  const lastIndex = tail.length - 1;
  return tail.every((segment, index) => {
    if (segment === '.' || segment === '..') return false;
    if (segment === '') return index === lastIndex && index > 2;
    return true;
  });
}
