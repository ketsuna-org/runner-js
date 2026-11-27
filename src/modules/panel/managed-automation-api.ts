/**
 * Accès du panneau /config aux automatisations par serveur, via les routes runner du Manager
 * (`/bots/{id}/guild-automations`). Une erreur du Manager devient une `PanelAutomationError`.
 */
import { PanelAutomationError, type PanelAutomationApi } from './module-panel-automations.js';

let installed: { baseUrl: string; token: string } | null = null;

/** Pose l'accès au Manager si l'environnement est celui d'un runner géré. */
export function installPanelAutomationApi(env: { managedRunnerApi: string; managedRunnerToken: string }): boolean {
  const baseUrl = env.managedRunnerApi.trim().replace(/\/$/, '');
  const token = env.managedRunnerToken.trim();
  installed = baseUrl !== '' && token !== '' ? { baseUrl, token } : null;
  return installed !== null;
}

export function panelAutomationApiFor(botId: string, fetchImpl: typeof fetch = fetch): PanelAutomationApi | null {
  if (!installed) return null;
  const { baseUrl, token } = installed;
  const url = (suffix: string, query = ''): string =>
    `${baseUrl}/bots/${encodeURIComponent(botId)}/guild-automations${suffix}${query}`;
  const send = async (target: string, init: RequestInit = {}): Promise<Record<string, any>> => {
    let response: Response;
    try {
      response = await fetchImpl(target, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new PanelAutomationError('unavailable');
    }
    let body: Record<string, any> = {};
    try {
      body = (await response.json()) as Record<string, any>;
    } catch {
      // corps absent ou illisible
    }
    if (response.status >= 400) {
      const code = body.code ?? body.error;
      throw new PanelAutomationError(typeof code === 'string' && code !== '' ? code : 'unavailable');
    }
    return body;
  };
  const post = (suffix: string, body: unknown) => send(url(suffix), { method: 'POST', body: JSON.stringify(body) });
  return {
    list: (guildId) => send(url('', `?guild_id=${encodeURIComponent(guildId)}`)),
    create: async (body) => void (await post('', body)),
    setStatus: async (guildId, id, enable) =>
      void (await post(`/${encodeURIComponent(id)}/${enable ? 'enable' : 'disable'}`, { guild_id: guildId })),
    remove: async (guildId, id) => void (await post(`/${encodeURIComponent(id)}/delete`, { guild_id: guildId })),
  };
}
