# Configuration d'un bot JavaScript (runner-js)

Ce document décrit la configuration JSON qu'accepte runner-js (`POST /bots/sync`, `POST /bots/:id/reload`)
et le comportement **réellement livré** pour les messages (préfixes, mention, sans préfixe), les fonctions
JavaScript (`fn`) et les tâches planifiées. Sources de vérité :

- schéma : `src/config/js-bot-config.ts` ;
- messages : `src/discord/message-invocation.ts`, `src/discord/handler-registry.ts` ;
- fonctions : `src/scripts/script-functions.ts` ;
- planificateur : `src/runtime/scheduled-tasks.ts`, `src/runtime/cron-expression.ts`.

Les déploiements (Docker, variables d'environnement, API HTTP) sont dans [runner-docker.md](runner-docker.md).

## 1. Principes

- **Tout champ ajouté est optionnel** et son défaut reproduit le comportement antérieur : aucune migration.
- **Les clés inconnues sont supprimées** au chargement, à la racine comme dans chaque commande, événement, tâche ou
  webhook (seuls `data`, `options`, `globalVariables`, `scopedVariableDefinitions` et les entrées de `jsFunctions`
  gardent des clés libres). Un client qui écrit un champ absent de ce document le perd.
- **Les champs récents sont tolérants.** Absent ou `null` = non défini. Une valeur du mauvais type est ignorée,
  avec un avertissement `[js-bot-config] <champ> ignoré : valeur de type <type> non valide` écrit sur la console
  du processus du runner (pas dans le journal du bot), et **le reste de la configuration est chargé**. Cela
  vaut pour `prefixes`, `prefixVariable`, `prefixVariableScope`, `allowNoPrefixCommands`, `mentionAsPrefix`,
  `jsFunctions`, `commands[].noPrefix` et, dans `scheduled[]`, `everyMinutes`, `cron`, `timezone`,
  `runOnStart`, `timeoutMs`.
- **Ce qui rejette toujours la configuration entière** (inchangé) : un `triggerType` hors de
  `prefix | slash | hybrid | none`, un nom de commande vide ou de plus de 32 caractères, deux commandes de même
  nom, deux handlers d'événement de même `id`, deux webhooks entrants de même chemin, un `scriptTimeoutMs`
  hors de 1 à 900 000. C'est pourquoi les nouveautés sont des **booléens orthogonaux** et non de nouvelles
  valeurs de `triggerType`.
- Deux entrées `scheduled` de même `id` ne sont **pas** une erreur : la seconde devient `id#2` (puis `id#3`…),
  avec un avertissement.

## 2. Champs de la racine

| Champ | Type | Défaut | Rôle |
| --- | --- | --- | --- |
| `token` | texte | `''` | Jeton Discord. Jamais visible des scripts. |
| `prefix` | texte | absent | Préfixe historique (voir §4.2). |
| `prefixes` | texte[] | absent | Préfixes supplémentaires : 5 au plus, de 1 à 5 caractères, sans espace (§4.2). |
| `prefixVariable` | texte | absent | Nom de la variable dont la valeur **remplace** les préfixes statiques d'un serveur (§4.3). |
| `prefixVariableScope` | `guild` \| `global` | `guild` | Portée de `prefixVariable`. `user` n'existe pas (la valeur est ignorée). |
| `mentionAsPrefix` | booléen | `false` | `@bot commande` se comporte comme un préfixe (§4.4). |
| `allowNoPrefixCommands` | booléen | `false` | Autorise les commandes marquées `noPrefix` (§4.5). |
| `jsFunctions` | objet[] | `[]` | Bibliothèque de fonctions appelables par `fn` (§5). Une liste, jamais une table nom vers définition. |
| `commands` | objet[] | `[]` | Commandes (§3). |
| `events` | objet[] | `[]` | Handlers d'événements Discord : `{id, name, script, enabled}`. |
| `scheduled` | objet[] | `[]` | Tâches planifiées (§6). |
| `inboundWebhooks` | objet[] | `[]` | Webhooks entrants : `{id, path, secret, script, enabled}`. |
| `autoRestart` | booléen | `true` | Redémarrage automatique du bot après une sortie imprévue. |
| `presence` | objet | absent | Statut et activités du bot. |
| `databaseConfig` | objet | `{type: 'none'}` | Base SQL/Mongo du bot (les scripts n'en voient que le `type`). |
| `globalVariables` | objet | `{}` | Variables globales de la configuration (les valeurs enregistrées par les scripts les surchargent). |
| `scopedVariableDefinitions` | objet[] | `[]` | Définitions des variables par portée (`scope`, `key`, `defaultValue`). |
| `scriptTimeoutMs` | entier | `900000` | Durée maximale d'un script, de 1 à 900 000 ms (15 minutes). |
| `intents` | objet | `{}` | Conservé mais **non lu** : les intents sont calculés (§4.8). |

Exemple complet (les scripts sont détaillés plus bas) :

```json
{
  "token": "<jeton>",
  "prefix": "!",
  "prefixes": ["?", "!!"],
  "prefixVariable": "prefix",
  "prefixVariableScope": "guild",
  "mentionAsPrefix": true,
  "allowNoPrefixCommands": true,
  "commands": [
    {
      "id": "c1", "name": "ping", "triggerType": "hybrid", "aliases": ["p"], "noPrefix": true,
      "script": "await (message ?? interaction).reply('pong');"
    }
  ],
  "jsFunctions": [
    { "id": "f1", "name": "double", "params": ["n"], "script": "return n * 2;" }
  ],
  "scheduled": [
    { "id": "s1", "cron": "0 9 * * 1-5", "timezone": "Europe/Paris", "script": "console.log('bonjour');" }
  ]
}
```

## 3. Commandes : type de déclencheur et mots déclencheurs

| Champ | Rôle |
| --- | --- |
| `id`, `name` | Identifiant ; nom de 1 à 32 caractères, unique sans tenir compte de la casse. |
| `triggerType` | `prefix`, `slash`, `hybrid` ou `none`. |
| `prefixName` | Mot déclencheur textuel quand il diffère du nom. |
| `aliases` | Autres mots déclencheurs textuels. |
| `noPrefix` | Booléen, défaut `false` : la commande répond aussi sans préfixe (§4.5). |
| `defaultMemberPermissions` | Champ de bits Discord (texte ou nombre) : permission requise des membres. |
| `enabled` | `false` = commande ignorée par toutes les routes. |
| `script` | Corps d'une fonction asynchrone (voir §4.6 pour ce qu'il reçoit). |
| `data` | Objet libre. Lu en priorité par les champs `legacy*`, `noPrefix` et `defaultMemberPermissions`. |

**Résolution du type** quand `triggerType` est absent : `data.triggerType`, sinon `legacyModeEnabled: true` donne
`prefix`, `legacyLocalOnly: true` (ou `data.localOnly`) donne `none`, `legacyModeEnabled: false` donne `slash`,
sinon `hybrid`.

| `triggerType` | Slash | Préfixe | Mention | Sans préfixe |
| --- | --- | --- | --- | --- |
| `prefix` | non | oui | oui | si `noPrefix` |
| `hybrid` | oui | oui | oui | si `noPrefix` |
| `slash` | oui | non | non | non |
| `none` | non | non | non | non |

**Mots déclencheurs** (les mêmes pour les trois routes de message) : `prefixName`, sinon
`data.legacyPrefixOverride`, sinon `legacyPrefixOverride`, sinon le nom ; puis les alias (`aliases`, sinon
`legacyAliases`, sinon `data.legacyAliases`). Quand `prefixName` est défini, **le nom n'est plus un déclencheur
textuel**. Tout est mis en minuscules. En cas de collision, le mot principal d'une commande l'emporte sur l'alias
d'une autre, quel que soit l'ordre ; entre deux alias, le premier déclaré gagne.

`noPrefix` se lit `data.noPrefix` s'il est booléen, sinon la racine de la commande. Les commandes slash et
hybrides sont publiées chez Discord par le Manager ou l'application, jamais par ce runner.

## 4. Messages : préfixes, mention, sans préfixe

### 4.1 Ordre d'évaluation

Seul `messageCreate` déclenche des commandes : **un message modifié ne déclenche rien**. Sont ignorés d'emblée :
auteur bot, webhook, message système, contenu vide. S'il n'y a aucune commande `prefix` ou `hybrid` active, rien
n'est analysé (pas même la lecture de la variable de préfixe).

Le contenu est analysé dans cet ordre, **sans repli d'une route sur l'autre** :

1. **préfixe** : le message commence par un préfixe effectif ;
2. **mention** : sinon, si `mentionAsPrefix`, le message commence par `<@idBot>` ou `<@!idBot>` ;
3. **sans préfixe** : sinon, si les conditions de §4.5 sont réunies, le premier mot est un nom de commande.

Un message préfixé n'est donc jugé que comme tel, même si le mot suivant n'est pas une commande. Dans tous les
cas : les espaces de tête sont ignorés, le premier mot (jusqu'au prochain blanc) est le nom, mis en minuscules,
et le reste est découpé en arguments. `! ping` (préfixe puis espace) est accepté comme `!ping`. `!` seul ne
fait rien.

### 4.2 Préfixes statiques

Liste effective = `prefix` puis `prefixes`, sans doublon, **les plus longs d'abord** : avec `!` et `!!`, le
message `!!ping` utilise `!!`. La comparaison est sensible à la casse et **sans repli** : avec le seul préfixe `!`,
`!!ping` donne le nom `!ping`.

- `prefix` garde sa lecture historique : rogné, non vide, sans limite de longueur.
- Chaque entrée de `prefixes` doit faire de 1 à 5 **points de code** (un emoji vaut 1) et ne contenir ni espace
  ni saut de ligne ; les entrées invalides sont écartées, sans rejeter la configuration. 5 entrées valides au plus.
- **Repli `!`** : sans aucun préfixe configuré, `!` s'applique dès qu'une commande activée est explicitement
  `prefix` ou `hybrid`. Il ne s'applique pas si seules des commandes sans `triggerType` existent. `prefix: ''` avec
  `prefixes: ['?']` donne `['?']`, pas `['?', '!']`.

### 4.3 Variable de préfixe

`prefixVariable` désigne une variable (avec ou sans `bc_`) dont la valeur **remplace** la liste statique pour le
serveur, comme dans BDFD. Portée `guild` (défaut) ou `global`.

- Valeur : préfixes séparés par des espaces ou des virgules (`! ?` ou `!,?`). Assainie : 5 entrées au plus,
  de 1 à 5 points de code, sans espace, sans doublon ; une valeur de plus de 256 caractères ou qui n'est pas du
  texte est ignorée.
- **Valeur vide, absente, illisible, ou message privé : la liste statique s'applique.** Une valeur valide
  remplace la liste : si le serveur fixe `?`, `!` ne répond plus sur ce serveur.
- Lecture pour la portée `guild` : la valeur stockée (clé nue, puis `bc_`), sinon le `defaultValue` de la définition
  `scopedVariableDefinitions` de portée `guild`. Pour `global` : `globalVariables` de la configuration, surchargées
  par les variables globales enregistrées. Un DM n'a pas de serveur : liste statique, même en portée `global`.
- Cache de 30 secondes par serveur (5 secondes après un échec de lecture), vidé au rechargement et **tout de
  suite quand un script du bot écrit, supprime ou renomme la variable** (`db.guild.set`, `db.global.set`…). Une
  modification faite ailleurs (écran Variables de l'application, API) est prise en compte en 30 secondes au plus.
- Un échec de lecture est journalisé en `warn` (`Prefix variable "<clé>" could not be read, using the static
  prefixes: <raison>`), jamais la valeur.

Exemple, commande `setprefix` :

```js
const value = (message.invocation.args[0] ?? '').trim();
if (!value) { await message.reply('Usage : setprefix <préfixe>'); return; }
await db.guild.set('prefix', value);
await message.reply('Préfixe : ' + value);
```

Avec `"prefixVariable": "prefix"`, `!setprefix ?` fait répondre le serveur à `?ping` aussitôt. Une valeur invalide
(`trop-long`) est stockée mais ignorée : la liste statique continue de servir. Activez `mentionAsPrefix`
pour garder un moyen de reprendre la main si un serveur choisit un préfixe qu'il oublie.

### 4.4 La mention sert de préfixe (`mentionAsPrefix`)

Réglage **du bot** (pas de la commande). Quand il est vrai, un message qui **commence** par `<@idBot>` ou
`<@!idBot>`, suivi d'un blanc, se comporte comme s'il commençait par un préfixe : le premier mot est le nom
(ou l'alias, ou le `prefixName`) d'une commande `prefix` ou `hybrid`, exactement comme avec `!`.

```text
@Bot ping            -> commande ping       (source "mention")
@Bot ban @Alice spam -> commande ban, arguments ["<@123456789>", "spam"]
```

- Marche **sans préfixe configuré**, avec ou sans variable de préfixe, en serveur et en fil. Comme un préfixe,
  elle n'exclut pas les messages privés que le runner reçoit.
- Ne déclenche **jamais** : `@Bot` seul (ou suivi d'espaces), une mention de rôle `<@&…>`, `@everyone`, `@here`, la
  mention d'un autre utilisateur, un reply-ping, une mention qui n'est pas en tête, une mention collée au mot
  suivant (`<@id>ping`). Un préfixe valide l'emporte sur la mention.
- Sur cette route, `message.mentions.users` et `message.mentions.members` **excluent le bot** : la mention
  d'en-tête n'est qu'un déclencheur, `mentions.users.first()` est le premier utilisateur réellement visé.
  Le reste de `message.mentions` est inchangé, et `message.content` reste le texte brut, mention comprise. Sur
  les routes préfixe et sans préfixe, `message.mentions` est celui de Discord, bot compris s'il est mentionné.
- Les commandes `slash` et `none` ne sont jamais atteintes par la mention.

### 4.5 Commandes sans préfixe (`noPrefix`)

Double opt-in : le bot active `allowNoPrefixCommands`, et la commande porte `noPrefix: true`. Conditions
**toutes** nécessaires :

- la commande est activée et de type `prefix` ou `hybrid` ;
- le message vient d'un **serveur** (pas de message privé) et d'un utilisateur (jamais bot, webhook, système) ;
- l'intent **Message Content est réellement actif** sur la connexion (demandé par la configuration **et**
  approuvé au portail Discord). Sinon les commandes `noPrefix` sont ignorées avec **un seul** avertissement
  (`Ignoring no-prefix commands: …`) ; le préfixe et la mention continuent de marcher.

Le premier mot du message doit être exactement un mot déclencheur de la commande (nom, `prefixName`, alias,
sans tenir compte de la casse). Un message qui commence par un préfixe ou par la mention passe par ces routes-là.

Garde-fous (un message ordinaire qui s'écrit comme une commande l'exécute) :

- délai de **2 secondes** par couple (utilisateur, commande) ;
- au plus **50 exécutions par fenêtre de 10 secondes** pour le bot ; l'excédent est ignoré en silence, avec
  un avertissement par fenêtre (`No-prefix commands rate limited: …`). Les routes préfixe et mention ne sont
  pas limitées.

Choisissez des noms distinctifs : `help` ou `ok` se déclencheront dans une conversation normale.

### 4.6 Ce que reçoit le script

Les paramètres de portée sont toujours les mêmes : `client` (sans jeton), `config` (assainie), `variables`,
`interaction`, `message`, `member`, `guild`, `channel`, `webhook`, `db`, `sql`, `pgsql`, `mongo`, `console`,
`fetch`, `require`, `setTimeout`, `clearTimeout`, `fn`. Aucun paramètre n'est ajouté pour l'invocation : elle
se lit dans `message.invocation`.

| Déclenchement | `message` | `interaction` | `message.invocation` |
| --- | --- | --- | --- |
| Message préfixé, mention, sans préfixe | message Discord réel, `content` **brut** | `undefined` | présent |
| Commande slash pure | `undefined` | interaction réelle | sans objet |
| Commande hybride lancée en slash | objet de compatibilité (`isInteractionCompat === true`) | interaction réelle | **absent** |
| Handler `messageCreate` | message réel | `undefined` | absent |
| Handler `interactionCreate` | `undefined` | interaction réelle | sans objet |
| Tâche planifiée | `undefined` | `undefined` | sans objet |
| Webhook entrant | `undefined` | `undefined` | sans objet |

L'objet de compatibilité d'une commande hybride en slash ne porte ni `content`, ni `mentions`, ni
`delete()`, ni `edit()`. **Pour savoir si on tourne en slash, testez `interaction`, pas `message`.**

`message.invocation` :

| Champ | Valeur |
| --- | --- |
| `source` | `'prefix'`, `'mention'` ou `'noPrefix'` |
| `prefix` | le préfixe réellement utilisé ; `null` pour la mention et le sans-préfixe |
| `name` | le premier mot tapé, en minuscules (un alias ou le `prefixName`, pas forcément le nom de la commande) |
| `args` | les mots suivants, séparés par des blancs, casse conservée |
| `rawArgs` | tout ce qui suit le nom, rogné aux extrémités (espaces et retours à la ligne internes conservés) |

Lisez les arguments dans `message.invocation`, pas avec `message.content.split(' ')` ni `config.prefix` : ces
formes se trompent dès qu'on utilise la mention (`<@id> ping a` se découpe en `['<@id>', 'ping', 'a']`, et
`slice(1)` prend le nom de la commande pour un argument), plusieurs préfixes ou une variable de préfixe.

```js
// Commande hybride : le texte, quel que soit le déclencheur
const texte = interaction
  ? (interaction.options.getString('texte') ?? '')
  : message.invocation.rawArgs;
await (message ?? interaction).reply(texte || 'Rien à dire.');
```

Dans tous les cas, `guild`, `member` (avec des `permissions` utilisables) et `channel` sont résolus, depuis le
cache sinon par une requête.

### 4.7 Permission par défaut du membre

`defaultMemberPermissions` (`data.defaultMemberPermissions`, sinon la racine de la commande) est vérifiée sur les
routes **mention** et **sans préfixe**, pour qu'une commande réservée aux administrateurs ne devienne pas
exécutable par tous en tapant `@Bot ban …` ou `ban …`.

- Absente ou vide : commande ouverte. `"0"` : administrateurs seulement. Une valeur illisible ou négative est
  traitée comme `"0"`. Le droit Administrateur implique tout.
- Membre non résolvable (message privé) : refus.
- Refus **silencieux** : aucune réponse, une ligne `debug` dans le journal du bot
  (`Command <nom> refused for user <id>: missing default member permissions (<route> route)`).
- **La route préfixe n'effectue pas ce contrôle** (comportement historique inchangé) : une commande sensible doit
  vérifier `member.permissions` dans son script.

### 4.8 Intents

Les intents non privilégiés (dont Guild Messages et Direct Messages) sont toujours actifs. **Message Content**
(privilégié) n'est actif que s'il est demandé **et** approuvé au portail. Il est demandé quand : un préfixe
statique est effectif (repli `!` compris), une `prefixVariable` est définie, ou un handler `messageCreate` /
`messageUpdate` existe. `mentionAsPrefix` seul ne le demande pas : pour les messages qui mentionnent le bot,
Discord fournit le contenu même sans cet intent. `allowNoPrefixCommands` seul ne le demande pas non plus
(il faut un préfixe ou une variable de préfixe qui le fasse). En pratique, dès qu'une commande est explicitement
`prefix` ou `hybrid`, le repli `!` rend un préfixe effectif et Message Content est demandé, mention ou non ; une
configuration « mention seulement » sans Message Content suppose des commandes sans `triggerType` explicite.

### 4.9 Cumul avec un handler `messageCreate`

Un message qui déclenche une commande atteint aussi les handlers `messageCreate` de `events`, sauf cas particulier
hérité : le handler est masqué quand le message commence par le préfixe **unique** `prefix` (ou `!` par repli) et que
le mot suivant est le nom d'une commande slash ou hybride (le nom, pas un alias). Ce filtre n'a pas été étendu
(état figé par un test de caractérisation, `test/event-handlers.test.ts`) :

| Message | Commande | Handler `messageCreate` |
| --- | --- | --- |
| `!ping` (commande hybride) | oui | non |
| `!pfx` (commande `prefix` pure) | oui | oui |
| `?ping` quand `?` vient de `prefixes` ou de la variable (pas de `prefix`) | oui | oui |
| `@Bot ping` | oui | oui |
| `ping` (sans préfixe) | oui | oui |
| `bonjour` | non | oui |

Un handler et une commande qui répondent tous deux au même message peuvent donc répondre deux fois.

## 5. Fonctions JavaScript (`fn`)

`jsFunctions` est la bibliothèque du bot : une liste d'objets
`{id, name, description?, params[], script, enabled}`. Un script (commande, événement, webhook, tâche
planifiée, autocomplétion) appelle une fonction par `await fn.nom(a, b)`.

```json
"jsFunctions": [
  { "id": "f1", "name": "nomAffiche", "params": ["user"],
    "script": "return user?.displayName ?? user?.username ?? 'inconnu';" },
  { "id": "f2", "name": "dire", "params": ["texte"],
    "script": "await (message ?? interaction).reply(texte);\nreturn texte.length;" }
]
```

```js
const longueur = await fn.dire('Bonjour ' + await fn.nomAffiche(message.author));
```

**Validation** (au chargement, entrée par entrée) : une entrée invalide est **ignorée avec un avertissement** dans
le journal du bot, sans jamais empêcher les autres ni la configuration de se charger. Les avertissements ne
reproduisent jamais le corps (10 au plus, puis une ligne de résumé).

| Élément | Règle |
| --- | --- |
| `name` | `^[A-Za-z_$][A-Za-z0-9_$]{0,63}$`, pas un mot réservé de JavaScript, ni `__proto__`, `constructor`, `prototype`, `then`, `toString`, `valueOf`, `hasOwnProperty`. Unique sans tenir compte de la casse (la première occurrence est gardée). |
| `params` | 0 à 20 identifiants uniques, ni mot réservé, ni `arguments`, `eval`, `undefined`, `NaN`, `Infinity`, ni un nom de portée (`client`, `config`, `variables`, `interaction`, `message`, `member`, `guild`, `channel`, `webhook`, `db`, `sql`, `pgsql`, `mongo`, `console`, `fetch`, `require`, `setTimeout`, `clearTimeout`, `fn`). |
| `script` | Corps d'une fonction asynchrone, non vide, 65 536 caractères au plus. |
| Bibliothèque | 100 fonctions au plus et 512 Ko de corps cumulés (524 288 caractères). L'excédent est ignoré. |
| `enabled: false` | Fonction ignorée sans avertissement ; son nom reste libre. |

**Exécution**

- Appels toujours **asynchrones** (même pour un corps sans `await`). Les arguments se lient aux `params` dans
  l'ordre : un argument manquant vaut `undefined`, un argument en trop est ignoré. `return` donne la valeur.
- Le corps est compilé au premier appel. Une `SyntaxError` n'apparaît qu'à l'appel de cette fonction (avertissement
  une fois, puis erreur `Function x failed: …`), les autres fonctions marchent.
- Une fonction peut en appeler une autre. **Profondeur maximale : 10** (le script appelant est à 0), exacte même
  avec `Promise.all`. **5 000 appels au plus par exécution** de script.
- Après le **timeout du script**, tout nouvel appel `fn.x()` est rejeté : le script qui continue en arrière-plan
  ne lance plus de fonctions. Le timeout n'interrompt pas ce qui est déjà en cours.
- Erreurs : `Function x failed: <message>`, avec la cause d'origine dans `error.cause` ; une fonction inconnue lève
  `Unknown function x (disponibles : a, b)` (`aucune` s'il n'y en a pas).
- `fn` est en lecture seule ; `Object.keys(fn)` liste les fonctions actives ; `fn.then`, `fn.constructor`,
  `fn.__proto__` et les symboles valent `undefined` (donc `await fn` ne se bloque pas).
- Un script ou un corps qui déclare lui-même `const fn`, `let fn` ou `class fn` est recompilé **sans** le global
  (avertissement) : il garde sa propre liaison et n'a pas accès à la bibliothèque. `var fn` et `function fn`
  ne posent pas de problème.
- Cache de 500 corps compilés (le plus ancien est évincé). Un rechargement de la configuration remplace les
  corps à chaud.

**Contexte ambiant partagé.** Une fonction s'exécute dans la **même portée que son appelant** : mêmes
`interaction`, `message`, `guild`, `member`, `channel`, `db`, `variables`, `client`, `config`, `console` (qui écrit
dans le journal du bot), `fetch`, `require`, `setTimeout`. Une écriture dans `variables` est vue de l'appelant.
Dans une tâche planifiée ou un webhook entrant, `interaction` et `message` sont `undefined` dans la fonction aussi.

**Aucune isolation interne.** Une fonction a exactement les droits du script qui l'appelle (base de données,
`require`, réseau) ; la frontière de sécurité est le pod du bot, pas le runner. Ne mettez pas de secret dans un
corps : la configuration est lisible des scripts du bot (`config.jsFunctions` contient les corps). Le jeton, les
secrets des webhooks et les identifiants de base de données ne sont pas exposés.

## 6. Tâches planifiées (`scheduled`)

```json
"scheduled": [
  { "id": "matin",  "cron": "0 9 * * 1-5", "timezone": "Europe/Paris", "script": "…" },
  { "id": "quart",  "everyMinutes": 15, "script": "…" },
  { "id": "demarrage", "everyMinutes": 1440, "runOnStart": true, "timeoutMs": 30000, "script": "…" }
]
```

| Champ | Rôle |
| --- | --- |
| `id` | Identifiant de la tâche (obligatoire, unique ; un doublon devient `id#2`). |
| `name` | Nom du workflow d'éditeur dont la tâche porte le script (sert à la synchro d'un workflow). Facultatif. |
| `script` | Corps du script. `interaction` et `message` sont `undefined` ; `guild`, `member` et `channel` valent `null`. |
| `enabled` | `false` : tâche absente. Défaut `true`. |
| `everyMinutes` | Intervalle entier de 1 à 10 080 minutes. |
| `cron` | Expression à 5 champs ou macro (voir plus bas). **Prioritaire sur `everyMinutes`**, même si les deux sont présents. |
| `timezone` | Fuseau IANA du `cron` (`Europe/Paris`). UTC si absent. Sans effet pour `everyMinutes`. |
| `runOnStart` | `true` : un tir supplémentaire au démarrage du bot (voir plus bas). Défaut `false`. |
| `timeoutMs` | Durée maximale de cette tâche. Jamais supérieure à `scriptTimeoutMs`. |

