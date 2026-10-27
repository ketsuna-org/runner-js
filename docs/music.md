# Musique (Lavalink) : l'objet `voice`

Les bots JavaScript peuvent jouer de la musique dans un salon vocal grâce à Lavalink. La fonctionnalité est
réservée au Premium, comme pour les bots Dart : le Manager force `lavalink.enabled` à `false` pour un compte
sans abonnement, et `voice` répond alors une erreur claire.

## Configuration

Même schéma que l'application et le runner Dart :

```json
{ "lavalink": { "enabled": true, "custom_servers": [{ "host": "lava.example", "port": 2333, "password": "…", "secure": false }] } }
```

Le bot sonde la liste publique de serveurs Lavalink v4 et garde les plus rapides ; les serveurs personnels
servent de repli. Les mots de passe ne sont jamais visibles depuis un script (`config.lavalink` n'expose que
`enabled`).

## L'objet `voice`

Global dans tous les scripts (commandes, événements, tâches planifiées). Aucun gestionnaire d'événement à écrire :
la file avance toute seule, le bot quitte le salon après 5 minutes sans piste ou 2 minutes seul.

| Méthode | Rôle |
| --- | --- |
| `await voice.play(requête \| url, { channelId?, source?, next? })` | Rejoint le salon de l'auteur (ou `channelId`) et lit ou met en file. Renvoie `{ track, queued, position, playlist? }`. `source` : `youtube` (défaut), `youtubemusic`, `soundcloud`, `spotify`. |
| `await voice.search(requête, { limit?, source? })` | Cherche des pistes (10 max) sans rien jouer. |
| `await voice.pause()` / `resume()` / `stop()` | `stop` vide la file et arrête la lecture, le bot reste dans le salon. |
| `await voice.skip()` | Piste suivante ; renvoie la nouvelle piste ou `null`. Un skip ne boucle jamais : sur la dernière piste il arrête la file, même en boucle `queue`. |
| `await voice.seek(position, unit?)` | Se place dans la piste en cours : millisecondes par défaut, `'seconds'` en second argument. |
| `await voice.setVolume(0-200)` / `voice.getVolume()` | Volume (100 = normal). |
| `voice.setLoopMode('off' \| 'track' \| 'queue')` / `getLoopMode()` | Boucle. |
| `voice.getQueue()` | `{ connected, channelId, current, upcoming, loop, volume, paused }`. |
| `voice.nowPlaying()` | Piste en cours avec `positionMs`, ou `null`. |
| `voice.remove(rang)` / `clear()` / `shuffle()` | Gestion de la file (rang à partir de 1). |
| `await voice.join(channelId?)` / `await voice.leave()` | Connexion et déconnexion du salon vocal. |
| `voice.isConnected()` / `isPlaying()` / `isPaused()` / `voice.enabled` | État. |

Une piste : `{ title, author, url, duration, durationText, isStream, thumbnail, source, identifier, requestedBy }`
(`duration` en millisecondes).

```js
// Commande /play
const query = interaction.options.getString('query');
await interaction.deferReply();
try {
  const result = await voice.play(query);
  await interaction.editReply(
    result.queued ? `Ajouté en file (#${result.position}) : ${result.track.title}` : `Lecture : ${result.track.title}`,
  );
} catch (error) {
  await interaction.editReply(`Impossible : ${error.message}`);
}
```
