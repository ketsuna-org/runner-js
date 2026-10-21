import type { ScriptExecutionContext, ScriptLogger } from './script-context.js';

/**
 * Le timeout d'un script (`Promise.race`) n'annule rien : le script continue en arrière-plan. Ces rappels
 * laissent l'appelant compter l'exécution jusqu'à sa fin RÉELLE (planificateur : places d'exécution).
 */
export interface ScriptRunLifecycle {
  /** Appelé juste avant le rejet « timed out », alors que le script tourne encore. */
  onTimeout?: () => void;
  /** Appelé quand l'exécution du script se termine vraiment (succès, erreur ou fin tardive après timeout). */
  onSettled?: () => void;
}

export interface ScriptRuntime {
  execute(
    script: string,
    context: ScriptExecutionContext,
    logger: ScriptLogger,
    timeoutMs: number,
    lifecycle?: ScriptRunLifecycle,
  ): Promise<unknown>;
  dispose(): void;
}