Une entrée sans `cron` valide **ni** `everyMinutes` valide, ou au fuseau inconnu, est **ignorée avec un
avertissement** (`Scheduled task <id> ignored: <raison>`, une fois par raison) ; elle ne fait jamais rejeter la
configuration. Les entrées ignorées sont listées dans le statut (§7).

### Intervalles

`everyMinutes` est **ancré sur l'époque Unix, en UTC** : la tâche tire aux multiples de N minutes depuis le
1er janvier 1970, quels que soient l'heure de démarrage et le nombre de rechargements.

| `everyMinutes` | Tirs |
| --- | --- |
| `15` | `:00`, `:15`, `:30`, `:45` de chaque heure UTC |
| `60` | à chaque heure pile UTC |
| `1440` | tous les jours à 00:00 UTC |
| `10080` | **le jeudi** à 00:00 UTC (le 1er janvier 1970 était un jeudi) |
| `7` | toutes les 7 minutes depuis l'époque : pas alignées sur l'heure |

Changement de comportement : avant cette version, un intervalle partait N minutes après le montage de la
configuration, et un rechargement fréquent empêchait un long intervalle de jamais tirer. Pour une exécution à
une heure précise, utilisez `cron`.

### Expressions cron

5 champs (minute, heure, jour du mois, mois, jour de semaine) ou une macro `@hourly`, `@daily`, `@weekly`,
`@monthly`, `@yearly`. Listes (`1,15`), plages (`1-5`), pas (`*/5`, `15-45/15`), noms `JAN`–`DEC` et
`SUN`–`SAT` (sans tenir compte de la casse). Dimanche = `0` (jamais `7`). 100 caractères au plus, ASCII imprimable.

