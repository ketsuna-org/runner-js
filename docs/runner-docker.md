# Runner JS Docker

Image: `ghcr.io/ketsuna-org/bot-creator-runner-js`

## Environment

- `BOT_CREATOR_WEB_HOST` (default `0.0.0.0` in Docker)
- `BOT_CREATOR_WEB_PORT` (default `8080`)
- `BOT_CREATOR_API_TOKEN`
- `BOT_CREATOR_DATA_DIR` (default `/bots`)
- `BOT_CREATOR_POOL_MODE`, `BOT_CREATOR_RUNNER_NODE_ID`, etc.

## Build locally

```bash
docker build -t bot-creator-runner-js .
```

## API

`GET /` returns `engine: "javascript"` for auto-detection by the app.
