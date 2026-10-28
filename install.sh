#!/usr/bin/env bash
# install.sh — build & install GreenPi (fork of pi) as `greenpi`, and wire GAIA to it.
#
# - Never touches an existing `pi` install (isolated dir under ~/.greenpi, separate ~/.greenpi config).
# - Idempotent: re-run to update both GreenPi and GAIA.
# - OFFERS (does not install by default) a llama.cpp router + a default model for hosts with
#   nothing else to point at; accepting is a prompt in step 6, skippable with GAIA_NO_LOCAL=1.
# - Uninstall: systemctl --user disable --now gaia-gateway llama-server
#   rm ~/.config/systemd/user/{gaia-gateway,llama-server}.service
#   rm -rf ~/.greenpi ~/GreenPi && rm ~/.local/bin/greenpi
#   (revert GAIA: git checkout package.json package-lock.json && npm install)
#
# Usage: ./install.sh
# Env overrides: GREENPI_REPO GREENPI_SRC (~/GreenPi) GREENPI_HOME (~/.greenpi) GAIA_DIR (~/GAIA) BIN_DIR (~/.local/bin)
set -euo pipefail

LLAMA_VERSION=b10823 # pinned llama.cpp release; bump to update the bundled server
# whisper.cpp prebuilt bins now ship only on nightly tags (the v1.9.x "latest" releases attach no
# binaries); b5130 is the pinned tag — never use releases/latest, it is a moving target
WHISPER_VERSION=b5130
# HuggingFace model files are pinned to a specific commit (never `resolve/main`, a moving target)
# so installs are reproducible and the bytes are stable; the checksums below verify them like
# every other pinned asset. Bump the commit AND the corresponding checksum together.
PIPER_VOICES_COMMIT=1162a9173d0ce503555aed757976b7a9912eae4c
WHISPER_MODEL_COMMIT=5359861c739e955e79d9a303bcbc70fb988958b1
GREENPI_REPO="${GREENPI_REPO:-https://github.com/eco-syntax/GreenPi}"
GREENPI_SRC="${GREENPI_SRC:-$HOME/GreenPi}"
GREENPI_HOME="${GREENPI_HOME:-$HOME/.greenpi}"
GAIA_DIR="${GAIA_DIR:-$HOME/GAIA}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"

# SHA-256 of every pinned release asset, computed from the official GitHub release artifacts.
# Upstream publishes no SHA256SUMS files, so the hashes are pinned here: if a release asset ever
# changes (or a tag is moved), the install fails instead of extracting/executing unknown code.
# (case-based lookups, not declare -A — macOS ships bash 3.2)
llama_sha() {
	case "$1" in
		llama-b10823-bin-ubuntu-x64.tar.gz) echo 60bded941b372d33af43fcb2725645f3e683d8a1101e745cff00e5c3b05e58f4 ;;
		llama-b10823-bin-ubuntu-arm64.tar.gz) echo d00c11473ba50333aa93f390dd0313bedc89b1d579debf9c076007b91d0e7962 ;;
		llama-b10823-bin-ubuntu-vulkan-x64.tar.gz) echo 46720f165c1038b2cce6fbfed79370accdf74fadb0b287f9696023ae94493288 ;;
		llama-b10823-bin-ubuntu-vulkan-arm64.tar.gz) echo 0077ba29925d20501fa496ae2c02529338a9b0658bbdd1723a640b8384c0fe04 ;;
		llama-b10823-bin-macos-arm64.tar.gz) echo 4c5b7456e1cc6dc95bb550c805ddbec4831a87be1507260c742c9650648744ca ;;
		llama-b10823-bin-macos-x64.tar.gz) echo d76a9dadc80a95ac0b2ac006983ccdcb5bfdb9d585d16c70bc8d2e73cb6cb57d ;;
	esac
}
piper_sha() {
	case "$1" in
		piper_linux_x86_64.tar.gz) echo a50cb45f355b7af1f6d758c1b360717877ba0a398cc8cbe6d2a7a3a26e225992 ;;
		piper_linux_aarch64.tar.gz) echo fea0fd2d87c54dbc7078d0f878289f404bd4d6eea6e7444a77835d1537ab88eb ;;
		piper_macos_aarch64.tar.gz) echo 6b1eb03b3735946cb35216e063e7eebcc33a6bbf5dd96ec0217959bf1cdcb0cc ;;
		piper_macos_x64.tar.gz) echo ced85c0a3df13945b1e623b878a48fdc2854d5c485b4b67f62857cf551deaf8b ;;
	esac
}
whisper_sha() {
	case "$1" in
		whisper-bin-ubuntu-x64.tar.gz) echo 53e7fd8b5764edad916b8848dd0af6abb1ff1d3b86c899e79c78652412536c32 ;;
		whisper-bin-ubuntu-arm64.tar.gz) echo 93532a0e3777f26f041ffa358ee77dd88b1a33a86847c1990745327ff335a5d6 ;;
	esac
}
# SHA-256 of the pinned HuggingFace model files (see PIPER_VOICES_COMMIT / WHISPER_MODEL_COMMIT).
voice_model_sha() {
	case "$1" in
		en_US-lessac-medium.onnx) echo 5efe09e69902187827af646e1a6e9d269dee769f9877d17b16b1b46eeaaf019f ;;
		en_US-lessac-medium.onnx.json) echo efe19c417bed055f2d69908248c6ba650fa135bc868b0e6abb3da181dab690a0 ;;
	esac
}
whisper_model_sha() {
	case "$1" in
		ggml-base.en.bin) echo a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002 ;;
	esac
}

