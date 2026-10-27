#!/usr/bin/env bash
# Stage the docker build context and build the gaia-gateway image.
#
# The image must contain the GreenPi fork's packages, which exist only as local
# tarballs (~/.greenpi/tarballs after install.sh, or built from ~/GreenPi).
# This script:
#   1. builds the tarballs if they are missing (requires ~/GreenPi)
#   2. copies GAIA + tarballs into docker/context/
#   3. rewrites package.json's file:/home/<you>/.greenpi/... paths to the
#      in-context greenpi/ folder
#   4. runs docker build  (skipped with STAGE_ONLY=1 — CI does its own buildx)
#
# Usage: ./docker/build.sh [image-tag]              (default: gaia:local)
#        STAGE_ONLY=1 ./docker/build.sh             (context only, no build)
set -euo pipefail

cd "$(dirname "$0")/.."
GAIA_DIR="$PWD"
TAG="${1:-gaia:local}"
TARBALL_SRC="${GREENPI_TARBALLS:-$HOME/.greenpi/tarballs}"
GREENPI_SRC="${GREENPI_SRC:-$HOME/GreenPi}"

if [ ! -d "$TARBALL_SRC" ] || [ -z "$(ls "$TARBALL_SRC"/*.tgz 2>/dev/null)" ]; then
	echo "No GreenPi tarballs at $TARBALL_SRC — building them from $GREENPI_SRC"
	if [ ! -d "$GREENPI_SRC" ]; then
		echo "GreenPi not found at $GREENPI_SRC; clone it or set GREENPI_SRC" >&2
		exit 1
	fi
	(cd "$GREENPI_SRC" && node scripts/local-release.mjs --out "$HOME/.greenpi" --force \
		--skip-check --skip-test --skip-install --skip-bun-install >/dev/null)
fi

CTX=docker/context
rm -rf "$CTX"
mkdir -p "$CTX/greenpi"
cp -r "$TARBALL_SRC"/*.tgz "$CTX/greenpi/"
cp -r src tsconfig.json "$CTX/"
cp docker/Dockerfile "$CTX/Dockerfile"

# Point the image's npm install at the in-context tarballs. GAIA's committed
# package.json carries machine-local file: paths (whatever home install.sh ran
# on), so match any absolute path ending in /tarballs/.
sed -E "s|file:[^\"]*/tarballs/|file:./greenpi/|g" package.json > "$CTX/package.json"
if grep -qE 'file:[^" ]*tarballs/' "$CTX/package.json"; then
	echo "package.json still references tarballs outside the context after rewrite" >&2
	exit 1
fi

if [ "${STAGE_ONLY:-0}" = "1" ]; then
	echo "Staged $CTX (STAGE_ONLY — skipping docker build)"
	exit 0
fi

docker build -t "$TAG" "$CTX"
echo "Built $TAG — start it with: docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d"
