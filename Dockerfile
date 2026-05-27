# syntax=docker/dockerfile:1.7
FROM node:22-alpine

RUN apk add --no-cache bash wget \
    && corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

COPY . .

ENV COMPOSER_API_HOST=0.0.0.0 \
    COMPOSER_API_PORT=8787

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- "http://127.0.0.1:${COMPOSER_API_PORT}/health" >/dev/null || exit 1

CMD ["pnpm", "start"]