# verify_sha256 <file> <expected-hash> <label> — abort install on any mismatch
verify_sha256() {
	local file=$1 want=$2 label=$3 got
	[ -n "$want" ] || { echo "no pinned checksum for $label — refusing to install" >&2; exit 1; }
	if command -v sha256sum >/dev/null; then
		got=$(sha256sum "$file" | cut -d' ' -f1)
	elif command -v shasum >/dev/null; then
		got=$(shasum -a 256 "$file" | cut -d' ' -f1)
	else
		echo "missing sha256 tool (need sha256sum or shasum)" >&2; exit 1
	fi
	[ "$got" = "$want" ] || { echo "checksum mismatch for $label: expected $want, got $got" >&2; exit 1; }
	echo "checksum ok: $label"
}

need() { command -v "$1" >/dev/null || { echo "missing dependency: $1" >&2; exit 1; }; }

# print JSON mapping "@scope/name" → "file:<path>.tgz" for every tarball in $1/tarballs
tarball_deps() {
	node - "$1" <<'EOF'
const fs = require("fs");
const dir = `${process.argv[2]}/tarballs`;
const deps = {};
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".tgz"))) {
	// tarball filenames vary across npm versions ("@scope+name-x.tgz" vs "scope-name-x.tgz") —
	// read the real package name from inside instead of parsing the filename
	const name = JSON.parse(require("child_process").execSync(`tar -xzOf ${dir}/${f} package/package.json`, { encoding: "utf8" })).name;
	deps[name] = `file:${dir}/${f}`;
}
console.log(JSON.stringify(deps));
EOF
}
need git
need npm
node_major=$(node -p 'process.versions.node.split(".")[0]')
[ "$node_major" -ge 22 ] || { echo "need node >= 22 (GAIA requires it), have $(node --version)" >&2; exit 1; }

echo "==> 1/10 clone or update $GREENPI_SRC"
if [ -d "$GREENPI_SRC/.git" ]; then
	# our package.json brand patch is tracked-file dirt; stash it around the pull
	git -C "$GREENPI_SRC" stash -q 2>/dev/null || true
	git -C "$GREENPI_SRC" pull --ff-only -q
	git -C "$GREENPI_SRC" stash pop -q 2>/dev/null || true
