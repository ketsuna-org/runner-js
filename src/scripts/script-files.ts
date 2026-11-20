import { FILE_MAX_BYTES, FilesGatewayError, type BotFileInfo, type FilesGateway } from '../files/files-gateway.js';

/** Erreur d'une opération `bc.files` : `code` vaut `file_not_found`, `file_too_large`, `file_quota_exceeded`… */
export class BcFilesError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'BcFilesError';
  }
}

export interface BcFiles {
  /** Écrit (ou remplace) le fichier. `data` : texte, octets ; `encoding: 'base64'` décode un texte base64. */
  put(
    path: string,
    data: string | Uint8Array,
    options?: { contentType?: string; encoding?: 'utf8' | 'base64' },
  ): Promise<BotFileInfo>;
  /** Contenu du fichier (octets) ; rejette `file_not_found` s'il n'existe pas. */
  get(path: string): Promise<Uint8Array>;
  /** Contenu du fichier en texte UTF-8 (`encoding: 'base64'` pour des octets quelconques). */
  getText(path: string, options?: { encoding?: 'utf8' | 'base64' }): Promise<string>;
  /** Fichiers du bot sous `prefix`, par chemin (`limit` 1000 au plus, `after` pour paginer). */
  list(prefix?: string, options?: { limit?: number; after?: string }): Promise<BotFileInfo[]>;
  /** Supprime le fichier ; faux s'il n'existait pas. */
  delete(path: string): Promise<boolean>;
  exists(path: string): Promise<boolean>;
  /** Lien temporaire de lecture (1 h par défaut, 10080 minutes au plus). */
  url(path: string, options?: { minutes?: number }): Promise<string>;
  /** Code de la dernière erreur d'une opération `bc.files`, vide si elle a réussi. */
  lastError(): string;
}

/** Taille maximale d'un fichier, en octets. */
export const BC_FILES_MAX_BYTES = FILE_MAX_BYTES;

const URL_DEFAULT_MINUTES = 60;
const URL_MAX_MINUTES = 7 * 24 * 60;

function toBytes(data: string | Uint8Array, encoding: 'utf8' | 'base64' | undefined): Uint8Array {
  if (typeof data !== 'string') {
    return data;
  }
  if (encoding === 'base64') {
    return new Uint8Array(Buffer.from(data, 'base64'));
  }
  return new TextEncoder().encode(data);
}

/**
 * `bc.files` : mêmes opérations et mêmes codes d'erreur que `$fileUpload`, `$fileRead`, `$fileList`, `$fileDelete`,
 * `$fileExists` et `$fileURL` en BDFD. Une opération qui échoue REJETTE avec une erreur dont `code` est le code ;
 * sans passerelle (runner self-hosted), tout rejette `files_unavailable`.
 */
export function createBcFiles(gateway: () => FilesGateway | null, botId: () => string): BcFiles {
  let lastError = '';
  async function run<T>(op: (gw: FilesGateway, id: string) => Promise<T>): Promise<T> {
    lastError = '';
    const gw = gateway();
    const id = botId();
    try {
      if (!gw || !id) {
        throw new FilesGatewayError('files_unavailable');
      }
      return await op(gw, id);
    } catch (error) {
      lastError = error instanceof FilesGatewayError ? error.code : 'files_unavailable';
      throw new BcFilesError(lastError);
    }
  }
  return {
    put: (path, data, options) =>
      run((gw, id) => gw.put(id, String(path), toBytes(data, options?.encoding), options?.contentType ?? '')),
    get: (path) => run(async (gw, id) => (await gw.get(id, String(path))).data),
    getText: (path, options) =>
      run(async (gw, id) => {
        const { data } = await gw.get(id, String(path));
        return options?.encoding === 'base64' ? Buffer.from(data).toString('base64') : new TextDecoder().decode(data);
      }),
    list: (prefix, options) =>
      run((gw, id) =>
        gw.list(id, String(prefix ?? ''), Math.min(1000, Math.max(1, Math.floor(options?.limit ?? 100))), options?.after ?? ''),
      ),
    delete: (path) => run((gw, id) => gw.delete(id, String(path))),
    exists: (path) => run((gw, id) => gw.exists(id, String(path))),
    url: (path, options) => {
      const minutes = Math.min(URL_MAX_MINUTES, Math.max(1, Math.floor(options?.minutes ?? URL_DEFAULT_MINUTES)));
      return run((gw, id) => gw.url(id, String(path), minutes * 60));
    },
    lastError: () => lastError,
  };
}
