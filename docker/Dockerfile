# pi-gateway (GAIA) container image.
#
# Build via docker/build.sh — it stages this directory with the GAIA source and
# the GreenPi dependency tarballs (npm registries are never contacted for the
# fork's packages), then runs docker build.
#
# Containment model (docs/security-plan.md): the container IS the sandbox.
# The agent sees the container filesystem plus exactly two mounts:
#   /workspace            — the host's ./workspace folder (read-write): the file
#                           passage to and from the agent
#   /home/node/.pi-gateway— the host's ./data folder (read-write): memory,
#                           session logs, schedules — what survives a reset
# Secrets enter as environment variables (env_file: .env), never as files.
FROM node:22-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# The image ships a `node` user at uid 1000 — keep it so bind-mounted folders
# from a typical Linux host (uid 1000) are writable without chown gymnastics.
# Other host uids: set `user: "<uid>:<gid>"` in docker-compose.override.yml.
WORKDIR /app
COPY package.json ./
COPY greenpi/ ./greenpi/
RUN npm install --no-fund --no-audit && npm cache clean --force
COPY . .

ENV GAIA_SANDBOX=docker \
    GAIA_WORKSPACE=/workspace \
    HOME=/home/node
RUN mkdir -p /workspace /home/node/.pi-gateway && chown -R node:node /workspace /home/node /app
USER node
VOLUME /workspace /home/node/.pi-gateway

CMD ["node_modules/.bin/tsx", "src/index.ts"]
