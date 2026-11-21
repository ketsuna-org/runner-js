/**
 * Levée quand une dépendance de la plateforme (API du Manager, stockage des variables) est
 * injoignable ou en panne, par opposition à une erreur dans le script du bot.
 *
 * `message` est toujours montrable à n'importe qui (ni URL, ni code HTTP, ni nom d'hôte interne).
 * Le détail technique est dans `detail` et ne va QUE dans les journaux du bot, jamais dans un salon.
 */
export const INFRASTRUCTURE_USER_MESSAGE = 'Variable storage is temporarily unavailable.';

export class InfrastructureError extends Error {
  readonly detail: string;
  readonly infrastructure = true;

  constructor(detail: string, message: string = INFRASTRUCTURE_USER_MESSAGE) {
    super(message);
    this.name = 'InfrastructureError';
    this.detail = detail;
  }
}

/** Vrai pour une panne de plateforme (jamais postée dans un salon, seulement journalisée). */
export function isInfrastructureError(error: unknown): boolean {
  if (error instanceof InfrastructureError) return true;
  const text = error instanceof Error ? error.message : String(error ?? '');
  return text.includes('[ManagedVariableStore]') || text.includes('.svc.cluster.local');
}
