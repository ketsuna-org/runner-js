import { wsDecodeJson, wsJsonPath, wsScalarText } from '../runtime/websocket/ws-source.js';
import { WsException, type WebSocketBridge } from '../runtime/websocket/ws-support.js';
import type { WsEvent } from '../runtime/websocket/ws-manager.js';

/** Ce qu'un script reçoit de l'événement WebSocket qui l'a lancé (`bc.ws.event`). */
export interface WsScriptEvent {
  source: string;
  event: 'open' | 'message' | 'close' | 'error';
  /** Texte du message : jamais interprété comme un modèle ni comme un script. */
  message: string;
  /** JSON décodé du message, ou `null` s'il n'en est pas. */
  json: unknown;
  /** Valeur (texte) d'une clé du JSON, chemin pointé ; chaîne vide si absente. */
  payload(path: string): string;
  context: string;
  reconnected: boolean;
  gapMs: number;
  closeCode: number | null;
  closeReason: string;
  error: string;
}

export interface BcWs {
  /** Événement déclencheur ; `null` hors d'un workflow WebSocket. */
  event: WsScriptEvent | null;
  /** Ouvre la source (séquence de join comprise) ; `context` remplace `{{ctx}}` (200 caractères au plus). */
  join(source: string, context?: string): Promise<void>;
  send(source: string, message: string): Promise<void>;
  close(source: string): Promise<void>;
  /** `closed`, `connecting`, `open` ou `error`. */
  status(source: string): string;
  /** Code de la dernière erreur d'une opération `bc.ws` (`ws_*`), vide si elle a réussi. */
  lastError(): string;
}

export function toScriptEvent(event: WsEvent): WsScriptEvent {
  const json = event.event === 'message' ? wsDecodeJson(event.message) : undefined;
  return {
    source: event.source,
    event: event.event,
    message: event.message,
    json: json === undefined ? null : json,
    payload: (path) => (json === undefined ? '' : wsScalarText(wsJsonPath(json, path))),
    context: event.context,
    reconnected: event.reconnected,
    gapMs: event.gapMs,
    closeCode: event.closeCode,
    closeReason: event.closeReason,
    error: event.error,
  };
}

/**
 * `bc.ws` : mêmes opérations et mêmes codes d'erreur (`ws_*`) que `$wsJoin`, `$wsSend`, `$wsClose` et
 * `$wsStatus` en BDFD. Une opération qui échoue REJETTE avec une erreur dont `code` est le code `ws_*` ;
 * sans pont (aucune source), tout rejette `ws_unavailable`.
 */
export function createBcWs(bridge: WebSocketBridge | undefined, event: WsEvent | undefined): BcWs {
  let lastError = '';
  async function run(op: () => Promise<void>): Promise<void> {
    lastError = '';
    if (!bridge) {
      lastError = 'ws_unavailable';
      throw new WsException('ws_unavailable');
    }
    try {
      await op();
    } catch (error) {
      lastError = error instanceof WsException ? error.code : 'ws_connect_failed';
      throw error;
    }
  }
  return {
    event: event ? toScriptEvent(event) : null,
    join: (source, context = '') => run(() => bridge!.join(String(source), String(context ?? ''))),
    send: (source, message) => run(() => bridge!.send(String(source), String(message ?? ''))),
    close: (source) => run(() => bridge!.close(String(source))),
    status: (source) => (bridge ? bridge.status(String(source)) : 'closed'),
    lastError: () => lastError,
  };
}
