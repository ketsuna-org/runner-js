# Observabilité des appels REST vers Discord

Contexte : le 2026-10-19, Discord a bloqué l'IP de sortie de la plateforme (limite de **10 000 réponses
invalides par 10 minutes et par IP** ; sont invalides les 401, 403 et 429, sauf les 429 dont
`X-RateLimit-Scope` vaut `shared`). Le déclencheur n'a jamais pu être attribué : aucun compteur de
requêtes sortantes n'existait. Ce document dit ce que mesure désormais runner-js, ce qui n'est pas
mesuré, et (partie 3) ce que permet nyxx pour faire pareil côté runner Dart.

## 1. Ce que mesure runner-js

Les compteurs appartiennent au **bot**, pas au client discord.js (`DiscordRestStats`, tenu par
`BotSupervisor`) : le runner est recréé à chaque démarrage, un bot qui boucle sur ses redémarrages ne
remet donc pas ses compteurs à zéro. Ils vivent tant que le processus du runner vit.

### Lignes de journal (niveau `warn`, donc recopiées sur stdout : visibles avec `kubectl logs`)

```
Discord REST invalid_request_warning bot=<id> process_count=250 window_remaining_s=598 bot_invalid_10m=212 by_status=401:0,403:200,429:12 top=POST /channels/:id/messages 403:200;...
Discord REST rate_limited bot=<id> method=POST route=/channels/:id/messages global=false scope=user retry_after_ms=1200
Discord REST invalid_request_warning lines suppressed bot=<id>: more than 6 per minute, counters keep counting (discordRest in /status)
```

- `invalid_request_warning` : discord.js l'émet toutes les **250** réponses invalides
  (`rest.invalidRequestWarningInterval`, 0 = désactivé par défaut avant ce changement). **Son compteur
  (`process_count`) est global au processus** (variable de module de `@discordjs/rest`, partagée par tous les
  clients REST, y compris `discordRest(token)` qui n'a pas l'option) : c'est une alarme grossière. Le compte
  du bot est `bot_invalid_10m`. Sur un pool JS (1 bot = 1 pod), processus et bot coïncident.
- `rate_limited` : **n'est pas un compteur de 429**. discord.js ne l'émet que lorsqu'il met une requête en
  attente d'une limite déjà connue. Un 429 inattendu, et surtout un 429 de blocage Cloudflare (sans en-têtes
  `X-RateLimit-*`), ne l'émet pas. Il est normal pour un bot actif ; il est journalisé à titre informatif.
- Plafond : 6 lignes par minute, par bot et par type d'événement ; la 7e est remplacée par la ligne
  « suppressed » (une seule), les suivantes sont tues. Les compteurs restent exacts.
- Aucune ligne ne contient d'URL, de jeton ni d'identifiant : la route est normalisée (`:id`, `:token`).

### Compteurs (JSON)

`GET /status`, `GET /metrics` et `GET /bots/:id/status` (donc aussi `GET /gateway/metrics` du Manager)
portent `discordRest` pour chaque bot :

| Champ | Sens |
| --- | --- |
| `invalid.window10m` | réponses invalides des 10 dernières minutes, à comparer aux 10 000 de Discord |
| `invalid.byStatus` | idem, par statut (`401`, `403`, `429`) |
| `invalid.total` | depuis le démarrage du runner |
| `invalid.sharedRateLimited` | 429 de scope `shared` (vus, non comptés par Discord) |
| `invalid.topRoutes` | routes (méthode + chemin normalisé) et statut qui consomment le budget |
| `invalidRequestWarnings`, `lastInvalidRequestWarningAt` | alarmes de discord.js reçues |
| `rateLimited`, `lastRateLimitedAt` | événements `rateLimited` (attentes locales, voir plus haut) |

Les réponses sont comptées dans le transport REST du client (`createGuardedMakeRequest`), qui voit chaque
statut. On n'écoute **pas** l'événement `response` de `@discordjs/rest` : il clone chaque réponse
(`res.clone()`), ce qui change le comportement mémoire.

### Ce qui n'est pas compté

- `discordRest(token)` (retrait de commandes Discord, `command-registerer.ts`) : client REST séparé, sans
  compteur ; rare (changement de configuration).
- Les `fetch` du processus qui ne passent pas par discord.js : seule la lecture de `GET /applications/@me`
  au démarrage et à chaque rechargement est comptée (`application-intent-sync.ts`) ; elle est la principale
  source de rafale au redémarrage d'un pool.
- Le trafic WebSocket de la passerelle (hors REST, hors budget).
- Les autres composants : le Manager (`discord_outbound_requests_total`, ligne `invalid_budget_warning`) et
  le runner Dart (partie 3). **Le budget est par IP** : il faut additionner tous les composants qui
  partagent l'IP de sortie.

## 2. Retrouver qui a consommé le budget

Voir le récit de bout en bout dans la description de la PR (ligne de log, métrique, commande `kubectl`).

## 3. Runner Dart : état des lieux de nyxx (sans code)

Version : `nyxx 6.9.0+1` (`pubspec.lock`), sources lues dans `~/.pub-cache/hosted/pub.dev/nyxx-6.9.0+1/lib/src/`.
Fichiers côté dépôt `ketsuna-org/bot-creator` : `packages/shared/lib/engine/bot_session.dart`,
`packages/shared/lib/utils/application_intent_sync.dart`, `packages/runner/lib/discord_runner.dart`,
`packages/runner/bin/runner.dart`.

### 3.1 Ce que nyxx permet d'observer

