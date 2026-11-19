#!/bin/bash
# WSL: h5bench (github.com/Knifethrower/h5bench, a checkout in $H5BENCH) on the PC build of the runtime under Xvfb. Every page by default, or one.
#   bash tools/h5bench_pc.sh <label> [page.html] [secs]     env BIN= (default: the target-host debug build)
# Writes $H5BENCH/results/<label>.log and .json.
label=${1:?label}; page=${2:-index.html}; secs=${3:-900}
bin=${BIN:-$HOME/.cache/powerboat/target-host/debug/powerboat}
B=${H5BENCH:?path to an h5bench checkout}
mkdir -p "$B/results" /tmp/h5b-data
Xvfb :76 -screen 0 1280x1024x24 -nolisten tcp >/dev/null 2>&1 &
X=$!
trap 'kill $X 2>/dev/null' EXIT
sleep 1
cd /tmp
DISPLAY=:76 SDL_AUDIODRIVER=dummy POWERBOAT_DATA_DIR=/tmp/h5b-data POWERBOAT_FONT_DIR="${POWERBOAT_FONT_DIR:-$REPO/fonts}" POWERBOAT_INDEX="$page" timeout $((secs + 60)) "$bin" --game "$B" --window 640x480 --secs "$secs" > "$B/results/$label.log" 2>&1
echo "exit $?"
cd "$B" && python3 tools/h5bench.py parse "results/$label.log" -o "results/$label.json" --label "$label"
