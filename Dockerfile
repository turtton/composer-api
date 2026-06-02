FROM oven/bun:1.3.13-slim AS base
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM base AS bridge
COPY scripts ./scripts
ENV CURSOR_SDK_BRIDGE_HOST=0.0.0.0
ENV CURSOR_SDK_BRIDGE_PORT=8792
CMD ["bun", "run", "scripts/cursor-sdk-local-agent-bridge.mjs"]

FROM base AS api
COPY server ./server
COPY worker ./worker
ENV PORT=8787
ENV CURSOR_SDK_BRIDGE_URL=http://bridge:8792/sdk
CMD ["bun", "run", "server/index.ts"]
