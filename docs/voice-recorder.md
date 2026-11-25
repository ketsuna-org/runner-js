# Enregistrement vocal (`bc.recorder`)

Étude : `DESIGN-flux-vocal.md` du projet (annexes 2 à 6). Réception du flux vocal (DAVE) pour les bots JavaScript.

## Mise en production : deux interrupteurs, tous deux coupés par défaut

1. **Runner** : `VOICE_RECORDER_ENABLED=1` dans l'environnement du runner. Sans lui, `bc.recorder` refuse tout. `VOICE_RECORDER_DISABLED=1` est un coupe-circuit qui l'emporte.
2. **Manager** : `VOICE_RECORDER_ENABLED=true` dans l'environnement du Manager. Sans lui, il refuse toute réservation (`voice_recorder_disabled`).

Sur un runner **géré** (Manager), le Manager décide : **Premium seulement**, **20 h par mois et par compte** (`VOICE_RECORDER_MONTHLY_SECONDS`, 72000 s), **2 enregistrements simultanés par compte**, 600 s au plus par session. Le runner réserve la durée AVANT de rejoindre le salon et rapporte la durée réelle à l'arrêt ; une session jamais clôturée (runner tombé) compte pour sa durée réservée. **Un Manager injoignable = rien n'est enregistré** (échec fermé). Un runner **sans Manager** (self-host, runner embarqué du desktop) n'a ni Premium ni quota : l'opérateur de la machine en est responsable ; pour l'app desktop le runner embarqué n'active pas l'enregistrement.

### Au dépassement du quota

- Quota restant plus court que la durée demandée : l'enregistrement démarre avec la durée restante (`start()` renvoie `maxSeconds` et `quotaLimited: true`, l'annonce le dit) et s'arrête seul à l'échéance (`reason: 'quota'` dans le résultat de `stop()`). Il ne dépasse jamais le quota.
- Quota épuisé : `start()` est refusé avant toute connexion vocale ni annonce (« The monthly voice recording quota of this account is used up. It resets on the 1st of the month (UTC). »). Compte sans Premium : « Voice recording needs a Premium subscription… ». Trop de sessions : « …maximum number of voice recordings running. ». Les erreurs portent un `code` stable : `voice_recorder_quota_exceeded`, `voice_recorder_premium_required`, `voice_recorder_too_many_sessions`, `voice_recorder_disabled`, `voice_recorder_unavailable`.
- `await bc.recorder.quota()` : `{ premium, monthlySeconds, usedSeconds, remainingSeconds, resetsAt }`, ou `null` sans Manager.

Le bot doit avoir l'intent **Guild Voice States** et la permission de rejoindre le salon. Un serveur ne
supporte qu'une connexion vocale par bot : refus si le bot est déjà dans un salon (musique Lavalink incluse).

## Consentement (permanent, par serveur, donné uniquement par la personne)

- Un script **ne peut pas** consentir à la place de quelqu'un. Le seul moyen : la personne appuie sur un bouton du
  message de `bc.recorder.consentPrompt(...)`. L'accord est mémorisé par serveur (date, langue, version du texte,
  empreinte du texte montré), valable **6 mois** (`VOICE_CONSENT_VALID_DAYS`, 0 = sans limite), et expire aussi
  quand le texte de référence change.
- `start()` n'enregistre que les personnes du salon qui ont un accord valide, et refuse si personne n'en a. Les
  autres ne sont jamais lues, même dans le salon. Retirer son accord (bouton « Withdraw ») coupe l'écoute tout de suite.
- Le message est en **anglais**, toujours affiché. Un propriétaire peut ajouter une **traduction complète**
  (tous les blocs obligatoires, sinon refus) : `consentPrompt(channelId, { locale: 'fr', texts: {...} })`. La
  traduction est mémorisée par serveur ; les confirmations des boutons s'affichent dans la langue Discord de la
  personne. Blocs : `title`, `purpose`, `retention`, `rights`, `external`, `accepted`, `withdrawn` ; libellés
  facultatifs : `accept`, `acceptExternal`, `withdraw` (80 caractères au plus).