else
	git clone -q "$GREENPI_REPO" "$GREENPI_SRC"
fi

echo "==> 2/10 brand fork as greenpi (config dir ~/.greenpi; packed bin is greenpi — local-release's shim follows the package's bin)"
node - "$GREENPI_SRC" <<'EOF'
const fs = require("fs");
const p = `${process.argv[2]}/packages/coding-agent/package.json`;
const pkg = JSON.parse(fs.readFileSync(p, "utf8"));
pkg.piConfig = { ...pkg.piConfig, name: "greenpi", configDir: ".greenpi" };
fs.writeFileSync(p, JSON.stringify(pkg, null, "\t") + "\n");
EOF

echo "==> 3/10 install deps + build + pack tarballs (no bun needed)"
cd "$GREENPI_SRC"
npm install --no-fund --no-audit
node scripts/local-release.mjs \
	--out "$GREENPI_HOME" --force \
	--skip-check --skip-test --skip-install --skip-bun-install
# leaves tarballs in $GREENPI_HOME/tarballs/; skips the bun binary build entirely

echo "==> 4/10 isolated greenpi install at $GREENPI_HOME/node"
mkdir -p "$GREENPI_HOME/node"
deps=$(tarball_deps "$GREENPI_HOME")
node - "$GREENPI_HOME" "$deps" <<'EOF'
const fs = require("fs");
const [home, depsJson] = process.argv.slice(2);
const deps = JSON.parse(depsJson);
fs.writeFileSync(
	`${home}/node/package.json`,
	JSON.stringify({ private: true, dependencies: deps, overrides: deps }, null, "\t") + "\n",
);
EOF
(cd "$GREENPI_HOME/node" && npm install --omit=dev --ignore-scripts --no-fund --no-audit)
ln -sf "$GREENPI_HOME/node/node_modules/.bin/greenpi" "$BIN_DIR/greenpi"
case ":$PATH:" in
*":$BIN_DIR:"*) ;;
*) echo "note: $BIN_DIR is not in PATH — add it to use 'greenpi'" >&2 ;;
esac

echo "==> 5/10 wire GAIA ($GAIA_DIR) to the GreenPi tarballs"
	[ -d "$GAIA_DIR" ] || { echo "GAIA not found at $GAIA_DIR (set GAIA_DIR)" >&2; exit 1; }
	# point the two pi deps at the fork AND override every internal @earendil-works dep with the
	# fork's tarballs — otherwise nested deps resolve from the npm registry (upstream pi) and the
	# local-first provider changes in packages/ai silently don't ship
	deps=$(tarball_deps "$GREENPI_HOME")
	node - "$GAIA_DIR" "$deps" <<'EOF'
const fs = require("fs");
const [gaia, depsJson] = process.argv.slice(2);
const deps = JSON.parse(depsJson);
const p = `${gaia}/package.json`;
const pkg = JSON.parse(fs.readFileSync(p, "utf8"));
for (const dep of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-server"]) {
	pkg.dependencies[dep] = deps[dep];
}
pkg.overrides = deps;
fs.writeFileSync(p, JSON.stringify(pkg, null, "\t") + "\n");
EOF
	(cd "$GAIA_DIR" && npm install --no-fund --no-audit)

echo "==> 6/10 local model server (optional — offer, not default)"
need curl
# GAIA works with any OpenAI-compatible server you already run (LM Studio, Ollama,
# llama.cpp, vLLM) or a cloud provider. Installing a local llama.cpp router plus a
# ~6 GB model is offered here only so a machine with nothing else has a working
# default — say no if you have your own model endpoint and set it in step 7's config.
LOCAL_MODEL=""
if [ -n "${GAIA_NO_LOCAL:-}" ]; then
	echo "GAIA_NO_LOCAL set — skipping llama.cpp router and model download"
