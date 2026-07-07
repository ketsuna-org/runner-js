import ivm from 'isolated-vm';

import { createHostBridgeSession, type HostBridgeSession } from './script-host-bridge.js';
import type { ScriptExecutionContext, ScriptLogger } from './script-context.js';

export class ScriptBridgeHost {
  private readonly sessions = new Map<number, HostBridgeSession>();
  private nextSessionId = 1;
  private disposed = false;
  readonly bridgeRef: ivm.Reference<
    (sessionId: number, kind: string, arg1: string, arg2: unknown, arg3?: unknown) => unknown
  >;

  constructor() {
    this.bridgeRef = new ivm.Reference(
      (sessionId: number, kind: string, arg1: string, arg2: unknown, arg3?: unknown) =>
        this.dispatch(sessionId, kind, arg1, arg2, arg3),
    );
  }

  createSession(context: ScriptExecutionContext, logger: ScriptLogger): number {
    this.assertActive();
    const sessionId = this.nextSessionId++;
    this.sessions.set(sessionId, createHostBridgeSession(context, logger));
    return sessionId;
  }

  getSessionSpecs(sessionId: number): Pick<HostBridgeSession, 'objectSpecs' | 'moduleSpecs'> {
    const session = this.getSession(sessionId);
    return {
      objectSpecs: session.objectSpecs,
      moduleSpecs: session.moduleSpecs,
    };
  }

  dispatch(
    sessionId: number,
    kind: string,
    arg1: string,
    arg2: unknown,
    arg3?: unknown,
  ): unknown {
    this.assertActive();
    return this.getSession(sessionId).dispatch(kind, arg1, arg2, arg3);
  }

  async closeSession(sessionId: number, timeoutMs: number): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    await session.drain(timeoutMs);
    session.clearTimers();
    session.close();
    this.sessions.delete(sessionId);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    for (const sessionId of [...this.sessions.keys()]) {
      const session = this.sessions.get(sessionId);
      if (session) {
        session.clearTimers();
        session.close();
      }
    }
    this.sessions.clear();
    this.bridgeRef.release();
  }

  private getSession(sessionId: number): HostBridgeSession {
    const session = this.sessions.get(sessionId);
    if (!session || session.isClosed()) {
      throw new Error('Host bridge is not available.');
    }
    return session;
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new Error('Script bridge host has been disposed.');
    }
  }
}
