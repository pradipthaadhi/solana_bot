# Phantom + Jupiter test UI — Vite dev server (`npm run trader:dev` from repo root).
# Build from repository root: docker build -f docker/trader-dev.Dockerfile .

FROM node:20-bookworm-slim

WORKDIR /app

COPY src ./src
COPY apps/trader-web/package.json apps/trader-web/package-lock.json ./apps/trader-web/
COPY apps/trader-web/tsconfig.json ./apps/trader-web/
COPY apps/trader-web/vite.config.ts apps/trader-web/index.html ./apps/trader-web/
COPY apps/trader-web/src ./apps/trader-web/src

WORKDIR /app/apps/trader-web
# Lockfile is compatible with npm 11+ (local); node:20 image ships npm 10 which rejects this lock.
RUN npm install -g npm@11.6.2 && npm ci

# Vite’s scanner resolves from `/app/src/**/*.ts` and only walks `.../src/node_modules` (not
# `apps/trader-web/node_modules`). Alias in vite.config does not apply to that pass — link them.
RUN ln -sfn /app/apps/trader-web/node_modules /app/src/node_modules

ENV NODE_ENV=development
EXPOSE 5173

CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5173"]
