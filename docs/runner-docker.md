# Runner JS Docker

Image: `ghcr.io/ketsuna-org/bot-creator-runner-js`

JS pool nodes are **1 bot = 1 pod**. Script isolation is the Kubernetes
cgroup memory limit (typically 196Mi), not an in-process sandbox. User
scripts run as direct Node (`ScriptDirectRuntime`).

Bot configuration (prefixes, mention as a prefix, no-prefix commands, `fn` functions, scheduled tasks and
cron) is documented in [js-bot-config.md](js-bot-config.md).

## Environment

- `BOT_CREATOR_WEB_HOST` (default `0.0.0.0` in Docker)
- `BOT_CREATOR_WEB_PORT` (default `8080`)
- `BOT_CREATOR_API_TOKEN`
- `BOT_CREATOR_DATA_DIR` (default `/bots`): synced bot configs in `synced-bots/`, and `run-state/scheduled-start/<botId>/`
  with the `runOnStart` markers of scheduled tasks (a marker younger than 30 minutes makes the next start skip that
  task's startup run; delete the file to run it again)
- `BOT_CREATOR_POOL_MODE`, `BOT_CREATOR_RUNNER_NODE_ID`, etc.
- `BOT_CREATOR_POOL_MAX_BOTS` (JS pool default **1**; a local guard refuses a second bot when `maxBots <= 1`)

## Build locally

```bash
docker build -t bot-creator-runner-js .
```

## API

`GET /` returns `engine: "javascript"` for auto-detection by the app.

`GET /bots/:id/status` of a **running** bot adds `bot.scheduled`: for each scheduled task its next run, last
result and skip counters, plus the entries the scheduler ignored and why (see
[js-bot-config.md](js-bot-config.md#7-journaux-et-statut)). `GET /status` and `GET /bots/running-status` stay light
and do not carry it.

## Hybrid commands (prefix + slash): `message` / `interaction`

In a hybrid command the same script runs for both routes:

- prefix run (a message that starts with a prefix, with `<@bot>` when `mentionAsPrefix` is on, or with the bare
  command name when `noPrefix` applies): `message` is the real Discord message, `interaction` is `undefined`.
  `message.content` is the raw text (mention included) and `message.invocation`
  (`{source, prefix, name, args, rawArgs}`) says how the command was triggered. Read arguments from
  `message.invocation`, not from `message.content.split(' ')`: the latter breaks with a mention, several
  prefixes or a prefix variable. On the mention route `message.mentions.users` and `.members` exclude the bot;
- slash run: `interaction` is the real interaction and `message` is a
  compatibility object (`message.isInteractionCompat === true`) supporting only
  `reply(...)`, `channel.send(...)`, `author`, `member`, `guild`, `guildId`,
  `channelId`, `id`, `client`. There is no `message.content`, `mentions`,
  `delete()`, `edit()` or `invocation`. The first reply calls `interaction.reply` (or
  `editReply` if deferred), later ones `followUp`.

Recommended pattern: `const ctx = message ?? interaction; await ctx.reply('...')`.
To detect the mode, test `interaction` (defined only for slash), not `message`.
Pure slash and pure prefix commands are unchanged.
