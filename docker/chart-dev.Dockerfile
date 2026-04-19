# Trading core — Vite dev server (`npm run chart:dev` from repo root).
# Build from repository root: docker build -f docker/chart-dev.Dockerfile .

FROM node:20-bookworm-slim

WORKDIR /app

COPY src ./src
COPY apps/chart-web/package.json apps/chart-web/package-lock.json ./apps/chart-web/
COPY apps/chart-web/tsconfig.json apps/chart-web/vite.config.ts apps/chart-web/index.html ./apps/chart-web/
COPY apps/chart-web/src ./apps/chart-web/src

WORKDIR /app/apps/chart-web
RUN npm ci

ENV NODE_ENV=development
EXPOSE 5173

CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5173"]
