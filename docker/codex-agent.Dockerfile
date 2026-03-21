FROM node:22-slim

WORKDIR /app

RUN npm install -g @zed-industries/codex-acp

EXPOSE 9100

CMD ["codex-acp"]