elif [ -x "$HOME/.greenpi/agent/llama/bin/llama-server" ]; then
	# Already installed on a previous run: keep it, but only keep the gateway pointed
	# at it if the router is actually healthy.
	LLAMA_DIR=$HOME/.greenpi/agent/llama
	LLAMA_BIN=$LLAMA_DIR/bin/llama-server
	echo "llama.cpp router already installed: $LLAMA_BIN"
	if curl -s -o /dev/null -w '' --max-time 2 http://127.0.0.1:8080/health 2>/dev/null; then
		LOCAL_MODEL=$(curl -s http://127.0.0.1:8080/models | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
		[ -n "$LOCAL_MODEL" ] && echo "router is up; loaded models: $LOCAL_MODEL"
	fi
else
	# Detect an existing OpenAI-compatible server before offering anything: LM Studio
	# (1234), Ollama (11434), llama.cpp (8080). If one answers, GAIA can use it as-is.
	EXISTING=""
	for probe in "http://127.0.0.1:1234/v1" "http://127.0.0.1:11434/v1" "http://127.0.0.1:8080/v1"; do
		code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$probe/models" 2>/dev/null || true)
		[ "$code" = "200" ] && { EXISTING="$probe"; break; }
	done
	if [ -n "$EXISTING" ]; then
		echo "found an existing model server at $EXISTING — GAIA will use it; no llama.cpp install needed"
		echo "  (point the config at one of its models in step 7, e.g. via /model)"
	else
		printf "Install a local llama.cpp router + Qwen3.5-9B model (~5.7 GB, runs on CPU, no GPU needed)? [y/N] "
		if [ -t 0 ]; then read -r -n 1 yn; echo; else yn="n"; fi
		case "$yn" in
		[yY])
			LLAMA_VERSION=b10823 # pinned llama.cpp release; bump to update the bundled server
			LLAMA_DIR=$HOME/.greenpi/agent/llama
			LLAMA_BIN=$LLAMA_DIR/bin/llama-server
			case "$(uname -s)/$(uname -m)" in
				Linux/x86_64) plat=linux; arch=x64 ;;
				Linux/aarch64|Linux/arm64) plat=linux; arch=arm64 ;;
				Darwin/arm64) plat=darwin; arch=arm64 ;;
				Darwin/x86_64) plat=darwin; arch=x64 ;;
				*) echo "no prebuilt llama-server for $(uname -s)/$(uname -m) — install one in PATH" >&2; exit 1 ;;
			esac
			# vulkan build offloads GPU on any vendor; cpu build is the fallback
			if [ "$plat" = linux ] && { command -v vulkaninfo >/dev/null || [ -d /usr/share/vulkan/icd.d ]; }; then
				variant="vulkan-$arch"
			else
				variant="$arch"
			fi
			# gh release assets: ubuntu-* on linux, macos-* on darwin
			asset="llama-${LLAMA_VERSION}-bin-${plat/linux/ubuntu}-${variant}.tar.gz"
			url="https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_VERSION}/${asset}"
			echo "downloading $url"
			tmp=$(mktemp -d)
			curl -fL "$url" -o "$tmp/a.tgz"
			verify_sha256 "$tmp/a.tgz" "$(llama_sha "$asset")" "$asset"
			mkdir -p "$tmp/x" "$LLAMA_DIR/bin"
			tar -xzf "$tmp/a.tgz" -C "$tmp/x"
			# ship the whole dir: llama-server needs its side-by-side libs (RUNPATH $ORIGIN);
			# cp -a keeps the .so symlinks (libggml-base.so.0 -> ...) that find -type f drops.
			# newer release tarballs nest everything in a top-level dir — install from beside the binary
			bindir=$(dirname "$(find "$tmp/x" -name llama-server -type f | head -1)")
			cp -a "$bindir/." "$LLAMA_DIR/bin/"
			chmod -R 755 "$LLAMA_DIR/bin"
			rm -rf "$tmp"

			mkdir -p "$LLAMA_DIR/models" "$HOME/.config/systemd/user"
			cat > "$HOME/.config/systemd/user/llama-server.service" <<EOF