**Refusé** (même si la bibliothèque sous-jacente l'accepterait, pour qu'une configuration qui contourne le
Manager ne puisse pas tirer chaque seconde) : les secondes (6 ou 7 champs), `L`, `W`, `#`, `?`, `H`, `@reboot`,
`@annually`, `@midnight`, `@every …`, un pas sur une valeur seule (`5/15`), un pas nul, une plage inversée, un nom
complet (`MONDAY`). Le fuseau `Local` et les décalages (`UTC+2`) sont refusés.

Jour du mois **et** jour de semaine tous deux restreints (`0 0 13 * FRI`) : la tâche tire quand **l'un ou l'autre**
correspond (cron classique), donc chaque vendredi **et** le 13.

Heure d'été : un horaire local qui n'existe pas ou existe deux fois le jour du changement (`30 2 * * *`) tire
exactement **une fois** ce jour-là, jamais zéro ni deux. Une expression sans échéance (`0 0 30 2 *`) n'arme
rien et le signale une fois.

### Exécution

- **Pas de rattrapage** : une échéance manquée n'est jamais rejouée. Un réveil en retard de plus d'une minute
  (processus bloqué, machine suspendue) tire **une seule fois** et avertit.
- **Pas de chevauchement** d'une même tâche : si l'exécution précédente tourne encore, l'échéance est sautée.
- **3 exécutions simultanées au plus par bot** ; les suivantes sont sautées (`concurrency limit`). Une exécution
  compte **jusqu'à la fin réelle du script** : un timeout n'annule rien, le script continue et garde sa place, avec
  un avertissement. Un script synchrone qui boucle fige tout le processus : aucun timeout ne l'arrête.
