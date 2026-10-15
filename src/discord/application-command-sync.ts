import { Routes } from 'discord.js';

// LES RUNNERS NE PUBLIENT JAMAIS DE COMMANDE CHEZ DISCORD.
//
// Le Manager est l'auteur des commandes d'un bot Cloud (il les crée et les met à jour chez Discord avec
// le jeton du coffre), l'application l'est pour un bot local. Un runner profite de la synchro et du
// rechargement à chaud pour EXÉCUTER les commandes ; il ne crée ni ne modifie rien chez Discord.
//
// La seule chose qu'il propage est la suppression basique : une commande qui disparaît de sa
// configuration disparaît aussi chez Discord. Il ne supprime JAMAIS une commande qu'il ne connaissait pas
// (un différentiel avec la liste distante effacerait ce que le Manager vient de publier).

/** Identifie une commande chez Discord : son type et son nom (jamais son identifiant). */
export interface CommandKey {
  type: number;
  name: string;
}

/** The subset of `@discordjs/rest`'s REST this module needs (so tests can fake it). */
export interface CommandRest {
  get(route: string): Promise<unknown>;
  delete(route: string): Promise<unknown>;
}

export function commandKeyOf(command: { type?: number; name?: string }): string {
  return `${command.type ?? 1}:${(command.name ?? '').toLowerCase()}`;
}

/**
 * Supprime chez Discord les commandes `keys` (reconnues par type et nom). Rend les noms retirés. Ne fait
 * AUCUN appel quand `keys` est vide, et ne touche à aucune autre commande.
 */
export async function removeCommands(
  rest: CommandRest,
  applicationId: string,
  keys: CommandKey[],
): Promise<string[]> {
  if (keys.length === 0) return [];
  const wanted = new Set(keys.map((key) => commandKeyOf(key)));
  const remote = (await rest.get(Routes.applicationCommands(applicationId))) as Array<{
    id: string;
    type?: number;
    name?: string;
  }>;
  const removed: string[] = [];
  for (const command of remote ?? []) {
    if (command && typeof command.id === 'string' && wanted.has(commandKeyOf(command))) {
      await rest.delete(Routes.applicationCommand(applicationId, command.id));
      removed.push(command.name ?? '');
    }
  }
  return removed;
}
