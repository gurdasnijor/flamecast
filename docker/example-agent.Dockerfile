FROM node:22-slim

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

WORKDIR /app

# Install dependencies locally so tsx can resolve them
RUN corepack enable && pnpm init
RUN pnpm add tsx @agentclientprotocol/sdk

# Copy the example agent
COPY src/flamecast/agent.ts ./agent.ts

EXPOSE 9100

CMD ["./node_modules/.bin/tsx", "agent.ts"]
