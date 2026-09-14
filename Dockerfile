# pi-gateway container: no host secrets, state lives in the mounted volume.
# See README "Docker" section; containment layer alongside src/security.ts.
FROM node:22-slim

# ffmpeg for voice notes (piper OGG/Opus + whisper input)
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .

RUN useradd --create-home gaia
USER gaia
VOLUME /home/gaia/.pi-gateway

CMD ["node_modules/.bin/tsx", "src/index.ts"]
