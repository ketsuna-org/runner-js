# Enregistrement vocal (`bc.recorder`) : EXPÉRIMENTAL, staging seulement

Étude : `DESIGN-flux-vocal.md` du projet. Cette version minimale existe pour tester la réception du flux vocal
(DAVE) avec un vrai bot. **Pas de réserve Premium ni de quota dans cette version : ne pas la mettre en
production avant que le Manager les applique.** Coupe-circuit : variable d'environnement `VOICE_RECORDER_DISABLED=1`.

Le bot doit avoir l'intent **Guild Voice States** et la permission de rejoindre le salon. Un serveur ne
supporte qu'une connexion vocale par bot : refus si le bot est déjà dans un salon (musique Lavalink incluse).

## Règles appliquées par le moteur (pas par le script)

- Seules les personnes de `consentUserIds` (ou ajoutées avec `bc.recorder.consent`) sont enregistrées ; le flux
  des autres n'est **jamais lu**. `consentUserIds` est obligatoire (1 à 5 personnes).
- Une annonce est postée dans `announceChannelId` au démarrage et à l'arrêt. Si elle échoue, rien n'est enregistré.
- Durée : 300 s par défaut, 600 s au plus ; arrêt automatique.
- Les pistes sont écrites dans un dossier temporaire du pod, lues en mémoire à l'arrêt, puis effacées.
- Une piste Ogg/Opus par personne, sans transcodage. Le silence n'est pas émis par Discord : il est absent du fichier.

## API

| Méthode | Rôle |
| --- | --- |
| `await bc.recorder.start({ channelId, announceChannelId, consentUserIds, maxSeconds? })` | Rejoint, annonce, enregistre. Renvoie `{ id, channelId }`. |
| `bc.recorder.consent(userId, true \| false)` | Ajoute ou retire le consentement ; retirer coupe l'écoute immédiatement. |
| `bc.recorder.status()` | `{ active, id, channelId, startedAt, consentUserIds, recordingUserIds }`. |
| `await bc.recorder.stop()` | Arrête et renvoie `{ id, durationMs, reason, tracks: [{ userId, name, bytes, file }] }`. |

```js
// /rec start : enregistre le salon vocal de l'auteur, avec son consentement (cette commande vaut consentement)
const channelId = member.voice?.channelId;
if (!channelId) return interaction.reply({ content: 'Join a voice channel first.', ephemeral: true });
await bc.recorder.start({ channelId, announceChannelId: interaction.channelId, consentUserIds: [interaction.user.id], maxSeconds: 120 });
await interaction.reply({ content: 'Recording. Use /rec stop to finish.', ephemeral: true });
```

```js
// /rec stop : renvoie les pistes en pièces jointes
await interaction.deferReply();
const result = await bc.recorder.stop();
await interaction.editReply({ content: `${result.tracks.length} track(s), ${Math.round(result.durationMs / 1000)} s`, files: result.tracks.map((t) => t.file) });
```
