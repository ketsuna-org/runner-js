/**
 * Base de données des bots (`bc.db`), à parité avec les fonctions `$db*` du moteur BDFD.
 *
 * Les documents vivent chez le Manager (tables partagées, quotas du compte, atomicité) : le runner ne fait que relayer
 * `/bots/{id}/data/*`. Un runner self-hosted n'a pas les variables d'un runner géré : aucune passerelle n'est
 * installée et `bc.db` répond `unavailable`.
 */

export type DocSpaceKind = 'guild' | 'user' | 'bot';

export interface DocSpace {
  kind: DocSpaceKind;
  id: string;
}

/** Erreur typée du Manager : `conflict`, `quota`, `invalid`, `not_found`, `needs_index`, `timeout`, `unavailable`. */
export class DocumentsGatewayError extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'DocumentsGatewayError';
  }
}

export interface DocumentRecord {
  id: string;
  data: Record<string, unknown>;
  rev: number;
  expires_at?: string;
  [key: string]: unknown;
}

export interface DocumentsGateway {
  apply(botId: string, space: DocSpace, ops: Array<Record<string, unknown>>): Promise<Array<Record<string, unknown>>>;
  get(botId: string, space: DocSpace, collection: string, id: string): Promise<DocumentRecord | null>;
  find(botId: string, space: DocSpace, collection: string, query: Record<string, unknown>): Promise<Record<string, unknown>>;
  aggregate(botId: string, space: DocSpace, collection: string, request: Record<string, unknown>): Promise<Record<string, unknown>>;
}

let installed: DocumentsGateway | null = null;

export function setDocumentsGateway(gateway: DocumentsGateway | null): void {
  installed = gateway;
}

export function getDocumentsGateway(): DocumentsGateway | null {
  return installed;
}

const TYPED = new Set(['conflict', 'quota', 'invalid', 'not_found', 'needs_index', 'timeout', 'unavailable']);

export interface ManagedDocumentsGatewayOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class ManagedDocumentsGateway implements DocumentsGateway {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: ManagedDocumentsGatewayOptions) {
    this.#baseUrl = options.baseUrl.endsWith('/') ? options.baseUrl.slice(0, -1) : options.baseUrl;
    this.#token = options.token;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 20_000;
  }

  /** Installe la passerelle si la configuration est celle d'un runner géré. */
  static install(env: { managedRunnerApi: string; managedRunnerToken: string }): boolean {
    const baseUrl = env.managedRunnerApi.trim();
    const token = env.managedRunnerToken.trim();
    if (!baseUrl || !token) {
      return false;
    }
    setDocumentsGateway(new ManagedDocumentsGateway({ baseUrl, token }));
    return true;
  }

  async #call(botId: string, route: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/bots/${encodeURIComponent(botId)}/data/${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.#token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new DocumentsGatewayError(timedOut ? 'timeout' : 'unavailable');
    }
    let json: Record<string, unknown> = {};
    try {
      const parsed = (await response.json()) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        json = parsed as Record<string, unknown>;
      }
    } catch {
      // corps absent ou illisible
    }
    if (response.status >= 400) {
      const code = typeof json.code === 'string' && TYPED.has(json.code) ? json.code : 'unavailable';
      throw new DocumentsGatewayError(code, typeof json.message === 'string' ? json.message : undefined);
    }
    return json;
  }

  async apply(botId: string, space: DocSpace, ops: Array<Record<string, unknown>>): Promise<Array<Record<string, unknown>>> {
    const json = await this.#call(botId, 'apply', { space, ops });
    return Array.isArray(json.results) ? (json.results as Array<Record<string, unknown>>) : [];
  }

  async get(botId: string, space: DocSpace, collection: string, id: string): Promise<DocumentRecord | null> {
    const json = await this.#call(botId, 'get', { space, collection, id });
    return json.doc && typeof json.doc === 'object' ? (json.doc as DocumentRecord) : null;
  }

  find(botId: string, space: DocSpace, collection: string, query: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.#call(botId, 'find', { space, collection, query });
  }

  aggregate(botId: string, space: DocSpace, collection: string, request: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.#call(botId, 'aggregate', { space, collection, ...request });
  }
}
