# runner-js

Runner Bot Creator des bots Discord écrits en JavaScript (Bun, discord.js). Un bot par pod ; une API HTTP
(`/health`, `/bots/...`) que pilotent le Manager et l'application.

## Documentation

- [docs/js-bot-config.md](docs/js-bot-config.md) : configuration d'un bot (préfixes, mention, commandes sans
  préfixe, fonctions `fn`, tâches planifiées et cron), ce que reçoivent les scripts, journaux et statut.
- [docs/runner-docker.md](docs/runner-docker.md) : image Docker, variables d'environnement, API, commandes hybrides.
- [docs/discord-rest-observability.md](docs/discord-rest-observability.md) : compteurs des appels REST vers Discord.
- [docs/music.md](docs/music.md) : musique Lavalink (Premium) et objet `voice` des scripts.

## Développement

```bash
bun install --frozen-lockfile
bun test
bunx tsc --noEmit
docker build -t bot-creator-runner-js .
```

Le `Dockerfile` installe avec `--frozen-lockfile` et lance `bun test` : toute nouvelle dépendance doit régénérer
`bun.lock`.
