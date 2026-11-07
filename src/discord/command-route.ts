import { MessageFlags } from 'discord.js';
import type { ChatInputCommandInteraction, Interaction } from 'discord.js';

/**
 * Sous-commandes d'une commande slash : chacune peut porter son propre script et sa propre visibilité de réponse.
 * Même modèle de données que le moteur Dart (`subcommandWorkflows`, clé `sous-commande` ou `groupe/sous-commande`),
 * lu dans `data` de la commande :
 *  - `data.visibility` : `public` (défaut) ou `ephemeral`, pour toute la commande ;
 *  - `data.subcommandWorkflows[route].visibility` : surcharge pour cette route ;
 *  - `data.subcommandWorkflows[route].jsScriptContent` : script de la route (vide = script de la commande).
 */
export type ResponseVisibility = 'public' | 'ephemeral';

/** `groupe/sous-commande`, `sous-commande`, ou null pour une commande sans sous-commande. */
export function resolveInteractionRoute(interaction: Interaction): string | null {
  if (typeof interaction.isChatInputCommand !== 'function' || !interaction.isChatInputCommand()) {
    return null;
  }
  const options = (interaction as ChatInputCommandInteraction).options;
  if (typeof options?.getSubcommand !== 'function') {
    return null;
  }
  const group = typeof options.getSubcommandGroup === 'function' ? options.getSubcommandGroup(false) : null;
  const subcommand = options.getSubcommand(false);
  if (!subcommand) {
    return null;
  }
  return group ? `${group}/${subcommand}` : subcommand;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function routePayload(data: Record<string, unknown> | undefined, route: string | null): Record<string, unknown> | undefined {
  if (!route) return undefined;
  return asRecord(asRecord(data?.subcommandWorkflows)?.[route]);
}

function readVisibility(value: unknown): ResponseVisibility | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim().toLowerCase();
  return text === 'ephemeral' || text === 'public' ? text : undefined;
}

/** Script à exécuter : celui de la sous-commande s'il existe, sinon celui de la commande. */
export function resolveCommandScript(
  commandScript: string,
  data: Record<string, unknown> | undefined,
  route: string | null,
): string {
  const payload = routePayload(data, route);
  if (!payload) return commandScript;
  const mode = typeof payload.executionMode === 'string' ? payload.executionMode.trim() : '';
  if (mode !== '' && mode !== 'javascript') return commandScript;
  const own = payload.jsScriptContent ?? payload.script;
  return typeof own === 'string' && own.trim() !== '' ? own : commandScript;
}

/** Visibilité par défaut de la réponse : route, puis commande (`data.visibility`, puis `response.workflow`), puis publique. */
export function resolveCommandVisibility(
  data: Record<string, unknown> | undefined,
  route: string | null,
): ResponseVisibility {
  return (
    readVisibility(routePayload(data, route)?.visibility) ??
    readVisibility(data?.visibility) ??
    readVisibility(asRecord(asRecord(data?.response)?.workflow)?.visibility) ??
    'public'
  );
}

type ReplyLike = (options?: unknown) => Promise<unknown>;

function withDefaultEphemeral(options: unknown): unknown {
  if (typeof options === 'string') {
    return { content: options, flags: MessageFlags.Ephemeral };
  }
  const record = asRecord(options) ?? {};
  if (record.ephemeral !== undefined || record.flags !== undefined) {
    return options;
  }
  return { ...record, flags: MessageFlags.Ephemeral };
}

/**
 * Rend les réponses d'une interaction éphémères par défaut : un script qui précise `ephemeral` (ou `flags`) garde
 * la main. Sans effet pour une visibilité publique, qui est le comportement natif de discord.js.
 */
export function applyDefaultVisibility(interaction: Interaction, visibility: ResponseVisibility): void {
  if (visibility !== 'ephemeral') return;
  const target = interaction as unknown as Record<string, unknown>;
  for (const method of ['reply', 'deferReply', 'followUp'] as const) {
    const original = target[method];
    if (typeof original !== 'function') continue;
    target[method] = ((options?: unknown) =>
      (original as ReplyLike).call(interaction, withDefaultEphemeral(options))) as ReplyLike;
  }
}
