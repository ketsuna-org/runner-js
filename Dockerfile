# Build stage
FROM oven/bun:1-slim AS builder

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
RUN bun install

COPY tsconfig.json ./
COPY src ./src
COPY test ./test

RUN bun test
RUN bun run build

# Runtime stage
FROM oven/bun:1-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    libcairo2 \
    libpango-1.0-0 \
    libjpeg62-turbo \
    libgif7 \
    librsvg2-2 \
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

CMD ["bun", "dist/index.js"]
