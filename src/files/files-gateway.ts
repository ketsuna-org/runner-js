/**
 * Fichiers des bots (`bc.files`), à parité avec `$fileUpload`, `$fileRead`, `$fileList`, `$fileDelete`, `$fileExists`
 * et `$fileURL` du moteur BDFD.
 *
 * Les fichiers vivent dans le stockage du compte du propriétaire (quota du compte), côté Manager, propres à chaque bot.
 * Un runner self-hosted n'a pas les variables d'un runner géré : aucune passerelle n'est installée et les fonctions
 * rejettent `files_unavailable`.
 */

/** Taille maximale d'un fichier : la même que celle du Manager et du dossier local du desktop. */
export const FILE_MAX_BYTES = 25 * 1024 * 1024;

export interface BotFileInfo {
  path: string;
  size: number;
  contentType: string;
  updatedAt: string;
}

export class FilesGatewayError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'FilesGatewayError';
  }
}

export interface FilesGateway {
  put(botId: string, path: string, data: Uint8Array, contentType: string): Promise<BotFileInfo>;
  get(botId: string, path: string): Promise<{ data: Uint8Array; contentType: string }>;
  list(botId: string, prefix: string, limit: number, after: string): Promise<BotFileInfo[]>;
  delete(botId: string, path: string): Promise<boolean>;
  exists(botId: string, path: string): Promise<boolean>;
  url(botId: string, path: string, ttlSeconds: number): Promise<string>;
}

let installed: FilesGateway | null = null;

export function setFilesGateway(gateway: FilesGateway | null): void {
  installed = gateway;
}

export function getFilesGateway(): FilesGateway | null {
  return installed;
}

export interface ManagedFilesGatewayOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface RawFile {
  path?: string;
  size?: number;
  content_type?: string;
  updated_at?: string;
}

const toInfo = (raw: RawFile): BotFileInfo => ({
  path: raw.path ?? '',
  size: Number(raw.size ?? 0),
  contentType: raw.content_type ?? 'application/octet-stream',
  updatedAt: raw.updated_at ?? '',
});

export class ManagedFilesGateway implements FilesGateway {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: ManagedFilesGatewayOptions) {
    this.#baseUrl = options.baseUrl.endsWith('/') ? options.baseUrl.slice(0, -1) : options.baseUrl;
    this.#token = options.token;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 60_000;
  }

  /** Installe la passerelle si la configuration est celle d'un runner géré. */
  static install(env: { managedRunnerApi: string; managedRunnerToken: string }): boolean {
    const baseUrl = env.managedRunnerApi.trim();
    const token = env.managedRunnerToken.trim();
    if (!baseUrl || !token) {
      return false;
    }
    setFilesGateway(new ManagedFilesGateway({ baseUrl, token }));
    return true;
  }

  #url(botId: string, op: string, query?: Record<string, string>): string {
    const qs = query ? `?${new URLSearchParams(query).toString()}` : '';
    return `${this.#baseUrl}/bots/${encodeURIComponent(botId)}/files/${op}${qs}`;
  }

  async #request(url: string, init: RequestInit = {}): Promise<Response> {
    let response: Response;
    try {
      response = await this.#fetch(url, {
        ...init,
        headers: { Authorization: `Bearer ${this.#token}`, ...(init.headers as Record<string, string> | undefined) },
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      throw new FilesGatewayError('files_unavailable');
    }
    if (response.status >= 400) {
      let code = '';
      try {
        const body = (await response.json()) as { code?: unknown };
        code = typeof body.code === 'string' ? body.code : '';
      } catch {
        // corps absent ou illisible
      }
      throw new FilesGatewayError(code || (response.status === 404 ? 'file_not_found' : 'files_unavailable'));
    }
    return response;
  }

  async put(botId: string, path: string, data: Uint8Array, contentType: string): Promise<BotFileInfo> {
    if (data.byteLength > FILE_MAX_BYTES) {
      throw new FilesGatewayError('file_too_large');
    }
    const response = await this.#request(this.#url(botId, 'put', { path }), {
      method: 'POST',
      headers: { 'Content-Type': contentType || 'application/octet-stream' },
      body: data as unknown as BodyInit,
    });
    return toInfo((await response.json()) as RawFile);
  }

  async get(botId: string, path: string): Promise<{ data: Uint8Array; contentType: string }> {
    const response = await this.#request(this.#url(botId, 'get', { path }));
    return {
      data: new Uint8Array(await response.arrayBuffer()),
      contentType: response.headers.get('X-File-Content-Type') ?? 'application/octet-stream',
    };
  }

  async list(botId: string, prefix: string, limit: number, after: string): Promise<BotFileInfo[]> {
    const response = await this.#request(
      this.#url(botId, 'list', { prefix, limit: String(limit), ...(after ? { after } : {}) }),
    );
    const json = (await response.json()) as { items?: RawFile[] };
    return (json.items ?? []).map(toInfo);
  }

  async delete(botId: string, path: string): Promise<boolean> {
    const response = await this.#request(this.#url(botId, 'delete'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    return Boolean(((await response.json()) as { deleted?: boolean }).deleted);
  }

  async exists(botId: string, path: string): Promise<boolean> {
    const response = await this.#request(this.#url(botId, 'exists', { path }));
    return Boolean(((await response.json()) as { exists?: boolean }).exists);
  }

  async url(botId: string, path: string, ttlSeconds: number): Promise<string> {
    const response = await this.#request(this.#url(botId, 'url'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, ttl_seconds: ttlSeconds }),
    });
    return String(((await response.json()) as { url?: string }).url ?? '');
  }
}
