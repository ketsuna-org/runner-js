import process from 'node:process';

import { isParentMessage, type ParentToWorkerMessage } from '../ipc/messages.js';

export function onParentMessage(
  handler: (message: ParentToWorkerMessage) => void | Promise<void>,
): void {
  process.on('message', (raw: unknown) => {
    if (!isParentMessage(raw)) {
      return;
    }
    void handler(raw);
  });
}

export function sendToParent(message: Record<string, unknown>): void {
  process.send?.(message);
}
