# Build stage
# Base pinned by digest (oven/bun:1-slim); Dependabot or a manual bump moves it.
FROM oven/bun:1-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4 AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    pkg-config \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg62-turbo-dev \
    libgif-dev \
    librsvg2-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
COPY test ./test

RUN bun test
RUN bun run build
RUN rm -rf node_modules && bun install --production --frozen-lockfile

# Runtime stage
FROM oven/bun:1-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4

RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
    ca-certificates \
    libcairo2 \
    libpango-1.0-0 \
    libjpeg62-turbo \
    libgif7 \
    librsvg2-2 \
    gosu \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

ENV BOT_CREATOR_DATA_DIR=/bots
ENV BOT_CREATOR_RUNNER_LOG_FILE=/data/logs/runner.log
ENV BOT_CREATOR_WEB_HOST=0.0.0.0
ENV BOT_CREATOR_WEB_PORT=8080

VOLUME ["/bots", "/data"]
EXPOSE 8080

# Entrypoint tolérant : démarre en root, cède la main à l'utilisateur `bun` si /bots et /data lui sont accessibles
# en écriture (gosu), sinon continue en root avec un avertissement. PAS de `USER` ici : un `USER bun` empêcherait
# l'entrypoint de lire des volumes déjà montés et possédés par root sur les runners déployés.
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

ENTRYPOINT ["/app/entrypoint.sh"]
