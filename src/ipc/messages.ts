export type WorkerToParentMessage =
  | { type: 'ready'; botId: string; pid: number }
  | {
      type: 'status';
      botId: string;
      state: 'starting' | 'running' | 'stopped' | 'error';
      lastError?: string | null;
      startedAt?: string | null;
    }
  | {
      type: 'metrics';
      botId: string;
      rssBytes: number;
      cpuPercent: number | null;
      pid: number;
    }
  | {
      type: 'log';
      botId: string;
      level: 'info' | 'warn' | 'error' | 'debug';
      message: string;
    }
  | { type: 'stopped'; botId: string; reason?: string }
  | { type: 'pong'; requestId: string; ok: boolean };

export type ParentToWorkerMessage =
  | { type: 'start' }
  | { type: 'reload' }
  | { type: 'stop' }
  | { type: 'ping'; requestId: string }
  | {
      type: 'inbound-webhook';
      path: string;
      payload: unknown;
      headers: Record<string, string>;
    };

export type WorkerPingResponse = {
  type: 'pong';
  requestId: string;
  ok: boolean;
};

export function isWorkerMessage(value: unknown): value is WorkerToParentMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof (value as { type: unknown }).type === 'string'
  );
}

export function isParentMessage(value: unknown): value is ParentToWorkerMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof (value as { type: unknown }).type === 'string'
  );
}
