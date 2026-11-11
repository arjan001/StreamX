#!/usr/bin/env bash
# Build the streamix libav.js variant (LGPL-2.1 FFmpeg, no GPL, no nonfree,
# no external codec libraries) in a throwaway Docker container.
#
#   apps/web/libav/build.sh
#
# Output: apps/web/libav/dist/ (committed — see scripts/libav-assets.mjs for why).
# Needs: docker, npm, tar, xz. Takes about fifteen minutes.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
VER=6.10.9
FFVER=9.0
WORK="${LIBAV_WORK:-$HERE/.build}"
IMAGE="${EMSDK_IMAGE:-emscripten/emsdk:6.0.10}"   # the Emscripten the shipped files were built with
NAME="streamix-libav-build-$$"

mkdir -p "$WORK" "$HERE/dist"
cd "$WORK"
if [ ! -d pkg ]; then
  npm pack "libav.js@$VER" >/dev/null
  mkdir pkg && tar xzf "libav.js-$VER.tgz" -C pkg --strip-components=1
fi
if [ ! -d src ]; then
  mkdir src && tar xJf pkg/sources/libav.js.tar.xz -C src
  mkdir -p src/build && cp "pkg/sources/ffmpeg-$FFVER.tar.xz" src/build/
fi
FRAGMENTS="$(tr -d '\n' < "$HERE/config.json")"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run --name "$NAME" -v "$WORK/src:/work" -w /work "$IMAGE" bash -euc "
  apt-get update -qq && apt-get install -y -qq m4 pkg-config >/dev/null
  npm install --no-audit --no-fund >/dev/null
  (cd configs && ./mkconfig.js streamix '$FRAGMENTS')
  make -j\$(nproc) dist/libav-$VER.0-streamix.wasm.mjs dist/libav-$VER.0-streamix.mjs dist/libav.types.d.ts
  chown -R $(id -u):$(id -g) /work
"

OUT="$WORK/src/dist"
cp "$OUT/libav-$VER.0-streamix.mjs" "$HERE/dist/libav-streamix.mjs"
cp "$OUT/libav-$VER.0-streamix.wasm.mjs" "$HERE/dist/libav-streamix.wasm.mjs"
cp "$OUT/libav-$VER.0-streamix.wasm.wasm" "$HERE/dist/libav-streamix.wasm.wasm"
cp "$OUT/libav.types.d.ts" "$HERE/dist/libav.types.d.ts"
cp "$WORK/src/configs/configs/streamix/config.json" "$HERE/dist/config.json"
grep -h "FFMPEG_CONFIGURATION\|FFMPEG_LICENSE" "$WORK/src/build/ffmpeg-$FFVER/build-base-streamix/config.h" > "$HERE/dist/ffmpeg-configuration.txt" || true
echo "built into $HERE/dist"
