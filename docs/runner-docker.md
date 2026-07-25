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
