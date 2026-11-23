# Fichiers des bots (`bc.files`)

Un bot lit et écrit des fichiers dans le stockage de son propriétaire (quota du compte : formule + packs de stockage). Les
fichiers sont **propres à chaque bot** : un chemin n'est visible que du bot qui l'a écrit. Un fichier fait 25 Mo au plus.

- `await bc.files.put(path, data, { contentType?, encoding? })` : écrit ou remplace. `data` est un texte ou des octets ;
  `encoding: 'base64'` décode un texte base64.
- `await bc.files.get(path)` (octets) / `bc.files.getText(path, { encoding? })`.
- `await bc.files.list(prefix?, { limit?, after? })` : `[{ path, size, contentType, updatedAt }]`.
- `await bc.files.delete(path)` : vrai si le fichier existait.
- `await bc.files.exists(path)`.
- `await bc.files.attach(path, name?)` : pièce jointe (`$fileAttach`) à mettre dans `files: [...]` d'un message, comme `bc.canvas.attach`.
  10 Mo au plus (`file_too_large` au-delà) ; `name` par défaut la fin du chemin, `.bin` ajouté s'il n'a pas d'extension.
- `await bc.files.url(path, { minutes? })` : lien de lecture temporaire (1 h par défaut, 7 jours au plus). Les images, l'audio,
  la vidéo, le texte brut et le PDF s'ouvrent dans le navigateur, le reste se télécharge.

Une opération qui échoue rejette avec une erreur dont `code` vaut `file_not_found`, `file_too_large`,
`file_quota_exceeded`, `file_invalid_path` ou `files_unavailable` (runner self-hosted : pas de Manager). `bc.files.lastError()`
rend le dernier code. Mêmes codes que `$fileUpload`, `$fileRead`, `$fileList`, `$fileDelete`, `$fileExists`, `$fileURL` en BDFD.

Un chemin est fait de segments séparés par `/` (255 octets au plus), sans `..`, sans segment vide, sans `/` initial ou final.

## Bot local (desktop) et runner self-host

Sans Manager, si `BOT_CREATOR_LOCAL_FILES_DIR` est posé (l'application desktop le pose pour son runner intégré), les fichiers sont
écrits dans ce dossier, `<dossier>/<bot>/<chemin>`, avec les mêmes règles (chemin, 25 Mo) que sur le Manager, sans quota. Les noms
sont encodés (pourcentage) pour rester valides sur Windows ; le moteur Dart écrit au même endroit avec le même encodage.
`bc.files.url` rejette `file_url_unavailable` : un dossier local n'a pas de lien public.

Un runner self-host (sans Manager) active les fichiers par défaut, dans `<BOT_CREATOR_DATA_DIR>/.local-data/files` (le runner Dart
fait de même) ; `BOT_CREATOR_LOCAL_FILES_DIR` change le dossier.

## Base de données (`bc.db`) sans Manager

- **Runner self-host** : SQLite, un fichier par bot dans `<BOT_CREATOR_DATA_DIR>/.local-data/db/<bot>.sqlite` (`BOT_CREATOR_LOCAL_DB_DIR`
  change le dossier). Le moteur (`src/documents/local-documents.ts`) est un port de celui du runner Dart et de l'app : mêmes opérations,
  mêmes erreurs typées, même schéma de fichier. Les cas de conformance `test/fixtures/document-conformance.json` sont une copie de
  `packages/shared/test/fixtures/document_conformance.json` de bot-creator : à changer des deux côtés.
- **Runner embarqué dans l'app desktop** : l'app pose `BOT_CREATOR_LOCAL_DOCUMENTS_URL` et `BOT_CREATOR_LOCAL_DOCUMENTS_TOKEN` (serveur de
  boucle locale de l'app, mêmes routes `/bots/{id}/data/*` que le Manager). Un seul processus écrit dans la base du bot, donc l'écran
  Database de l'app est toujours à jour.
