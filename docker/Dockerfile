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
#
# Voice is baked in (piper TTS + whisper.cpp STT + models, the same pinned,
# checksummed downloads install.sh uses) — Linux binaries work in the Linux
# container on any host OS, which is what makes voice easy on Windows/Mac.
FROM node:22-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ---- voice (pinned: rhasspy/piper 2023.11.14-2, whisper.cpp b5130) ----------
ARG TARGETARCH
ARG PIPER_VOICE_COMMIT=1162a9173d0ce503555aed757976b7a9912eae4c
ARG WHISPER_MODEL_COMMIT=5359861c739e955e79d9a303bcbc70fb988958b1
# checksums pin the exact release assets (mirrors install.sh)
RUN set -eu; \
    # buildx sets TARGETARCH automatically; legacy docker builds default to amd64
    : "${TARGETARCH:=amd64}"; \
    case "$TARGETARCH" in \
      amd64) piper_tgz=piper_linux_x86_64.tar.gz;  piper_sha=a50cb45f355b7af1f6d758c1b360717877ba0a398cc8cbe6d2a7a3a26e225992; wb=whisper-bin-ubuntu-x64.tar.gz;    whisper_sha=53e7fd8b5764edad916b8848dd0af6abb1ff1d3b86c899e79c78652412536c32 ;; \
      arm64) piper_tgz=piper_linux_aarch64.tar.gz; piper_sha=fea0fd2d87c54dbc7078d0f878289f404bd4d6eea6e7444a77835d1537ab88eb; wb=whisper-bin-ubuntu-arm64.tar.gz; whisper_sha=93532a0e3777f26f041ffa358ee77dd88b1a33a86847c1990745327ff335a5d6 ;; \
      *) echo "unsupported TARGETARCH $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    tmp=$(mktemp -d); \
    curl -fsSL "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/$piper_tgz" -o "$tmp/p.tgz"; \
    echo "$piper_sha  $tmp/p.tgz" | sha256sum -c - >/dev/null; \
    mkdir -p /opt/piper "$tmp/p"; tar -xzf "$tmp/p.tgz" -C "$tmp/p"; cp -a "$tmp/p/piper/." /opt/piper/; \
    ln -s /opt/piper/piper /usr/local/bin/piper; \
    curl -fsSL "https://github.com/ggml-org/whisper.cpp/releases/download/b5130/$wb" -o "$tmp/w.tgz"; \
    echo "$whisper_sha  $tmp/w.tgz" | sha256sum -c - >/dev/null; \
    mkdir -p /opt/whisper "$tmp/w"; tar -xzf "$tmp/w.tgz" -C "$tmp/w"; \
    wbin=$(find "$tmp/w" -type f \( -name whisper-cli -o -name whisper -o -name main \) | head -1); \
    [ -n "$wbin" ] || { echo "whisper archive contained no binary" >&2; exit 1; }; \
    cp -a "$tmp/w/." /opt/whisper/; \
    wrel="${wbin#"$tmp/w/"}"; \
    chmod +x "/opt/whisper/$wrel"; \
    ln -s "/opt/whisper/$wrel" /usr/local/bin/whisper-cli; \
    mkdir -p /opt/voice; \
    curl -fsSL "https://huggingface.co/rhasspy/piper-voices/resolve/$PIPER_VOICE_COMMIT/en/en_US/lessac/medium/en_US-lessac-medium.onnx" -o /opt/voice/en_US-lessac-medium.onnx; \
    echo "5efe09e69902187827af646e1a6e9d269dee769f9877d17b16b1b46eeaaf019f  /opt/voice/en_US-lessac-medium.onnx" | sha256sum -c - >/dev/null; \
    curl -fsSL "https://huggingface.co/rhasspy/piper-voices/resolve/$PIPER_VOICE_COMMIT/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json" -o /opt/voice/en_US-lessac-medium.onnx.json; \
    echo "efe19c417bed055f2d69908248c6ba650fa135bc868b0e6abb3da181dab690a0  /opt/voice/en_US-lessac-medium.onnx.json" | sha256sum -c - >/dev/null; \
    curl -fsSL "https://huggingface.co/ggerganov/whisper.cpp/resolve/$WHISPER_MODEL_COMMIT/ggml-base.en.bin" -o /opt/voice/ggml-base.en.bin; \
    echo "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002  /opt/voice/ggml-base.en.bin" | sha256sum -c - >/dev/null; \
    rm -rf "$tmp"

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
    GAIA_PIPER_VOICE=/opt/voice/en_US-lessac-medium.onnx \
    GAIA_WHISPER_MODEL=/opt/voice/ggml-base.en.bin \
    HOME=/home/node
RUN mkdir -p /workspace /home/node/.pi-gateway && chown -R node:node /workspace /home/node /app
USER node
VOLUME /workspace /home/node/.pi-gateway

CMD ["node_modules/.bin/tsx", "src/index.ts"]
