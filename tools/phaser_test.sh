#!/bin/bash
# Runs the Phaser test scenes (tests/phaser) on the PC in Xvfb with llvmpipe and sends them keys and
# clicks with xdotool. Writes tests/phaser/shots/<name>.png and .log; prints the T lines.
#   bash tools/phaser_test.sh [names, default all: p2 p2_canvas p3 p3_canvas p4 p4_canvas] (env WIN=WxH)
set -uo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
cache=$HOME/.cache/powerboat
export CARGO_HOME=$cache/cargo RUSTUP_HOME=$cache/cargo PATH="$cache/cargo/bin:$PATH" CARGO_TARGET_DIR=$cache/target-host
bin=$CARGO_TARGET_DIR/debug/powerboat
root=$repo/tests/phaser
SUFFIX=${SUFFIX:-}
win=${WIN:-640x480}
W=${win%x*}; H=${win#*x}
names=${*:-p2 p2_canvas p3 p3_canvas p4 p4_canvas}
mkdir -p "$root/shots"
tmp=$HOME/.cache/powerboat/phaser-xvfb
mkdir -p "$tmp"; cp -f "$(command -v Xvfb)" "$tmp/phXvfb"
D=:$((7100 + RANDOM % 800))
"$tmp/phXvfb" $D -screen 0 1280x1024x24 -nolisten tcp >/dev/null 2>&1 &
XPID=$!
trap 'kill $XPID 2>/dev/null || true' EXIT
for _ in 1 2 3 4 5 6 7 8 9 10; do DISPLAY=$D xdpyinfo >/dev/null 2>&1 && break; sleep 0.3; done
for n in $names; do
  log=$root/shots/$n$SUFFIX.log
  DISPLAY=$D SDL_VIDEODRIVER=x11 LIBGL_ALWAYS_SOFTWARE=1 POWERBOAT_CODE_CACHE=0 POWERBOAT_FONT_DIR=$repo/fonts POWERBOAT_DATA_DIR=$tmp POWERBOAT_INDEX=index_$n.html \
    timeout -k 3 $((${SECS:-30} + 10)) "$bin" --game "$root" --window "$win" --secs ${SECS:-30} >"$log" 2>&1 &
  RPID=$!
  (
    # llvmpipe boots slowly: input at 9 s, a picture of the real window at 16 s.
    sleep 9
    w=$(DISPLAY=$D xdotool search --name '.' 2>/dev/null | tail -1)
    [ -n "$w" ] && DISPLAY=$D xdotool windowfocus "$w" 2>/dev/null
    DISPLAY=$D xdotool keydown Right; sleep 0.4; DISPLAY=$D xdotool keyup Right
    DISPLAY=$D xdotool key z
    # Click where game point (400,300) should land on a FIT-scaled, centered picture.
    read -r cx cy < <(python3 -c "s=min($W/640,$H/480);print(int(($W-640*s)/2+400*s),int(($H-480*s)/2+300*s))")
    DISPLAY=$D xdotool mousemove --window "$w" "$cx" "$cy"; sleep 0.2; DISPLAY=$D xdotool click 1
    sleep ${SHOT_DELAY:-6}
    eval "$(DISPLAY=$D xdotool getwindowgeometry --shell "$w" | grep -E '^[XY]=')"
    python3 -c "from PIL import ImageGrab; ImageGrab.grab(xdisplay='$D').crop(($X,$Y,$X+$W,$Y+$H)).save('$root/shots/$n$SUFFIX.png')"
  ) &
  wait $RPID; echo "== $n exit $?"
  grep -aE '^T |panic|Uncaught|TypeError|ReferenceError|Error:' "$log" | cut -c1-260
done
