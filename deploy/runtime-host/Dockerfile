FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends procps libssl3 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Install pnpm (npx comes with node:22-slim already)
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

EXPOSE 9100
ENV RUNTIME_HOST_PORT=9100
CMD ["node", "packages/flamecast/dist/runtime-host/serve.js"]
