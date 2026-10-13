# syntax=docker/dockerfile:1
ARG NODE_VERSION=22

# ---------- all dependencies (dev + prod), used to build ----------
FROM node:${NODE_VERSION}-slim AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN npm install -g pnpm@12 \
	&& pnpm install --frozen-lockfile

# ---------- build the SvelteKit adapter-node output ----------
FROM deps AS build
COPY . .
RUN pnpm build

# ---------- production-only node_modules ----------
FROM node:${NODE_VERSION}-slim AS prod-deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN npm install -g pnpm@12 \
	&& pnpm install --frozen-lockfile --prod

# ---------- runtime ----------
FROM node:${NODE_VERSION}-slim AS runtime
ENV NODE_ENV=production \
	PORT=3000 \
	DATABASE_PATH=/app/data/app.db \
	AUDIO_DIR=/app/data/audio
WORKDIR /app

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/build ./build
COPY --chown=node:node start.js package.json ./

RUN mkdir -p /app/data \
	&& chown -R node:node /app/data \
	&& chown -R node:node /app/node_modules

USER node
VOLUME /app/data
EXPOSE 3000
CMD ["node", "start.js"]
