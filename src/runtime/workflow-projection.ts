import type { JsBotConfig } from '../config/js-bot-config.js';

/**
 * Projection d'UN workflow d'éditeur dans la configuration du runner (`events`, `scheduled`).
 *
 * Le Manager reconstruit ces listes à chaque synchro complète (projectAutomationsForJSRunner) :
 * un workflow d'événement devient un handler `events` d'identifiant = nom du workflow, et un
 * déclencheur planifié reprend le script du workflow qu'il nomme. La route de hot-sync reçoit
 * un seul workflow : on applique la même règle à ce workflow seulement, sans toucher au reste.
 *
 * Les webhooks entrants ne sont pas projetés ici : le runner ne conserve pas le nom du workflow
 * qu'ils exécutent (le schéma les réduit à `id`/`path`/`script`), ils ne se rafraîchissent donc
 * que par une synchro complète.
 */

type EventHandlers = JsBotConfig['events'];

/** Le nom d'un workflow est une clé métier insensible à la casse (comme côté Manager et application). */
function sameName(left: string | undefined, right: string): boolean {
  return (left ?? '').trim().toLowerCase() === right.trim().toLowerCase();
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function scriptOf(workflow: Record<string, unknown>): string {
  const script = workflow.jsScriptContent;
  return typeof script === 'string' && script.trim().length > 0 ? script : '';
}

function eventNameOf(workflow: Record<string, unknown>): string {
  const trigger = workflow.eventTrigger;
  if (!trigger || typeof trigger !== 'object') {
    return '';
  }
  const record = trigger as Record<string, unknown>;
  return text(record.event) || text(record.listenFor);
}

/**
 * `workflow` absent = suppression. Les entrées sont remplacées sur place (l'ordre est conservé),
 * un handler nouveau est ajouté en fin de liste.
 */
function project(
  config: JsBotConfig,
  workflowName: string,
  workflow: Record<string, unknown> | null,
): JsBotConfig {
  const script = workflow ? scriptOf(workflow) : '';

  // Un workflow d'événement sans événement ou sans script n'est pas exécutable en JavaScript
  // (le Manager l'écarte aussi à la synchro complète) : son ancien handler disparaît.
  const event = workflow ? eventNameOf(workflow) : '';
  const handler: EventHandlers[number] | null =
    workflow && workflow.workflowType === 'event' && event && script
      ? {
          // Même règle que le Manager : à défaut de nom, l'identifiant est le nom de l'événement.
          id: text(workflow.name) || event,
          type: 'event',
          name: event,
          enabled: true,
          script,
        }
      : null;

  // Le handler porte l'identifiant `workflow.name`, qui peut différer de la clé de la route : les
  // deux sont retirés pour ne jamais produire un identifiant en double (la validation le refuse).
  const events: EventHandlers = [];
  let placed = false;
  for (const existing of config.events ?? []) {
    if (!sameName(existing.id, workflowName) && !(handler && sameName(existing.id, handler.id))) {
      events.push(existing);
    } else if (handler && !placed) {
      events.push(handler);
      placed = true;
    }
  }
  if (handler && !placed) {
    events.push(handler);
  }

  // Les déclencheurs planifiés portent le script du workflow qu'ils nomment : on le rafraîchit,
  // et on les retire si le workflow n'a plus de script (la synchro complète les écarte alors).
  const scheduled = (config.scheduled ?? []).flatMap((entry) => {
    if (!sameName(entry.name, workflowName)) {
      return [entry];
    }
    return script ? [{ ...entry, script }] : [];
  });

  return { ...config, events, scheduled };
}

/**
 * Les webhooks entrants nomment un workflow que le runner ne retient pas : si le bot en a, un
 * workflow qui n'est pas un workflow d'événement connu a pu être leur script, et le hot-sync ne
 * pourrait ni le rafraîchir ni le retirer. Mieux vaut le refuser (501, le Manager retombe sur une
 * synchro complète) que répondre « appliqué » alors qu'un webhook garde l'ancien script.
 */
export function hotSyncIncomplete(
  config: JsBotConfig,
  workflowName: string,
  workflow: Record<string, unknown> | null,
): boolean {
  if ((config.inboundWebhooks ?? []).length === 0) {
    return false;
  }
  if (workflow) {
    return workflow.workflowType !== 'event';
  }
  return !(config.events ?? []).some((event) => sameName(event.id, workflowName));
}

export function applyWorkflowToConfig(
  config: JsBotConfig,
  workflowName: string,
  workflow: Record<string, unknown>,
): JsBotConfig {
  return project(config, workflowName, workflow);
}

export function removeWorkflowFromConfig(config: JsBotConfig, workflowName: string): JsBotConfig {
  return project(config, workflowName, null);
}
