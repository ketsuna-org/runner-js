/**
 * Accès des scripts (`bc.alert`) aux alertes par serveur du Manager, via les routes runner
 * (`/bots/{id}/guild-automations`). Le Manager vérifie l'offre, l'interrupteur du propriétaire et les
 * plafonds ; le script vérifie « Gérer le serveur » avant d'écrire.
 */

/** Sources proposées, et la clé de configuration que le Manager attend pour chacune. */
export const ALERT_SOURCE_KEYS: Record<string, string> = { rss: 'url', youtube: 'channel', twitch: 'login', bluesky: 'handle' };
export const ALERT_ACTIONS = ['workflow', 'message', 'both'] as const;

const MESSAGES: Record<string, string> = {
  automation_paid_required: "alert_paid_required: alerts need a paid plan on the bot owner's account.",
  automation_not_enabled: 'alert_not_enabled: the bot owner has not turned alerts on.',
  automation_limit_reached: 'alert_limit_reached: this server reached its active alerts limit.',
  automation_total_limit: 'alert_total_limit: this bot reached its total alerts limit.',
  source_unreachable: 'alert_source_unreachable: the source cannot be read.',
  source_unavailable: 'alert_source_unreachable: the source cannot be read.',
  automation_not_found: 'alert_not_found: no such alert on this server.',
  invalid_payload: 'alert_invalid: check the source, channel and action.',
};

/** Erreur d'une opération `bc.alert` : `code` est le code du Manager, `message` le texte (même qu'en BDFD). */
export class AlertError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? MESSAGES[code] ?? 'alert_unavailable: alerts are not available right now.');
    this.name = 'AlertError';
    this.code = code;
  }
}

export interface GuildAlertsApi {
  /** `{automations: [...], view: {...}}` */
  list(guildId: string): Promise<Record<string, any>>;
  /** Crée l'alerte ARRÊTÉE et renvoie son identifiant. */
  create(body: Record<string, unknown>): Promise<string>;
  setStatus(guildId: string, id: string, enable: boolean): Promise<void>;
  remove(guildId: string, id: string): Promise<void>;
}

let installed: { baseUrl: string; token: string } | null = null;

/** Pose l'accès au Manager si l'environnement est celui d'un runner géré. */
export function installGuildAlertsApi(env: { managedRunnerApi: string; managedRunnerToken: string }): boolean {
  const baseUrl = env.managedRunnerApi.trim().replace(/\/$/, '');
  const token = env.managedRunnerToken.trim();
  installed = baseUrl !== '' && token !== '' ? { baseUrl, token } : null;
  return installed !== null;
}

export function guildAlertsApiFor(botId: string, fetchImpl: typeof fetch = fetch): GuildAlertsApi | null {
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
      throw new AlertError('unavailable');
    }
    let body: Record<string, any> = {};
    try {
      body = (await response.json()) as Record<string, any>;
    } catch {
      // corps absent ou illisible
    }
    if (response.status >= 400) {
      const code = body.code ?? body.error;
      throw new AlertError(typeof code === 'string' && code !== '' ? code : 'unavailable');
    }
    return body;
  };
  const post = (suffix: string, body: unknown) => send(url(suffix), { method: 'POST', body: JSON.stringify(body) });
  return {
    list: (guildId) => send(url('', `?guild_id=${encodeURIComponent(guildId)}`)),
    create: async (body) => String((await post('', body)).id ?? ''),
    setStatus: async (guildId, id, enable) =>
      void (await post(`/${encodeURIComponent(id)}/${enable ? 'enable' : 'disable'}`, { guild_id: guildId })),
    remove: async (guildId, id) => void (await post(`/${encodeURIComponent(id)}/delete`, { guild_id: guildId })),
  };
}
