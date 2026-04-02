FROM node:22-slim
WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy workspace files
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/flamecast/package.json packages/flamecast/
COPY packages/protocol/package.json packages/protocol/

# Install dependencies
RUN pnpm install --frozen-lockfile --filter @flamecast/sdk...

# Copy source and build
COPY packages/protocol packages/protocol
COPY packages/flamecast packages/flamecast
COPY tsconfig.base.json ./
RUN pnpm --filter @flamecast/sdk build:package

EXPOSE 9080 9100
ENV RUNTIME_HOST_PORT=9100
COPY deploy/runtime-host/entrypoint.sh ./entrypoint.sh
CMD ["sh", "entrypoint.sh"]
