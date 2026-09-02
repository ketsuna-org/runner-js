// Bun compatibility polyfills
try {
  const proc = globalThis.process as unknown as {
    getBuiltinModule?: (name: string) => Record<string, unknown>;
  };
  const v8 = proc?.getBuiltinModule?.('v8') as
    | { startupSnapshot?: { isBuildingSnapshot?: () => boolean } }
    | undefined;
  if (v8?.startupSnapshot) {
    v8.startupSnapshot.isBuildingSnapshot = () => false;
  }
} catch {
  // ignore
}
