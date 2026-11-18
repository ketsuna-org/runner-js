# Sources WebSocket sortantes (runner-js)

Le runner JS ouvre les connexions WebSocket déclarées dans `webSocketSources` de la configuration du bot
(poussée par le Manager, avec le script du workflow de chaque source dans `script`). Mêmes règles et mêmes
limites que le runner Dart (voir `docs/websocket-sources.md` de bot-creator et `DESIGN-websocket.md`).

- Code : `src/runtime/websocket/` (`ws-source.ts` lecture tolérante, `ws-manager.ts` connexions, `ws-transport.ts` Bun + garde SSRF).
- Scripts : `bc.ws.join(source, contexte?)`, `bc.ws.send(source, message)`, `bc.ws.close(source)`, `bc.ws.status(source)`,
  `bc.ws.lastError()`. Une opération qui échoue rejette avec `error.code` = `ws_*` (mêmes codes que BDFD). Dans un workflow
  de source, l'événement est dans `bc.ws.event` (`source`, `event`, `message`, `json`, `payload('a.b')`, `context`,
  `reconnected`, `gapMs`, `closeCode`, `closeReason`, `error`).
- Secrets : jamais sur disque (`BotStore`), jamais visibles d'un script (`sanitizeConfigForScript`), jamais journalisés.
- Nœud hébergé (`BOT_CREATOR_POOL_MODE`) : l'hôte doit résoudre uniquement vers des adresses publiques, vérifié à chaque ouverture.
  Bun ne permet pas d'épingler l'adresse résolue : la fenêtre entre vérification et connexion reste celle d'un DNS rebinding à
  très court TTL (le runner Dart épingle l'adresse).
- Bun n'expose pas le statut HTTP d'un upgrade refusé : un 401/403 n'est reconnu que s'il figure dans le message d'erreur ;
  les fermetures 1008 et 4001–4003 comptent toujours comme refus d'authentification.
- État : `GET /bots/:id/websockets/live` (compteurs, jamais de secret ni de message).
