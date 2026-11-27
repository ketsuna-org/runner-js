import { ALERT_ACTIONS, ALERT_SOURCE_KEYS, AlertError, guildAlertsApiFor, type GuildAlertsApi } from '../runtime/alerts/guild-alerts-api.js';

/** Une alerte telle que la lit un script (mêmes champs que `$alertInfo`). */
export interface BcAlertInfo {
  id: string;
  name: string;
  /** Valeur de la source : URL, chaîne, login ou handle. */
  source: string;
  kind: string;
  channelId: string;
  action: string;
  status: string;
  lastError: string;
}

export interface BcAlert {
  /**
   * Crée l'alerte du serveur courant et la démarre ; renvoie son identifiant. `source` : `rss`, `youtube`,
   * `twitch` ou `bluesky` ; `value` : URL, chaîne, login ou handle ; `action` : `workflow` (défaut), `message`
   * ou `both`. Exige « Gérer le serveur ».
   */
  create(options: { source: string; value: string; channelId: string; action?: string; name?: string }): Promise<string>;
  pause(id: string): Promise<void>;
  resume(id: string): Promise<void>;
  delete(id: string): Promise<void>;
  /** Nombre d'alertes du serveur ; `activeOnly` ne compte que celles qui tournent. */
  count(options?: { activeOnly?: boolean }): Promise<number>;
  list(): Promise<BcAlertInfo[]>;
  info(id: string): Promise<BcAlertInfo>;
}

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const MANAGE_GUILD = 'ManageGuild';

function toInfo(a: Any): BcAlertInfo {
  const source = a?.source && typeof a.source === 'object' ? Object.values(a.source)[0] : '';
  return {
    id: String(a?.id ?? ''),
    name: String(a?.name ?? ''),
    source: source === undefined || source === null ? '' : String(source),
    kind: String(a?.source_kind ?? ''),
    channelId: String(a?.channel_id ?? ''),
    action: String(a?.action ?? ''),
    status: String(a?.status ?? ''),
    lastError: String(a?.last_error ?? ''),
  };
}

/**
 * `bc.alert` : mêmes opérations et mêmes messages d'erreur (`alert_*`) que `$createAlert`, `$pauseAlert`,
 * `$resumeAlert`, `$deleteAlert`, `$alertCount`, `$alertList` et `$alertInfo` en BDFD. Écrire demande
 * « Gérer le serveur » ; une opération qui échoue REJETTE avec une `AlertError` dont `code` est le code du Manager.
 */
export function createBcAlert(deps: {
  botId: () => string;
  guildId: () => string;
  userId: () => string;
  getClient: () => unknown;
  apiFor?: (botId: string) => GuildAlertsApi | null;
}): BcAlert {
  const apiFor = deps.apiFor ?? ((id: string) => guildAlertsApiFor(id));

  function guild(): string {
    const id = deps.guildId();
    if (!/^[0-9]+$/.test(id)) {
      throw new AlertError('alert_guild_required', 'alert_guild_required: alerts can only be used inside a server.');
    }
    return id;
  }
  function api(): GuildAlertsApi {
    const found = apiFor(deps.botId());
    if (!found) {
      throw new AlertError(
        'alert_unavailable',
        'alert_unavailable: alerts only work when the bot runs on a runner connected to the Manager.',
      );
    }
    return found;
  }
  async function requireManager(guildId: string): Promise<string> {
    const author = deps.userId();
    const client = deps.getClient() as Any;
    if (!author || !client?.guilds) {
      throw new AlertError('alert_permission_unavailable', 'alert_permission_unavailable: cannot check the Manage Server permission here.');
    }
    let allowed = false;
    try {
      const g = await client.guilds.fetch(guildId);
      const member = await g.members.fetch(author);
      allowed = Boolean(member.permissions?.has?.(MANAGE_GUILD));
    } catch {
      throw new AlertError('alert_permission_unavailable', 'alert_permission_unavailable: cannot check the Manage Server permission here.');
    }
    if (!allowed) throw new AlertError('alert_forbidden', 'alert_forbidden: Manage Server permission is required.');
    return author;
  }
  const items = async (guildId: string): Promise<Any[]> => {
    const overview = await api().list(guildId);
    return Array.isArray(overview.automations) ? overview.automations : [];
  };
  const id = (value: unknown): string => {
    const text = String(value ?? '').trim();
    if (text === '') throw new AlertError('invalid_payload', 'Alert ID is required.');
    return text;
  };

  return {
    async create({ source, value, channelId, action, name }) {
      const guildId = guild();
      const kind = String(source ?? '').trim().toLowerCase();
      const key = ALERT_SOURCE_KEYS[kind];
      if (!key) throw new AlertError('invalid_payload', `Unknown alert source. Use ${Object.keys(ALERT_SOURCE_KEYS).join(', ')}.`);
      const text = String(value ?? '').trim();
      if (text === '') throw new AlertError('invalid_payload', 'Alert source value is required.');
      const channel = String(channelId ?? '').trim().replace(/^<#|>$/g, '');
      if (!/^[0-9]+$/.test(channel)) throw new AlertError('invalid_payload', 'Invalid channel ID.');
      const act = String(action ?? '').trim().toLowerCase() || 'workflow';
      if (!(ALERT_ACTIONS as readonly string[]).includes(act)) {
        throw new AlertError('invalid_payload', `Unknown alert action. Use ${ALERT_ACTIONS.join(', ')}.`);
      }
      let label = String(name ?? '').trim();
      if (label === '') label = `${kind} · ${text}`;
      label = label.slice(0, 60);
      const author = await requireManager(guildId);
      const service = api();
      const created = await service.create({
        guild_id: guildId,
        actor_id: author,
        name: label,
        source_kind: kind,
        source: { [key]: text },
        channel_id: channel,
        action: act,
      });
      await service.setStatus(guildId, created, true);
      return created;
    },
    async pause(alertId) {
      const guildId = guild();
      const target = id(alertId);
      await requireManager(guildId);
      await api().setStatus(guildId, target, false);
    },
    async resume(alertId) {
      const guildId = guild();
      const target = id(alertId);
      await requireManager(guildId);
      await api().setStatus(guildId, target, true);
    },
    async delete(alertId) {
      const guildId = guild();
      const target = id(alertId);
      await requireManager(guildId);
      await api().remove(guildId, target);
    },
    async count(options) {
      const list = await items(guild());
      return options?.activeOnly ? list.filter((a) => a?.status === 'active').length : list.length;
    },
    async list() {
      return (await items(guild())).map(toInfo);
    },
    async info(alertId) {
      const target = id(alertId);
      const found = (await items(guild())).find((a) => String(a?.id) === target);
      if (!found) throw new AlertError('automation_not_found');
      return toInfo(found);
    },
  };
}
