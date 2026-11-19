#!/bin/bash
# WSL: host build, then examples/t_fbo.js (framebuffer semantics) under a private Xvfb (llvmpipe), once with
# gl.rs's FboCache (the default) and once with POWERBOAT_FBO_PER_TEXTURE=0; prints both results and their diff.
# The 80x80 window makes the 64x64 canvas an FBO (main_fbo), as on the handhelds.
#   bash "$REPO/tools/t_fbo_check.sh"
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/.." && pwd)
cache=$HOME/.cache/powerboat
export CARGO_HOME=$cache/cargo RUSTUP_HOME=$cache/cargo PATH="$cache/cargo/bin:$PATH" CARGO_TARGET_DIR=$cache/target-host
(cd "$repo/powerboat" && cargo build 2>&1 | grep -E "^(error|warning: unused)" -A 8 | head -n 60)
bin=$CARGO_TARGET_DIR/debug/powerboat
mkdir -p ~/c3test; [ -x ~/c3test/fboXvfb ] || cp /usr/bin/Xvfb ~/c3test/fboXvfb
n=860; while [ -e /tmp/.X$n-lock ]; do n=$((n + 1)); done; D=:$n
~/c3test/fboXvfb $D -screen 0 1024x768x24 -nolisten tcp >/dev/null 2>&1 &
XPID=$!
trap 'kill $XPID 2>/dev/null || true' EXIT
for i in $(seq 50); do xdpyinfo -display $D >/dev/null 2>&1 && break; sleep 0.2; done
w=$(mktemp -d)
for mode in on off; do
  v=; [ $mode = off ] && v=0
  DISPLAY=$D SDL_VIDEODRIVER=x11 LIBGL_ALWAYS_SOFTWARE=1 POWERBOAT_FBO_PER_TEXTURE=$v \
    timeout 60 "$bin" --script "$repo/powerboat/examples/t_fbo.js" --window 80x80 --secs 2 2>&1 | grep "t_fbo:" > "$w/$mode.txt"
  echo "== FBO cache $mode"; cat "$w/$mode.txt"
done
echo "== diff (on vs off; only the last line's env note may differ)"
diff "$w/on.txt" "$w/off.txt" && echo "(identical)"
rm -rf "$w"
