export function parseScopedContextParts(
  scope: string,
  contextId: string,
): { ctx1: string; ctx2: string } {
  if (scope === 'guildMember') {
    const parts = contextId.split(':');
    return {
      ctx1: parts[0] ?? '',
      ctx2: parts.length > 1 ? parts.slice(1).join(':') : '',
    };
  }
  return { ctx1: contextId, ctx2: '' };
}

export function composeGuildMemberContextId(ctx1: string, ctx2: string): string {
  if (!ctx1) {
    return '';
  }
  return ctx2 ? `${ctx1}:${ctx2}` : ctx1;
}

export function splitManagedContextId(
  scope: string,
  contextId: string,
): { scopeId: string; scopeAuxId: string } {
  if (scope === 'guildMember') {
    const parts = contextId.split(':');
    if (parts.length >= 2) {
      return { scopeId: parts[0] ?? '', scopeAuxId: parts[1] ?? '' };
    }
    return { scopeId: parts[0] ?? '', scopeAuxId: '' };
  }
  return { scopeId: contextId, scopeAuxId: '' };
}