[Unit]
Description=llama.cpp router (GAIA models)
After=network-online.target

[Service]
ExecStart=$LLAMA_BIN --host 127.0.0.1 --port 8080 --models-dir $LLAMA_DIR/models --no-models-autoload --jinja -ngl 999 -c 32768
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF
			systemctl --user daemon-reload
			systemctl --user enable --now llama-server.service
			# /health: 200 ready, 503 still booting — both mean the router is up
			for i in $(seq 1 60); do
				code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/health || true)
				[ "$code" = 200 ] || [ "$code" = 503 ] && break
				[ "$i" = 60 ] && { echo "llama-server did not become healthy — journalctl --user -u llama-server" >&2; exit 1; }
				sleep 1
			done

			# CPU-friendly default model (Q4_K_M ≈ 5.7 GB); runs without a GPU.
			MODEL_REPO=unsloth/Qwen3.5-9B-GGUF:Q4_K_M
			if curl -s http://127.0.0.1:8080/models | grep -q "Qwen3.5-9B"; then
				echo "Qwen3.5-9B already present on the router"
			else
				echo "downloading $MODEL_REPO (one-time, ~6 GB — router shows progress in its log)"
				curl -sf -X POST http://127.0.0.1:8080/models -d "{\"model\":\"$MODEL_REPO\"}"
				for i in $(seq 1 3600); do
					curl -s http://127.0.0.1:8080/models | grep -q "Qwen3.5-9B" && break
					[ "$i" = 3600 ] && { echo "model download timed out" >&2; exit 1; }
					sleep 2
				done
			fi
			LOCAL_MODEL=$(curl -s http://127.0.0.1:8080/models | grep -o '"id":"[^"]*Qwen3.5-9B[^"]*"' | head -1 | cut -d'"' -f4)
			# router returns 400 "model is already running" on re-runs — don't let set -e kill the script silently
			curl -sf -X POST http://127.0.0.1:8080/models/load -d "{\"model\":\"$LOCAL_MODEL\"}" || true
			for i in $(seq 1 300); do
				curl -s http://127.0.0.1:8080/models | grep -q '"loaded"' && { echo "model loaded: $LOCAL_MODEL"; break; }
				[ "$i" = 300 ] && { echo "model load timed out" >&2; exit 1; }
				sleep 1
			done
			;;
		*)
			echo "skipped — point GAIA at your own model server in the config (step 7) or with /model"
			;;
		esac
	fi
fi

echo "==> 7/10 gateway config (~/.gaia/config.json)"
CONFIG=$HOME/.gaia/config.json
if [ -s "$CONFIG" ]; then
	echo "config exists, keeping it"
