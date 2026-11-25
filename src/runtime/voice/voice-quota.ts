/**
 * Quota de l'enregistrement vocal (`bc.recorder`), tenu par le Manager : Premium seulement, 20 h par mois et par
 * compte, 2 sessions simultanées. Le runner réserve la durée AVANT de rejoindre le salon et rapporte la durée
 * réellement enregistrée à la fin. Sans Manager (self-host, runner embarqué dans l'app), aucune passerelle n'est
 * installée : pas de quota, l'opérateur du runner est seul responsable de sa propre machine.
 *
 * Un runner géré échoue FERMÉ : si le Manager ne répond pas, rien n'est enregistré.
 */

export class VoiceQuotaError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'VoiceQuotaError';
  }
}

const MESSAGES: Record<string, string> = {
  voice_recorder_premium_required: 'Voice recording needs a Premium subscription on the account that owns this bot.',
  voice_recorder_quota_exceeded:
    'The monthly voice recording quota of this account is used up. It resets on the 1st of the month (UTC).',
  voice_recorder_too_many_sessions: 'This account already has the maximum number of voice recordings running.',
  voice_recorder_disabled: 'Voice recording is not enabled on this platform yet.',
  voice_recorder_unavailable: 'Could not check the voice recording quota right now: nothing was recorded. Try again later.',
};

export interface VoiceQuotaGrant {
  sessionId: string;
  grantedSeconds: number;
  remainingSeconds: number;
}

export interface VoiceQuotaStatus {
  premium: boolean;
  monthlySeconds: number;
  usedSeconds: number;
  remainingSeconds: number;
  resetsAt: string;
}

export interface VoiceQuotaGateway {
  reserve(botId: string, guildId: string, maxSeconds: number): Promise<VoiceQuotaGrant>;
  finish(botId: string, sessionId: string, usedSeconds: number): Promise<void>;
  quota(botId: string): Promise<VoiceQuotaStatus>;
}

let installed: VoiceQuotaGateway | null = null;

export function setVoiceQuotaGateway(gateway: VoiceQuotaGateway | null): void {
  installed = gateway;
}

export function getVoiceQuotaGateway(): VoiceQuotaGateway | null {
  return installed;
}

export interface ManagedVoiceQuotaGatewayOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class ManagedVoiceQuotaGateway implements VoiceQuotaGateway {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: ManagedVoiceQuotaGatewayOptions) {
    this.#baseUrl = options.baseUrl.endsWith('/') ? options.baseUrl.slice(0, -1) : options.baseUrl;
    this.#token = options.token;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  /** Installe la passerelle si la configuration est celle d'un runner géré. */
  static install(env: { managedRunnerApi: string; managedRunnerToken: string }): boolean {
    const baseUrl = env.managedRunnerApi.trim();
    const token = env.managedRunnerToken.trim();
    if (!baseUrl || !token) return false;
    setVoiceQuotaGateway(new ManagedVoiceQuotaGateway({ baseUrl, token }));
    return true;
  }

  async #request(botId: string, op: string, init: RequestInit = {}): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/bots/${encodeURIComponent(botId)}/voice-recorder/${op}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.#token}`,
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        },
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      throw new VoiceQuotaError('voice_recorder_unavailable', MESSAGES.voice_recorder_unavailable!);
    }
    if (response.status >= 400) {
      let code = '';
      try {
        const body = (await response.json()) as { code?: unknown };
        code = typeof body.code === 'string' ? body.code : '';
      } catch {
        // corps absent ou illisible
      }
      if (!MESSAGES[code]) code = 'voice_recorder_unavailable';
      throw new VoiceQuotaError(code, MESSAGES[code]!);
    }
    return response.json();
  }

  async reserve(botId: string, guildId: string, maxSeconds: number): Promise<VoiceQuotaGrant> {
    const raw = (await this.#request(botId, 'start', {
      method: 'POST',
      body: JSON.stringify({ guild_id: guildId, max_seconds: maxSeconds }),
    })) as { session_id?: string; granted_seconds?: number; remaining_seconds?: number };
    const grantedSeconds = Math.floor(Number(raw.granted_seconds ?? 0));
    if (!raw.session_id || !(grantedSeconds > 0)) {
      throw new VoiceQuotaError('voice_recorder_unavailable', MESSAGES.voice_recorder_unavailable!);
    }
    return { sessionId: raw.session_id, grantedSeconds, remainingSeconds: Math.floor(Number(raw.remaining_seconds ?? 0)) };
  }

  async finish(botId: string, sessionId: string, usedSeconds: number): Promise<void> {
    await this.#request(botId, 'finish', {
      method: 'POST',
      body: JSON.stringify({ session_id: sessionId, used_seconds: usedSeconds }),
    });
  }

  async quota(botId: string): Promise<VoiceQuotaStatus> {
    const raw = (await this.#request(botId, 'quota')) as Record<string, unknown>;
    return {
      premium: raw.premium === true,
      monthlySeconds: Number(raw.monthly_seconds ?? 0),
      usedSeconds: Number(raw.used_seconds ?? 0),
      remainingSeconds: Number(raw.remaining_seconds ?? 0),
      resetsAt: typeof raw.resets_at === 'string' ? raw.resets_at : '',
    };
  }
}
