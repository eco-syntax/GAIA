#!/usr/bin/env bash
# install.sh — build & install GreenPi (fork of pi) as `greenpi`, and wire GAIA to it.
#
# - Never touches an existing `pi` install (isolated dir under ~/.greenpi, separate ~/.greenpi config).
# - Idempotent: re-run to update both GreenPi and GAIA.
# - Uninstall: systemctl --user disable --now pi-gateway && rm ~/.config/systemd/user/pi-gateway.service
#   rm -rf ~/.greenpi ~/GreenPi && rm ~/.local/bin/greenpi
#   (revert GAIA: git checkout package.json package-lock.json && npm install)
#
# Usage: ./install.sh
# Env overrides: GREENPI_REPO GREENPI_SRC (~/GreenPi) GREENPI_HOME (~/.greenpi) GAIA_DIR (~/GAIA) BIN_DIR (~/.local/bin)
set -euo pipefail

GREENPI_REPO="${GREENPI_REPO:-https://github.com/ColbyBrown/GreenPi}"
GREENPI_SRC="${GREENPI_SRC:-$HOME/GreenPi}"
GREENPI_HOME="${GREENPI_HOME:-$HOME/.greenpi}"
GAIA_DIR="${GAIA_DIR:-$HOME/GAIA}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"

need() { command -v "$1" >/dev/null || { echo "missing dependency: $1" >&2; exit 1; }; }
need git
need npm
node_major=$(node -p 'process.versions.node.split(".")[0]')
[ "$node_major" -ge 22 ] || { echo "need node >= 22 (GAIA requires it), have $(node --version)" >&2; exit 1; }

echo "==> 1/6 clone or update $GREENPI_SRC"
if [ -d "$GREENPI_SRC/.git" ]; then
	# our package.json brand patch is tracked-file dirt; stash it around the pull
	git -C "$GREENPI_SRC" stash -q 2>/dev/null || true
	git -C "$GREENPI_SRC" pull --ff-only -q
	git -C "$GREENPI_SRC" stash pop -q 2>/dev/null || true
else
	git clone -q "$GREENPI_REPO" "$GREENPI_SRC"
fi

echo "==> 2/6 brand fork as greenpi (config dir ~/.greenpi; bin stays 'pi' — local-release's shim expects it)"
node - "$GREENPI_SRC" <<'EOF'
const fs = require("fs");
const p = `${process.argv[2]}/packages/coding-agent/package.json`;
const pkg = JSON.parse(fs.readFileSync(p, "utf8"));
pkg.piConfig = { ...pkg.piConfig, name: "greenpi", configDir: ".greenpi" };
fs.writeFileSync(p, JSON.stringify(pkg, null, "\t") + "\n");
EOF

echo "==> 3/6 install deps + build + pack tarballs (no bun needed)"
cd "$GREENPI_SRC"
npm install --no-fund --no-audit
node scripts/local-release.mjs \
	--out "$GREENPI_HOME" --force \
	--skip-check --skip-test --skip-install --skip-bun-install
# leaves tarballs in $GREENPI_HOME/tarballs/; skips the bun binary build entirely

echo "==> 4/6 isolated greenpi install at $GREENPI_HOME/node"
mkdir -p "$GREENPI_HOME/node"
node - "$GREENPI_HOME" <<'EOF'
const fs = require("fs");
const home = process.argv[2];
const dir = `${home}/tarballs`;
const deps = {};
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".tgz"))) {
	const m = f.slice(0, -4).match(/^(.*)-(\d+\..*)$/); // "@earendil-works+pi-ai-0.85.2" → scope+name, version
	if (!m) throw new Error(`unexpected tarball name: ${f}`);
	deps[m[1].replace("+", "/")] = `file:${dir}/${f}`;
}
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

echo "==> 5/6 wire GAIA ($GAIA_DIR) to the GreenPi tarballs"
	[ -d "$GAIA_DIR" ] || { echo "GAIA not found at $GAIA_DIR (set GAIA_DIR)" >&2; exit 1; }
	# point the two pi deps at the fork AND override every internal @earendil-works dep with the
	# fork's tarballs — otherwise nested deps resolve from the npm registry (upstream pi) and the
	# local-first provider changes in packages/ai silently don't ship
	node - "$GAIA_DIR" "$GREENPI_HOME" <<'EOF'
const fs = require("fs");
const [gaia, home] = process.argv.slice(2);
const dir = `${home}/tarballs`;
const p = `${gaia}/package.json`;
const pkg = JSON.parse(fs.readFileSync(p, "utf8"));
const deps = {};
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".tgz"))) {
	const m = f.slice(0, -4).match(/^(.*)-(\d+\..*)$/);
	if (!m) throw new Error(`unexpected tarball name: ${f}`);
	deps[m[1].replace("+", "/")] = `file:${dir}/${f}`;
}
for (const dep of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-server"]) {
	pkg.dependencies[dep] = deps[dep];
}
pkg.overrides = deps;
fs.writeFileSync(p, JSON.stringify(pkg, null, "\t") + "\n");
EOF
	(cd "$GAIA_DIR" && npm install --no-fund --no-audit)

echo "==> 6/7 install systemd user service (autostart + restart on crash)"
need systemctl
mkdir -p "$HOME/.config/systemd/user"
sed "s|@NODE_BIN@|$(dirname "$(command -v node)")|" "$GAIA_DIR/pi-gateway.service" \
	> "$HOME/.config/systemd/user/pi-gateway.service"
systemctl --user daemon-reload
systemctl --user enable --now pi-gateway.service
# start at boot without requiring a login session
loginctl enable-linger "$USER" 2>/dev/null \
	|| echo "note: enable-linger needs polkit/root — run 'sudo loginctl enable-linger $USER' once" >&2

echo "==> 7/7 verify"
"$BIN_DIR/greenpi" --version
if command -v pi >/dev/null; then
	echo "existing pi untouched: $(pi --version) at $(command -v pi)"
fi
echo "GAIA now runs on the fork and as a service:"
echo "  systemctl --user status pi-gateway     # state"
echo "  journalctl --user -u pi-gateway -f     # logs"
echo "config lives in ~/.greenpi (fresh — add models.json/providers there as needed)"