- **Client non prêt** (connexion en cours ou reconnexion) : tir sauté (`client not ready`).
- Un saut avertit au premier d'une série puis tous les 10, le reste en `debug`.
- Il n'y a ni gigue ni plafond entre bots : les tâches `*/5` d'un même bot tirent à la même seconde.

### `runOnStart`

Un tir unique **après que le client est prêt, plus 5 secondes** (le temps de remplir le cache des serveurs). Il
n'est joué qu'**une fois par démarrage du bot** : recharger la configuration, modifier la planification de la
tâche ou reconnecter le client (changement d'intents) ne le rejoue pas ; arrêter puis redémarrer le bot, si
(redémarrage automatique compris), ainsi que retirer puis remettre la tâche (ou la désactiver puis la réactiver).

Contre la boucle de redémarrage (un script qui fige ou tue le processus), le runner pose avant le tir un
marqueur `<BOT_CREATOR_DATA_DIR>/run-state/scheduled-start/<botId>/<id>-<empreinte du script>.running`,
retiré à la fin du script ou à un arrêt volontaire. Au démarrage suivant, un marqueur de moins de 30 minutes
fait **sauter** le tir avec un avertissement (`runOnStart skipped, the previous startup run never finished`).
Modifier le script de la tâche change la clé et autorise un nouveau tir. Le tir est journalisé en `info` **avant**
l'exécution.

### Rechargement

Le planificateur vit au-dessus du registre de handlers : un rechargement de configuration (`updateConfig`),
une synchro d'un workflow ou une reconnexion pour changement d'intents ne remettent **rien à zéro**. La tâche est
comparée par signature (`cron`, fuseau, `everyMinutes`, `runOnStart`, `timeoutMs`) :

- signature inchangée : le minuteur est conservé, seul le script est remplacé (le tir suivant exécute le
  nouveau) ;
- signature modifiée : la tâche est ré-armée sur sa nouvelle planification ;
- tâche retirée ou désactivée : minuteur annulé. `stop()` du bot annule tout.

La synchro d'un workflow (`POST /bots/:id/workflows/sync`) ne remplace que le `script` des entrées dont `name` est ce
workflow : planification, fuseau, `runOnStart` et `timeoutMs` sont conservés, et le minuteur n'est pas ré-armé. Si le
workflow n'a plus de script, ces entrées sont retirées.

## 7. Journaux et statut

Le journal d'un bot (`GET /bots/:id/logs`, niveaux `debug` compris) reçoit ces lignes. Sur la sortie standard du
runner, seuls `warn` et `error` sont recopiés (20 lignes par minute et par bot au plus, le fichier garde tout).

| Niveau | Ligne |
| --- | --- |
| `debug` | `Scheduled task <id> ok in <N>ms` (un tir réussi n'apparaît donc pas sur la sortie standard) |
| `error` | `Scheduled task <id> (<planification>) failed after <N>ms: <erreur>` suivi de la pile |
| `warn` | `Scheduled task <id> skipped: still running \| client not ready \| concurrency limit` |
| `warn` | `Scheduled task <id> ignored: <raison>` ; `… has no upcoming run` ; `… woke up <N>s late …` ; `… timed out but its script is still running …` ; `… runOnStart skipped …` |
| `info` | `Scheduled task <id>: running once at startup (runOnStart)` |
| `warn` | `Ignoring no-prefix commands: …` ; `No-prefix commands rate limited: …` ; `Prefix variable "<clé>" could not be read …` |
| `debug` | `Command <nom> refused for user <id>: missing default member permissions (<route> route)` |

Les avertissements de configuration (`[js-bot-config] …`) vont sur la console du processus du runner.

`GET /bots/:id/status` d'un bot **en cours d'exécution** ajoute `bot.scheduled` (absent si le bot est arrêté ;
`/status` et `/bots/running-status` restent légers et ne le contiennent pas) :

```json
{
  "running": 0,
  "maxConcurrent": 3,
  "tasks": [
    {
      "id": "matin", "kind": "cron", "schedule": "cron \"0 9 * * 1-5\" (Europe/Paris)",
      "nextRunAt": "2026-10-22T07:00:00.000Z", "lastRunAt": null, "lastOk": null,
      "lastDurationMs": null, "lastError": null, "running": false, "runs": 0, "failures": 0,
      "skippedOverlap": 0, "skippedNotReady": 0, "skippedConcurrency": 0
    }
  ],
  "ignored": [{ "id": "casse", "reason": "no valid schedule (set a cron expression or everyMinutes between 1 and 10080)" }]
}
```

`kind` vaut `interval` ou `cron`. `running` (racine) compte aussi les scripts qui ont dépassé leur timeout sans
être terminés.

## 8. Compatibilité et retour en arrière

- Un runner **antérieur** supprime les clés qu'il ne connaît pas (`prefixes`, `prefixVariable`, `mentionAsPrefix`,
  `allowNoPrefixCommands`, `noPrefix`, `jsFunctions`, `cron`, `timezone`, `runOnStart`…) : ces fonctions deviennent
  inertes et `prefix` redevient le seul préfixe, sans erreur de configuration. `fn` n'y est pas défini
  (`ReferenceError` à l'appel).
- **Piège des tâches cron** : un runner antérieur exige `everyMinutes` sur chaque entrée `scheduled` et rejette la
  configuration **entière** du bot sinon. Tant qu'un runner antérieur peut recevoir la configuration (retour en
  arrière, déploiement en cours où des pods diffèrent), toute entrée `cron` doit donc aussi porter un `everyMinutes`
  de repli. Ce runner l'ignore quand `cron` est présent.
- **Avant un retour en arrière**, vérifier que chaque entrée `scheduled` porte `everyMinutes` ; après le retour, les
  intervalles redeviennent relatifs au montage de la configuration (voir §6) et un rechargement les remet à zéro.