- Le second bouton accorde en plus l'envoi à un service externe : `track.externalConsent`. Le moteur ne peut pas
  empêcher un script JS d'envoyer un fichier avec `fetch` : le script doit tester `track.externalConsent` avant
  tout envoi HTTP (le garde-fou automatique viendra avec `$httpAddFile`).

## Autres règles appliquées par le moteur

- Une annonce est postée dans `announceChannelId` au démarrage (liste des personnes enregistrées, avec un bouton « Withdraw my consent » : retrait en un clic) et à l'arrêt.
  Si elle échoue, rien n'est enregistré.
- Durée : 300 s par défaut, 600 s au plus ; 5 personnes au plus.
- Les pistes sont écrites dans un dossier temporaire du pod, lues en mémoire à l'arrêt, puis effacées.
- Une piste Ogg/Opus par personne, sans transcodage. Le silence n'est pas émis par Discord : il est absent du fichier.

## API

| Méthode | Rôle |
| --- | --- |
| `await bc.recorder.consentPrompt(channelId, { locale?, texts? })` | Poste le message de consentement (anglais, plus la traduction complète demandée) avec ses boutons. |
| `await bc.recorder.hasConsent(userId)` | Lecture seule : accord valide ou non. |
| `await bc.recorder.withdraw(userId)` | Retire l'accord : la personne elle-même, ou un membre qui a « Gérer le serveur ». |
| `await bc.recorder.start({ channelId, announceChannelId, maxSeconds? })` | Réserve la durée auprès du Manager, rejoint, annonce, enregistre. Renvoie `{ id, channelId, recordedUserIds, maxSeconds, quotaLimited }`. |
| `await bc.recorder.quota()` | Quota mensuel restant du compte (`null` sans Manager). |
| `bc.recorder.status()` | `{ active, id, channelId, startedAt, recordingUserIds }`. |
| `await bc.recorder.stop()` | Arrête et renvoie `{ id, durationMs, reason ('stopped' \| 'max-duration' \| 'quota' \| 'connection-lost'), tracks: [{ userId, name, bytes, externalConsent, file }] }`. |

```js
// /rec consent : poste le message de consentement dans le salon courant
await bc.recorder.consentPrompt(interaction.channelId);
await interaction.reply({ content: 'Consent message posted.', ephemeral: true });
```

```js
// /rec start : enregistre le salon vocal de l'auteur (les personnes consentantes seulement)
const channelId = member.voice?.channelId;
if (!channelId) return interaction.reply({ content: 'Join a voice channel first.', ephemeral: true });
const r = await bc.recorder.start({ channelId, announceChannelId: interaction.channelId, maxSeconds: 120 });
await interaction.reply({ content: `Recording ${r.recordedUserIds.length} person(s). Use /rec stop to finish.`, ephemeral: true });
```

```js
// /rec stop : renvoie les pistes en pièces jointes
await interaction.deferReply();
const result = await bc.recorder.stop();
await interaction.editReply({ content: `${result.tracks.length} track(s), ${Math.round(result.durationMs / 1000)} s`, files: result.tracks.map((t) => t.file) });
```

## Retrait sans commande ajoutée automatiquement

Le moteur n'ajoute AUCUNE commande à l'application du bot. Un propriétaire qui veut une commande de retrait écrit la sienne :

```js
// /recording-privacy : voir et retirer son propre accord (la personne seule peut retirer le sien)
const mine = await bc.recorder.hasConsent(interaction.user.id);
if (mine) await bc.recorder.withdraw(interaction.user.id);
await interaction.reply({ content: mine ? 'Your consent is withdrawn.' : 'You had no active consent.', ephemeral: true });
```