- `NyxxRest.httpHandler` (`client.dart`, `late final HttpHandler`) expose trois flux broadcast :
  - `onResponse : Stream<HttpResponse>` : **chaque** réponse, erreurs et 429 compris, **y compris les
    nouvelles tentatives** après un 429 (la doc du flux le dit). `HttpResponse` porte `statusCode`, `headers`
    (donc `x-ratelimit-scope`), `request.method` et `request.route.path` (le chemin contient les identifiants :
    à normaliser avant de journaliser, `HttpRoute.rateLimitId` n'est pas utilisable tel quel).
  - `onRateLimit : Stream<RateLimitInfo>` : `{request, delay, isGlobal, isAnticipated}` ; `isAnticipated` vrai =
    attente locale avant envoi, faux = un 429 reçu.
  - `onRequest : Stream<HttpRequest>` : avant l'envoi.
- `NyxxPlugin.interceptRequest(client, request, next)` enveloppe `execute`, donc ne voit que la réponse
  **finale** d'une requête (les 429 intermédiaires, retentés en interne, lui échappent) et n'est actif
  qu'une fois la connexion établie (`_states[client]` est posé après `connect()`).
- `GatewayClientOptions(loggerName:, rateLimitWarningThreshold:)` : par défaut `loggerName = 'Nyxx'` pour
  **tous** les bots du processus et `rateLimitWarningThreshold = 10 s`.

### 3.2 Ce que nyxx fait des 429 (et des blocages)

- `HttpHandler._handle` : sur un 429 il lit `retry_after` (`as double`) et `global` dans le corps JSON, attend
  `retry_after` (sans plafond ni notion de budget) puis **renvoie la même requête** : chaque tentative est une
  réponse invalide de plus pour Discord. Il ne connaît pas le scope `shared` et n'a aucune limite de nouvelles
  tentatives.
- Si le corps n'a pas `retry_after` numérique (cast `as double` : `TypeError`), il journalise
  `logger.shout('Invalid rate limit body for <METHOD> <route>! Your client is probably cloudflare banned!')`
  puis rend la réponse en erreur, que l'appelant lève. **Ce `shout` est la seule détection de blocage qui
  existe**, sur le logger `Nyxx.Http`, donc **sans identifiant de bot** : le runner Dart écrit
  `[SHOUT] Nyxx.Http: ...` (`runner.dart:136`, `Logger.root.onRecord`), alors que les lignes du bot portent
  le logger `bot:<id>`.
- Le texte rapporté par Pedro (`... exceeding global rate limits ... (0) GET https://discord.com/api/v10/applications/@me`)
  est exactement `HttpResponseError.toString()` = `"<message> (<errorCode>) <méthode> <url>"`. On en déduit
  (inféré depuis les sources, non vérifié sur une réponse réelle) que la réponse de blocage est un JSON
  `{"message": "You are being blocked ...", "code": 0}` **sans `retry_after`**, c'est-à-dire un corps que la
  détection de runner-js et du Manager (texte `you are being blocked`) reconnaît bien.

### 3.3 Les requêtes REST d'un démarrage Dart, et ce qu'on n'en voit pas

Un démarrage (`BotSession.start`) émet, dans cet ordre :

1. `GET /applications/@me` brut (`application_intent_sync.dart:197`, `package:http`, hors nyxx), jusqu'à
   4 tentatives dans un budget de 13 s ; refait à chaque `reload()` (`bot_session.dart:476`).
2. Dans `Nyxx.connectGateway` (`client.dart`, avant que le client soit rendu) : `GET /applications/@me`
   (`fetchCurrentApplication`), `GET /users/@me` (`fetchCurrentUser`), `GET /gateway/bot` (`fetchGatewayBot`).
   **C'est le `GET /applications/@me` du message de Pedro.**
3. Après connexion : `GET /applications/@me` encore (`bot_session.dart:394`, dans un `try/catch` muet).

Soit au moins **5 requêtes REST par démarrage**, 3 d'entre elles avant que le client existe : un abonnement à
`httpHandler.onResponse` posé après `connectGateway` les rate, comme `interceptRequest`. Elles ne sont
observables que par l'exception levée par `connectGateway` (un `HttpResponseError` porte `statusCode`).

### 3.4 Proposition la plus petite (à faire dans un lot Dart séparé, pas dans cette PR)

Dans `bot_session.dart`, sans nouvelle dépendance :

1. Un petit compteur par session (statuts 401/403/429, hors 429 `shared`, fenêtre glissante de 10 minutes, mêmes
   seuils que runner-js : alerte tous les 250), dans `packages/shared`.
2. Juste après `Nyxx.connectGateway`, s'abonner à `_gateway!.httpHandler.onResponse` et alimenter le compteur ;
   l'abonnement va dans `_subscriptions` (déjà annulé par `stop()`). Route normalisée avant tout journal.
3. Dans le `catch` de `start()` (`bot_session.dart:445`), si l'erreur est un `HttpResponseError`, compter son
   `statusCode` : c'est la seule trace des appels faits pendant `connectGateway`.
4. Même compteur alimenté dans `_fetchApplicationFlagsOnce` (`application_intent_sync.dart`) pour la lecture brute.
5. Une ligne `callbacks.onLog` (donc logger `bot:<id>`) du même format que runner-js
   (`Discord REST invalid_request_warning bot=<id> ...`), et le compteur dans le JSON de `/metrics` du runner
   (`web_bootstrap_server.dart`, `_handleMetrics`), à côté de `BotRuntimeMetrics`.
6. Optionnel et distinct : `GatewayClientOptions(loggerName: 'bot:$botId')` donnerait un identifiant au
   `shout` de nyxx, mais `runner.dart:136` déduit le bot de `loggerName.substring(4)` : il faudrait couper au
   premier `.` (les logs de nyxx s'appellent `<loggerName>.Http`).

`bot_session.dart` est partagé avec l'application Flutter : la ligne de journal y passe par `callbacks.onLog`
comme les autres, aucun changement de comportement.