else
	mkdir -p "$(dirname "$CONFIG")"
	# Platform choice: Matrix by default (self-hostable, no third-party bot
	# approval), Telegram as the alternative. config.json uses camelCase keys.
	printf "Chat platform — Matrix (default) or Telegram? [M/t] "
	if [ -t 0 ]; then read -r -n 1 platform; echo; else platform="m"; fi
	PLATFORM_LINE=""
	case "$platform" in
	[tT]*)
		while true; do
			read -r -p "Telegram bot token (from @BotFather): " TOKEN
			[ -n "$TOKEN" ] || continue
			if curl -sf "https://api.telegram.org/bot$TOKEN/getMe" | grep -q '"ok":true'; then break; fi
			echo "token invalid or Telegram unreachable — retry" >&2
		done
		# best-effort: peek at recent messages to suggest the user's chat id
		DETECTED=$(curl -sf "https://api.telegram.org/bot$TOKEN/getUpdates" | grep -o '"chat":{"id":[0-9]*' | grep -o '[0-9]*' | sort -u | head -5 || true)
		[ -n "$DETECTED" ] && echo "chats seen by this bot: $(echo "$DETECTED" | tr '\n' ' ') (message the bot first if empty)"
		while true; do
			read -r -p "Your chat id to allow: " CHAT_ID
			case "$CHAT_ID" in ''|*[!0-9]*) echo "need a numeric chat id" >&2; continue;; esac
			break
		done
		PLATFORM_LINE="
  \"telegramBotToken\": \"$TOKEN\",
  \"allowedChatIds\": [$CHAT_ID]"
		;;
	*)
		while true; do
			read -r -p "Homeserver URL (Enter for https://matrix.org): " HOMESERVER
			HOMESERVER=${HOMESERVER:-https://matrix.org}
			case "$HOMESERVER" in https://*) break;; *) echo "must start with https://" >&2;; esac
			break
		done
		while true; do
			read -r -p "Bot's full user id (e.g. @gaia-bot:matrix.org): " USER_ID
			case "$USER_ID" in @*:*@*) ;; @*:*) break;; *) echo "must look like @name:server" >&2; continue;; esac
			break
		done
		while true; do
			read -r -p "Bot's access token (Element → Settings → Help & About → Access Token, logged in as the bot): " MTOKEN
			[ -n "$MTOKEN" ] || { echo "token required" >&2; continue; }
			break
		done
		read -r -p "Room id to allow (Element → room settings → Advanced → Internal room ID, e.g. !abc:matrix.org): " ROOM_ID
		PLATFORM_LINE="
  \"matrixHomeserver\": \"$HOMESERVER\",
  \"matrixUserId\": \"$USER_ID\",
  \"matrixAccessToken\": \"$MTOKEN\",
  \"allowedMatrixRoomIds\": [\"$ROOM_ID\"]"
		;;
	esac
	# Model: the freshly-installed llama.cpp router when the user accepted step 6's
	# offer; otherwise leave the model unset — GAIA starts fine without one and the
	# user picks a model interactively via /model (or edits config.json / GAIA_MODEL).
	# provider id 'llama-cpp' = GreenPi's llama.cpp router.
	MODEL_LINE=""
	if [ -n "$LOCAL_MODEL" ]; then
		MODEL_LINE=",
  \"model\": { \"provider\": \"llama-cpp\", \"id\": \"$LOCAL_MODEL\" }"
	fi
	cat > "$CONFIG" <<EOF
{$PLATFORM_LINE$MODEL_LINE
}
EOF
	chmod 600 "$CONFIG"
	if [ -n "$LOCAL_MODEL" ]; then
		echo "wrote $CONFIG (model ids on the router: curl http://127.0.0.1:8080/models)"
	else
		echo "wrote $CONFIG (no default model — run /model in chat, or set GAIA_MODEL=provider/id)"
	fi
fi

echo "==> 8/10 local voice (optional: piper TTS for replies, whisper STT for voice notes)"
if [ ! -s "$CONFIG" ]; then
	echo "no config — skipping voice setup"
