#!/usr/bin/env bash
# install.sh — build & install GreenPi (fork of pi) as `greenpi`, and wire GAIA to it.
#
# - Never touches an existing `pi` install (isolated dir under ~/.greenpi, separate ~/.greenpi config).
# - Idempotent: re-run to update both GreenPi and GAIA.
# - Installs & runs a llama.cpp router (systemd user service) with the apertus default model.
# - Uninstall: systemctl --user disable --now pi-gateway llama-server
#   rm ~/.config/systemd/user/{pi-gateway,llama-server}.service
#   rm -rf ~/.greenpi ~/GreenPi && rm ~/.local/bin/greenpi
#   (revert GAIA: git checkout package.json package-lock.json && npm install)
#
# Usage: ./install.sh
# Env overrides: GREENPI_REPO GREENPI_SRC (~/GreenPi) GREENPI_HOME (~/.greenpi) GAIA_DIR (~/GAIA) BIN_DIR (~/.local/bin)
set -euo pipefail

LLAMA_VERSION=b10823 # pinned llama.cpp release; bump to update the bundled server
GREENPI_REPO="${GREENPI_REPO:-https://github.com/ColbyBrown/GreenPi}"
GREENPI_SRC="${GREENPI_SRC:-$HOME/GreenPi}"
GREENPI_HOME="${GREENPI_HOME:-$HOME/.greenpi}"
GAIA_DIR="${GAIA_DIR:-$HOME/GAIA}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"

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

echo "==> 2/10 brand fork as greenpi (config dir ~/.greenpi; bin stays 'pi' — local-release's shim expects it)"
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
ln -sf "$GREENPI_HOME/node/node_modules/.bin/pi" "$BIN_DIR/greenpi"
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

echo "==> 6/10 llama.cpp router (pinned build, systemd user service)"
need curl
LLAMA_DIR=$HOME/.greenpi/agent/llama
LLAMA_BIN=$LLAMA_DIR/bin/llama-server
if [ -x "$LLAMA_BIN" ]; then
	echo "llama-server already installed: $LLAMA_BIN"
else
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
	mkdir -p "$tmp/x" "$LLAMA_DIR/bin"
	tar -xzf "$tmp/a.tgz" -C "$tmp/x"
	# ship the whole dir: llama-server needs its side-by-side libs (RUNPATH $ORIGIN);
	# cp -a keeps the .so symlinks (libggml-base.so.0 -> ...) that find -type f drops.
	# newer release tarballs nest everything in a top-level dir — install from beside the binary
	bindir=$(dirname "$(find "$tmp/x" -name llama-server -type f | head -1)")
	cp -a "$bindir/." "$LLAMA_DIR/bin/"
	chmod -R 755 "$LLAMA_DIR/bin"
	rm -rf "$tmp"
fi

mkdir -p "$LLAMA_DIR/models" "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/llama-server.service" <<EOF
[Unit]
Description=llama.cpp router (GreenPi models)
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
	[ "$code" = 200 -o "$code" = 503 ] && break
	[ "$i" = 60 ] && { echo "llama-server did not become healthy — journalctl --user -u llama-server" >&2; exit 1; }
	sleep 1
done

MODEL_REPO=Colby/apertus-v1.5-8b-text-Q4_K_M-GGUF
if curl -s http://127.0.0.1:8080/models | grep -q apertus-v1.5-8b-text; then
	echo "apertus model already present on the router"
else
	echo "downloading $MODEL_REPO (one-time, a few GB — router shows progress in its log)"
	curl -sf -X POST http://127.0.0.1:8080/models -d "{\"model\":\"$MODEL_REPO\"}"
	for i in $(seq 1 1800); do
		curl -s http://127.0.0.1:8080/models | grep -q apertus-v1.5-8b-text && break
		[ "$i" = 1800 ] && { echo "model download timed out" >&2; exit 1; }
		sleep 2
	done
