# Fichiers des bots (`bc.files`)

Un bot lit et écrit des fichiers dans le stockage de son propriétaire (quota du compte : formule + packs de stockage). Les
fichiers sont **propres à chaque bot** : un chemin n'est visible que du bot qui l'a écrit. Un fichier fait 25 Mo au plus.

- `await bc.files.put(path, data, { contentType?, encoding? })` : écrit ou remplace. `data` est un texte ou des octets ;
  `encoding: 'base64'` décode un texte base64.
- `await bc.files.get(path)` (octets) / `bc.files.getText(path, { encoding? })`.
- `await bc.files.list(prefix?, { limit?, after? })` : `[{ path, size, contentType, updatedAt }]`.
- `await bc.files.delete(path)` : vrai si le fichier existait.
- `await bc.files.exists(path)`.
- `await bc.files.url(path, { minutes? })` : lien de lecture temporaire (1 h par défaut, 7 jours au plus). Les images, l'audio,
  la vidéo, le texte brut et le PDF s'ouvrent dans le navigateur, le reste se télécharge.

Une opération qui échoue rejette avec une erreur dont `code` vaut `file_not_found`, `file_too_large`,
`file_quota_exceeded`, `file_invalid_path` ou `files_unavailable` (runner self-hosted : pas de Manager). `bc.files.lastError()`
rend le dernier code. Mêmes codes que `$fileUpload`, `$fileRead`, `$fileList`, `$fileDelete`, `$fileExists`, `$fileURL` en BDFD.

Un chemin est fait de segments séparés par `/` (255 octets au plus), sans `..`, sans segment vide, sans `/` initial ou final.
