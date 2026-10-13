# syntax=docker/dockerfile:1
ARG NODE_VERSION=22

# ---------- install + build (single stage, keeps native deps consistent) ----------
FROM node:${NODE_VERSION}-slim AS build
ARG PNPM_VERSION=12.3.4
WORKDIR /app

# build tools = fallback for native modules (better-sqlite3) if prebuilds are unavailable
RUN apt-get update \
	&& apt-get install -y --no-install-recommends python3 make g++ \
	&& rm -rf /var/lib/apt/lists/* \
	&& npm install -g pnpm@${PNPM_VERSION}

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
# generous fetch timeout — heavy native packages (~100MB+) on first build
# (note: pnpm 12 removed --fetch-retries/--fetch-retry-*-timeout CLI flags)
RUN pnpm install --frozen-lockfile --reporter=append-only \
	--fetch-timeout 600000

COPY . .
RUN pnpm build

# ---------- runtime ----------
FROM node:${NODE_VERSION}-slim AS runtime
ENV NODE_ENV=production \
	PORT=3011 \
	DATABASE_PATH=/app/data/app.db \
	AUDIO_DIR=/app/data/audio
WORKDIR /app

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/build ./build
COPY --chown=node:node start.js package.json ./

RUN mkdir -p /app/data \
	&& chown -R node:node /app/data

USER node
VOLUME /app/data
EXPOSE 3011
CMD ["node", "start.js"]