else
	printf "Install local voice (piper + whisper.cpp + models, ~250 MB)? [y/N] "
	read -r -n 1 yn; echo
	case "$yn" in
	[yY])
		command -v ffmpeg >/dev/null || echo "hint: ffmpeg missing — voice needs it (sudo apt install ffmpeg / brew install ffmpeg)" >&2

		# piper binary (static tarball; upstream has no apt package)
		if command -v piper >/dev/null; then
			echo "piper: already installed ($(command -v piper))"
		else
			case "$(uname -s)/$(uname -m)" in
				Linux/x86_64) piper_tgz=piper_linux_x86_64.tar.gz ;;
				Linux/aarch64) piper_tgz=piper_linux_aarch64.tar.gz ;;
				Darwin/arm64) piper_tgz=piper_macos_aarch64.tar.gz ;;
				Darwin/x86_64) piper_tgz=piper_macos_x64.tar.gz ;;
				*) piper_tgz="" ;;
			esac
			if [ -z "$piper_tgz" ]; then
				echo "no prebuilt piper for $(uname -s)/$(uname -m) — install it on PATH manually" >&2
			else
				tmp=$(mktemp -d)
				curl -fL "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/$piper_tgz" -o "$tmp/p.tgz"
				verify_sha256 "$tmp/p.tgz" "$(piper_sha "$piper_tgz")" "$piper_tgz"
				mkdir -p "$tmp/x" "$HOME/.gaia/piper"
				tar -xzf "$tmp/p.tgz" -C "$tmp/x"
				cp -a "$tmp/x/piper/." "$HOME/.gaia/piper/"
				ln -sf "$HOME/.gaia/piper/piper" "$BIN_DIR/piper"
				rm -rf "$tmp"
				echo "piper installed: $HOME/.gaia/piper/piper (symlinked as $BIN_DIR/piper)"
			fi
		fi

		# piper voice model
		mkdir -p "$HOME/.gaia/voices"
		if [ -s "$HOME/.gaia/voices/en_US-lessac-medium.onnx" ]; then
			echo "piper voice: already downloaded"
		else
			echo "downloading en_US-lessac-medium voice (~63 MB)"
			vbase=https://huggingface.co/rhasspy/piper-voices/resolve/${PIPER_VOICES_COMMIT}/en/en_US/lessac/medium
			tmpv=$(mktemp -d)
			curl -fL "$vbase/en_US-lessac-medium.onnx" -o "$tmpv/en_US-lessac-medium.onnx"
			verify_sha256 "$tmpv/en_US-lessac-medium.onnx" "$(voice_model_sha en_US-lessac-medium.onnx)" "en_US-lessac-medium.onnx"
			curl -fL "$vbase/en_US-lessac-medium.onnx.json" -o "$tmpv/en_US-lessac-medium.onnx.json"
			verify_sha256 "$tmpv/en_US-lessac-medium.onnx.json" "$(voice_model_sha en_US-lessac-medium.onnx.json)" "en_US-lessac-medium.onnx.json"
			cp "$tmpv/en_US-lessac-medium.onnx" "$HOME/.gaia/voices/en_US-lessac-medium.onnx"
			cp "$tmpv/en_US-lessac-medium.onnx.json" "$HOME/.gaia/voices/en_US-lessac-medium.onnx.json"
			rm -rf "$tmpv"
		fi
		PIPER_VOICE=$HOME/.gaia/voices/en_US-lessac-medium.onnx

		# whisper.cpp binary (no macOS prebuilt on gh releases — brew install whisper-cpp)
		if command -v whisper-cli >/dev/null || command -v whisper >/dev/null; then
			echo "whisper: already installed"
		else
			case "$(uname -s)/$(uname -m)" in
				Linux/x86_64) wb=whisper-bin-ubuntu-x64.tar.gz ;;
				Linux/aarch64) wb=whisper-bin-ubuntu-arm64.tar.gz ;;
				*) wb="" ;;
			esac
			if [ -z "$wb" ]; then
				echo "no prebuilt whisper.cpp for $(uname -s)/$(uname -m) — install manually (e.g. brew install whisper-cpp)" >&2
			else
				tmp=$(mktemp -d)
				curl -fL "https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_VERSION}/$wb" -o "$tmp/w.tgz"
				verify_sha256 "$tmp/w.tgz" "$(whisper_sha "$wb")" "$wb"
				mkdir -p "$tmp/x" "$HOME/.gaia/whisper"
				tar -xzf "$tmp/w.tgz" -C "$tmp/x"
				wbin=$(find "$tmp/x" -type f \( -name whisper-cli -o -name whisper -o -name main \) | head -1)
				[ -n "$wbin" ] || { echo "whisper archive contained no binary" >&2; exit 1; }
				# keep the whole extracted dir (side-by-side libs, RUNPATH $ORIGIN)
				cp -a "$tmp/x/." "$HOME/.gaia/whisper/"
				chmod +x "$HOME/.gaia/whisper/$(basename "$wbin")"
				ln -sf "$HOME/.gaia/whisper/$(basename "$wbin")" "$BIN_DIR/whisper-cli"
				rm -rf "$tmp"
				echo "whisper installed: $wbin (symlinked as $BIN_DIR/whisper-cli)"
			fi
		fi

		# whisper model (base.en — decent accuracy, runs on CPU in a few seconds)
		if [ -s "$HOME/.gaia/whisper/ggml-base.en.bin" ]; then
			echo "whisper model: already downloaded"
		else
			echo "downloading ggml-base.en (~148 MB)"
			tmpw=$(mktemp -d)
			curl -fL "https://huggingface.co/ggerganov/whisper.cpp/resolve/${WHISPER_MODEL_COMMIT}/ggml-base.en.bin" \
				-o "$tmpw/ggml-base.en.bin"
			verify_sha256 "$tmpw/ggml-base.en.bin" "$(whisper_model_sha ggml-base.en.bin)" "ggml-base.en.bin"
			cp "$tmpw/ggml-base.en.bin" "$HOME/.gaia/whisper/ggml-base.en.bin"
			rm -rf "$tmpw"
		fi
		WHISPER_MODEL=$HOME/.gaia/whisper/ggml-base.en.bin

		# merge into config.json — works whether step 7 wrote it fresh or kept an existing one
		node - "$CONFIG" "$PIPER_VOICE" "$WHISPER_MODEL" <<'EOF'
