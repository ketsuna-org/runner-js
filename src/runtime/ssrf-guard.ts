import { assertPublicHost } from './websocket/ws-transport.js';

const MAX_REDIRECTS = 5;

/**
 * Enveloppe un fetch pour le mode pool (plusieurs bots par processus) : http(s) uniquement, hôte résolu
 * vers des adresses publiques seulement, redirections suivies à la main et revérifiées à chaque saut.
 * Même limite que `assertPublicHost` : la résolution est refaite à la connexion (DNS rebinding à TTL très court).
 */
export function createSsrfGuardedFetch(
  fetchImpl: typeof fetch,
  assertPublic: (hostname: string) => Promise<void> = assertPublicHost,
): typeof fetch {
  const guarded = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    const wantsManual = init?.redirect === 'manual';
    const wantsError = init?.redirect === 'error';
    let current: URL;
    try {
      current = new URL(input instanceof Request ? input.url : String(input));
    } catch {
      throw new Error('fetch: invalid URL');
    }
    let method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    let body = init?.body;
    for (let hop = 0; ; hop++) {
      if (current.protocol !== 'http:' && current.protocol !== 'https:') {
        throw new Error('fetch: only http(s) addresses are allowed');
      }
      try {
        await assertPublic(current.hostname);
      } catch {
        throw new Error('fetch: this address is not allowed');
      }
      const response = await fetchImpl(current, { ...init, method, body, redirect: 'manual' });
      const location = response.headers.get('location');
      const isRedirect = response.status >= 300 && response.status < 400 && location;
      if (!isRedirect || wantsManual) {
        return response;
      }
      if (wantsError) {
        throw new Error('fetch: unexpected redirect');
      }
      if (hop >= MAX_REDIRECTS) {
        throw new Error('fetch: too many redirects');
      }
      try {
        await response.body?.cancel();
      } catch {
        // corps déjà fermé
      }
      current = new URL(location, current);
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
      }
    }
  };
  return guarded as typeof fetch;
}
