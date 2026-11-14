/**
 * Fonctions IA du langage du bot (`bc.ai`), à parité avec `$ai`, `$aiWithCtx`, `$aiDecide`, `$aiDecideWithCtx`,
 * `$aiAgent` et `$aiQuota` du moteur BDFD.
 *
 * Le runner n'a aucune clé IA : l'appel passe par le Manager, qui débite les crédits IA du propriétaire du bot.
 * Un runner self-hosted n'a pas les variables d'environnement d'un runner géré : aucune passerelle n'est
 * installée et les fonctions répondent « indisponible » (`bc.ai.error === 'ai_unavailable'`).
 */

export interface AiToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

export interface AiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: AiToolCall[];
}

export interface AiTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AiReply {
  content: string;
  toolCalls: AiToolCall[];
  remainingTokens?: number;
}

export class AiGatewayError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'AiGatewayError';
  }
}

export interface AiGateway {
  complete(request: {
    botId: string;
    key: string;
    fn: string;
    messages: AiMessage[];
    tools?: AiTool[];
    maxTokens?: number;
    /** Utilisateur Discord à l'origine de l'appel (limite par joueur côté Manager). */
    userId?: string;
  }): Promise<AiReply>;
  /** Crédits restants, en tokens (1 crédit = 1000 tokens). */
  remainingTokens(botId: string): Promise<number>;
}

let installed: AiGateway | null = null;

export function setAiGateway(gateway: AiGateway | null): void {
  installed = gateway;
}

export function getAiGateway(): AiGateway | null {
  return installed;
}

export interface ManagedAiGatewayOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class ManagedAiGateway implements AiGateway {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: ManagedAiGatewayOptions) {
    this.#baseUrl = options.baseUrl.endsWith('/') ? options.baseUrl.slice(0, -1) : options.baseUrl;
    this.#token = options.token;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 70_000;
  }

  /** Installe la passerelle si la configuration est celle d'un runner géré. */
  static install(env: { managedRunnerApi: string; managedRunnerToken: string }): boolean {
    const baseUrl = env.managedRunnerApi.trim();
    const token = env.managedRunnerToken.trim();
    if (!baseUrl || !token) {
      return false;
    }
    setAiGateway(new ManagedAiGateway({ baseUrl, token }));
    return true;
  }

  async #failure(response: Response): Promise<AiGatewayError> {
    try {
      const body = (await response.json()) as { code?: unknown };
      if (typeof body.code === 'string' && body.code) {
        return new AiGatewayError(body.code);
      }
    } catch {
      // corps absent ou illisible
    }
    return new AiGatewayError(response.status === 429 ? 'ai_rate_limited' : 'ai_unavailable');
  }

  async complete(request: {
    botId: string;
    key: string;
    fn: string;
    messages: AiMessage[];
    tools?: AiTool[];
    maxTokens?: number;
    /** Utilisateur Discord à l'origine de l'appel (limite par joueur côté Manager). */
    userId?: string;
  }): Promise<AiReply> {
    const body = JSON.stringify({
      key: request.key,
      function: request.fn,
      messages: request.messages,
      ...(request.tools && request.tools.length > 0 ? { tools: request.tools } : {}),
      ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
      ...(request.userId ? { user_id: request.userId } : {}),
    });
    const url = `${this.#baseUrl}/bots/${encodeURIComponent(request.botId)}/ai/complete`;
    // Un seul rejeu, avec la même clé : le Manager ne débite pas deux fois une clé déjà vue.
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await this.#fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.#token}` },
          body,
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
        if (response.status >= 500 && response.status !== 503 && attempt === 0) {
          continue;
        }
        if (response.status !== 200) {
          throw await this.#failure(response);
        }
        const json = (await response.json()) as {
          message?: { content?: string; tool_calls?: AiToolCall[] };
          remaining_tokens?: number;
        };
        return {
          content: json.message?.content ?? '',
          toolCalls: json.message?.tool_calls ?? [],
          remainingTokens: json.remaining_tokens,
        };
      } catch (error) {
        if (error instanceof AiGatewayError) {
          throw error;
        }
        if (attempt === 0) {
          continue;
        }
        throw new AiGatewayError('ai_unavailable');
      }
    }
  }

  async remainingTokens(botId: string): Promise<number> {
    try {
      const response = await this.#fetch(`${this.#baseUrl}/bots/${encodeURIComponent(botId)}/ai/quota`, {
        headers: { Authorization: `Bearer ${this.#token}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status !== 200) {
        throw await this.#failure(response);
      }
      const json = (await response.json()) as { remaining_tokens?: number };
      return Number(json.remaining_tokens ?? 0);
    } catch (error) {
      throw error instanceof AiGatewayError ? error : new AiGatewayError('ai_unavailable');
    }
  }
}
