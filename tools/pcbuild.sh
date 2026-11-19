#!/bin/bash
# PC build + headless run of powerboat on the WSL host (x86_64, Mesa llvmpipe under Xvfb), for
# fast iteration before a device build. Uses the same rustup/cargo install as the Docker builds.
#   bash tools/pcbuild.sh                 # build (debug profile) only
#   bash tools/pcbuild.sh run [secs]      # build, then run examples/m0.js in Xvfb, screenshot to dist/pc_m0.png
#   bash tools/pcbuild.sh run <script.js> [secs]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/.." && pwd)
cache=$HOME/.cache/powerboat
export CARGO_HOME=$cache/cargo RUSTUP_HOME=$cache/cargo PATH="$cache/cargo/bin:$PATH"
export CARGO_TARGET_DIR=$cache/target-host
cd "$repo/powerboat"
cargo build 2>&1 | grep -v "^ *Compiling" | tail -n 60
bin=$CARGO_TARGET_DIR/debug/powerboat
[ "${1:-}" = run ] || exit 0
script=${2:-examples/m0.js}; secs=${3:-4}
case "$script" in [0-9]*) secs=$script; script=examples/m0.js;; esac
# Own display number (never kill other sessions' Xvfb).
D=:71
Xvfb $D -screen 0 1024x768x24 -nolisten tcp >/dev/null 2>&1 &
XPID=$!
trap 'kill $XPID 2>/dev/null || true' EXIT
sleep 1
mkdir -p "$repo/dist"
set +e
DISPLAY=$D SDL_VIDEODRIVER=x11 LIBGL_ALWAYS_SOFTWARE=1 \
  "$bin" --script "$script" --window 640x480 --secs "$secs" --shot "$repo/dist/pc_m0.ppm" --shot-at 1.5
rc=$?
set -e
echo "exit code $rc"
if [ -f "$repo/dist/pc_m0.ppm" ]; then
  python3 - "$repo/dist/pc_m0.ppm" "$repo/dist/pc_m0.png" <<'PY' || echo "(no PIL: ppm kept)"
import sys
from PIL import Image
Image.open(sys.argv[1]).save(sys.argv[2]); print("wrote", sys.argv[2])
PY
fi
exit $rc
