# Runner JS Docker

Image: `ghcr.io/ketsuna-org/bot-creator-runner-js`

JS pool nodes are **1 bot = 1 pod**. Script isolation is the Kubernetes
cgroup memory limit (typically 196Mi), not an in-process sandbox. User
scripts run as direct Node (`ScriptDirectRuntime`).

## Environment

- `BOT_CREATOR_WEB_HOST` (default `0.0.0.0` in Docker)
- `BOT_CREATOR_WEB_PORT` (default `8080`)
- `BOT_CREATOR_API_TOKEN`
- `BOT_CREATOR_DATA_DIR` (default `/bots`)
- `BOT_CREATOR_POOL_MODE`, `BOT_CREATOR_RUNNER_NODE_ID`, etc.
- `BOT_CREATOR_POOL_MAX_BOTS` (JS pool default **1**; a local guard refuses a second bot when `maxBots <= 1`)

## Build locally

```bash
docker build -t bot-creator-runner-js .
```

## API

`GET /` returns `engine: "javascript"` for auto-detection by the app.

## Hybrid commands (prefix + slash): `message` / `interaction`

In a hybrid command the same script runs for both routes:

- prefix run: `message` is the real Discord message, `interaction` is `undefined`;
- slash run: `interaction` is the real interaction and `message` is a
  compatibility object (`message.isInteractionCompat === true`) supporting only
  `reply(...)`, `channel.send(...)`, `author`, `member`, `guild`, `guildId`,
  `channelId`, `id`, `client`. There is no `message.content`, `mentions`,
  `delete()` or `edit()`. The first reply calls `interaction.reply` (or
  `editReply` if deferred), later ones `followUp`.

Recommended pattern: `const ctx = message ?? interaction; await ctx.reply('...')`.
To detect the mode, test `interaction` (defined only for slash), not `message`.
Pure slash and pure prefix commands are unchanged.