const fs = require("fs");
const [path, piperVoice, whisperModel] = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync(path, "utf8"));
cfg.piperVoice = piperVoice;
cfg.whisperModel = whisperModel;
fs.writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
fs.chmodSync(path, 0o600);
EOF
		echo "voice enabled in $CONFIG"
		;;
	*) echo "skipped — voice stays disabled (no piperVoice/whisperModel in config)" ;;
	esac
fi

echo "==> 9/10 install systemd user service (autostart + restart on crash)"
need systemctl
mkdir -p "$HOME/.config/systemd/user"
sed "s|@NODE_BIN@|$(dirname "$(command -v node)")|; s|@BIN_DIR@|$BIN_DIR|" "$GAIA_DIR/gaia-gateway.service" \
	> "$HOME/.config/systemd/user/gaia-gateway.service"
systemctl --user daemon-reload
systemctl --user enable --now gaia-gateway.service
# start at boot without requiring a login session
loginctl enable-linger "$USER" 2>/dev/null \
	|| echo "note: enable-linger needs polkit/root — run 'sudo loginctl enable-linger $USER' once" >&2

# sandbox: the gateway refuses to start unsandboxed, so bubblewrap must exist.
if ! command -v bwrap >/dev/null && [ ! -x /usr/bin/bwrap ]; then
	echo "==> installing bubblewrap (the gateway's OS sandbox)"
	if command -v apt-get >/dev/null; then
		sudo apt-get install -y bubblewrap || echo "WARNING: could not install bubblewrap — the gateway will refuse to start; run 'sudo apt install bubblewrap'" >&2
	else
		echo "WARNING: install bubblewrap manually (the gateway will refuse to start without it)" >&2
	fi
fi

echo "==> 10/10 verify"
"$BIN_DIR/greenpi" --version
if command -v pi >/dev/null; then
	echo "existing pi untouched: $(pi --version) at $(command -v pi)"
fi
echo "GAIA now runs on the fork and as a service:"
echo "  systemctl --user status gaia-gateway     # state"
echo "  journalctl --user -u gaia-gateway -f     # logs"
if [ -n "$LOCAL_MODEL" ]; then
	echo "local model: llama.cpp router on http://127.0.0.1:8080 (curl http://127.0.0.1:8080/models for ids)"
else
	echo "no local model server installed — pick a model in chat with /model (any OpenAI-compatible"
	echo "endpoint or cloud provider works; see README \"Model Setup\")"
fi
echo "config lives in ~/.greenpi (fresh — add models.json/providers there as needed)"
echo "sandbox: the agent sees only its workspace (~/gaia-workspace, set \"workspace\" in the config) and its state dir — see docs/security-plan.md"