fi
MODEL_ID=$(curl -s http://127.0.0.1:8080/models | grep -o '"id":"[^"]*apertus[^"]*"' | head -1 | cut -d'"' -f4)
# router returns 400 "model is already running" on re-runs — don't let set -e kill the script silently
curl -sf -X POST http://127.0.0.1:8080/models/load -d "{\"model\":\"$MODEL_ID\"}" || true
for i in $(seq 1 300); do
	curl -s http://127.0.0.1:8080/models | grep -q '"loaded"' && { echo "model loaded: $MODEL_ID"; break; }
	[ "$i" = 300 ] && { echo "model load timed out" >&2; exit 1; }
	sleep 1
done

echo "==> 7/10 gateway config (~/.pi-gateway/config.json)"
CONFIG=$HOME/.pi-gateway/config.json
if [ -s "$CONFIG" ]; then
	echo "config exists, keeping it"
else
	mkdir -p "$(dirname "$CONFIG")"
	while true; do
		read -r -p "Telegram bot token (from @BotFather): " TOKEN
		[ -n "$TOKEN" ] || continue
		if curl -sf "https://api.telegram.org/bot$TOKEN/getMe" | grep -q '"ok":true'; then break; fi
		echo "token invalid or Telegram unreachable — retry" >&2
	done
	# best-effort: peek at recent messages to suggest the user's chat id
	DETECTED=$(curl -sf "https://api.telegram.org/bot$TOKEN/getUpdates" | grep -o '"chat":{"id":[0-9]*' | grep -o '[0-9]*' | sort -u | head -5 || true)
	[ -n "$DETECTED" ] && echo "chats seen by this bot: $(echo $DETECTED | tr '\n' ' ') (message the bot first if empty)"
	while true; do
		read -r -p "Your chat id to allow: " CHAT_ID
		case "$CHAT_ID" in ''|*[!0-9]*) echo "need a numeric chat id" >&2; continue;; esac
		break
	done
	# provider id 'llama-cpp' = GreenPi's llama.cpp router; model = the apertus default just loaded
	cat > "$CONFIG" <<EOF
{
  "telegramBotToken": "$TOKEN",
  "allowedChatIds": [$CHAT_ID],
  "model": { "provider": "llama-cpp", "id": "${MODEL_ID:-$MODEL_REPO}" }
}
EOF
	chmod 600 "$CONFIG"
	echo "wrote $CONFIG (model ids on the router: curl http://127.0.0.1:8080/models)"
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
				mkdir -p "$tmp/x" "$HOME/.pi-gateway/piper"
				tar -xzf "$tmp/p.tgz" -C "$tmp/x"
				cp -a "$tmp/x/piper/." "$HOME/.pi-gateway/piper/"
				ln -sf "$HOME/.pi-gateway/piper/piper" "$BIN_DIR/piper"
				rm -rf "$tmp"
				echo "piper installed: $HOME/.pi-gateway/piper/piper (symlinked as $BIN_DIR/piper)"
			fi
		fi

		# piper voice model
		mkdir -p "$HOME/.pi-gateway/voices"
		if [ -s "$HOME/.pi-gateway/voices/en_US-lessac-medium.onnx" ]; then
			echo "piper voice: already downloaded"
		else
			echo "downloading en_US-lessac-medium voice (~63 MB)"
			vbase=https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium
			curl -fL "$vbase/en_US-lessac-medium.onnx" -o "$HOME/.pi-gateway/voices/en_US-lessac-medium.onnx"
			curl -fL "$vbase/en_US-lessac-medium.onnx.json" -o "$HOME/.pi-gateway/voices/en_US-lessac-medium.onnx.json"
		fi
		PIPER_VOICE=$HOME/.pi-gateway/voices/en_US-lessac-medium.onnx

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
				curl -fL "https://github.com/ggml-org/whisper.cpp/releases/latest/download/$wb" -o "$tmp/w.tgz"
				mkdir -p "$tmp/x" "$HOME/.pi-gateway/whisper"
				tar -xzf "$tmp/w.tgz" -C "$tmp/x"
				wbin=$(find "$tmp/x" -type f \( -name whisper-cli -o -name whisper -o -name main \) | head -1)
				[ -n "$wbin" ] || { echo "whisper archive contained no binary" >&2; exit 1; }
				# keep the whole extracted dir (side-by-side libs, RUNPATH $ORIGIN)
				cp -a "$tmp/x/." "$HOME/.pi-gateway/whisper/"
				chmod +x "$HOME/.pi-gateway/whisper/$(basename "$wbin")"
				ln -sf "$HOME/.pi-gateway/whisper/$(basename "$wbin")" "$BIN_DIR/whisper-cli"
				rm -rf "$tmp"
				echo "whisper installed: $wbin (symlinked as $BIN_DIR/whisper-cli)"
			fi
		fi

		# whisper model (base.en — decent accuracy, runs on CPU in a few seconds)
		if [ -s "$HOME/.pi-gateway/whisper/ggml-base.en.bin" ]; then
			echo "whisper model: already downloaded"
		else
			echo "downloading ggml-base.en (~148 MB)"
			curl -fL https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin \
				-o "$HOME/.pi-gateway/whisper/ggml-base.en.bin"
			WHISPER_MODEL=$HOME/.pi-gateway/whisper/ggml-base.en.bin
		fi
		WHISPER_MODEL=$HOME/.pi-gateway/whisper/ggml-base.en.bin

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
sed "s|@NODE_BIN@|$(dirname "$(command -v node)")|" "$GAIA_DIR/pi-gateway.service" \
	> "$HOME/.config/systemd/user/pi-gateway.service"
systemctl --user daemon-reload
systemctl --user enable --now pi-gateway.service
# start at boot without requiring a login session
loginctl enable-linger "$USER" 2>/dev/null \
	|| echo "note: enable-linger needs polkit/root — run 'sudo loginctl enable-linger $USER' once" >&2

echo "==> 10/10 verify"
"$BIN_DIR/greenpi" --version
if command -v pi >/dev/null; then
	echo "existing pi untouched: $(pi --version) at $(command -v pi)"
fi
echo "GAIA now runs on the fork and as a service:"
echo "  systemctl --user status pi-gateway     # state"
echo "  journalctl --user -u pi-gateway -f     # logs"
echo "config lives in ~/.greenpi (fresh — add models.json/providers there as needed)"
