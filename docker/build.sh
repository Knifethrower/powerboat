#!/bin/bash
# Cross-builds powerboat/ (the HTML5 runtime) for aarch64 in the powerboat-cross image (Ubuntu 22.04 toolchain) and
# links it against Debian 10's glibc 2.28 (WSL ~/sysroot-buster/root, the sysroot box64 uses), so
# the binary runs on every glibc >= 2.28. libSDL2 and libvpx.a come from the image, each from a
# folder of its own so Ubuntu's newer libc never enters the link. Caches (cargo, target, rustup)
# live in ~/.cache/powerboat (shared with Powerboat). Output: dist/powerboat.aarch64
# (+ dist/build-aarch64.txt). Image: docker/Dockerfile.construct (powerboat-cross-base + libopus).
# usage (WSL): bash "$REPO/docker/build.sh" [--check]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/.." && pwd)
cache=$HOME/.cache/powerboat
sysroot=${POWERBOAT_SYSROOT:-$HOME/sysroot-buster/root}
FLOOR=2.28
[ -f "$sysroot/usr/lib/aarch64-linux-gnu/libc.so" ] || { echo "no glibc sysroot at $sysroot"; exit 1; }
mkdir -p "$cache/target" "$cache/cargo" "$repo/dist"
MODE=${1:-build}
# V8 with pointer compression (docker/build_v8_ptrcomp.sh output; cargo feature ptrcomp, own target
# dir) is the default when it is there: on the RG Cube XX it cut Janosik's JS per frame 33 -> 27 ms
# (30 -> 36 fps) and peak RSS by 55 MB. V8_PTRCOMP=0 builds the plain prebuilt V8 into
# dist/powerboat-noptrcomp.aarch64.
# V8PC_DIR: another build_v8_ptrcomp.sh output (e.g. the builtins-profiling V8) for this build only.
v8pc=${V8PC_DIR:-$cache/v8-ptrcomp-aarch64}
# An alternative V8 gets its own cargo target dir: inside the container the archive path is the same
# (/v8pc/librusty_v8.a), so cargo would not notice the switch and keep the old link.
tsub=ptrcomp${V8PC_DIR:+-$(basename "$V8PC_DIR")}
# TARGET_TAG: a target dir of its own for a second checkout (git worktree): sharing one, cargo can take
# this checkout's older files for up to date and hand back the other checkout's build.
tsub=$tsub${TARGET_TAG:+-$TARGET_TAG}
PC=1
if [ "${V8_PTRCOMP:-}" = 0 ] || [ ! -f "$v8pc/librusty_v8.a" ]; then PC=; fi
[ -z "$PC" ] && [ "${V8_PTRCOMP:-}" != 0 ] && echo "note: no $v8pc/librusty_v8.a (build_v8_ptrcomp.sh): plain V8"
mkdir -p "$v8pc"
sg docker -c "docker run --rm -i --network host \
  -v '$repo':/repo -v '$cache/target':/target -v '$cache/cargo':/cargo -v '$sysroot':/sysroot:ro -v '$v8pc':/v8pc:ro \
  -e CARGO_TARGET_DIR=/target${PC:+/$tsub} -e CARGO_HOME=/cargo -e RUSTUP_HOME=/cargo -e PC=$PC -e OUT_NAME=${OUT_NAME:-} \
  ${PC:+-e RUSTY_V8_ARCHIVE=/v8pc/librusty_v8.a -e RUSTY_V8_SRC_BINDING_PATH=/v8pc/src_binding.rs} \
  -e HOST_UID=$(id -u) -e HOST_GID=$(id -g) -e MODE=$MODE -e FLOOR=$FLOOR \
  powerboat-cross bash -eus" <<'CONTAINER'
set -o pipefail
export PATH="/cargo/bin:$PATH"
command -v cargo >/dev/null || curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs \
  | sh -s -- -y --no-modify-path --default-toolchain stable --profile minimal
rustup target add aarch64-unknown-linux-gnu >/dev/null
# libSDL2 (linked by name; the device's own is used at run time) and static libvpx, alone.
mkdir -p /tmp/link-sdl /tmp/link-vpx
ln -sf /usr/lib/aarch64-linux-gnu/libopus.a /tmp/link-vpx/libopus.a
ln -sf /usr/lib/aarch64-linux-gnu/libSDL2-2.0.so.0 /tmp/link-sdl/libSDL2.so
ln -sf /usr/lib/aarch64-linux-gnu/libvpx.a /tmp/link-vpx/libvpx.a
export POWERBOAT_VPX_LIB_DIR=/tmp/link-vpx
# The encoder shim (src/enc_shim.c) needs the vpx/opus headers only, not the image's whole /usr/include.
mkdir -p /tmp/link-inc && ln -sfn /usr/include/vpx /tmp/link-inc/vpx && ln -sfn /usr/include/opus /tmp/link-inc/opus
export POWERBOAT_ENC_INCLUDE=/tmp/link-inc
# C/C++ built by build scripts sees Debian 10's headers too.
export CFLAGS_aarch64_unknown_linux_gnu="--sysroot=/sysroot" CXXFLAGS_aarch64_unknown_linux_gnu="--sysroot=/sysroot"
cd /repo/powerboat
# ARMv8.0 baseline (A35/A53/A55/A72 all run it); --gc-sections drops unreferenced C/C++.
# --allow-shlib-undefined: the image's libSDL2 itself wants glibc 2.34, which is not our concern.
# Ubuntu's cross gcc searches its own glibc (/usr/aarch64-linux-gnu) whatever --sysroot says, so
# the sysroot's folders come first by -B/-L (as box64's buster build does).
SR="-C link-arg=--sysroot=/sysroot -C link-arg=-B/sysroot/usr/lib/aarch64-linux-gnu"
SR="$SR -C link-arg=-L/sysroot/lib/aarch64-linux-gnu -C link-arg=-L/sysroot/usr/lib/aarch64-linux-gnu"
SR="$SR -C link-arg=-Wl,-rpath-link,/sysroot/lib/aarch64-linux-gnu"
export RUSTFLAGS="-C link-arg=-Wl,--gc-sections $SR -C link-arg=-Wl,--allow-shlib-undefined -L native=/tmp/link-sdl"
# --locked: build exactly what Cargo.lock names. A Cargo.toml change without its lock update stops here
# instead of resolving new crate versions silently (run a PC build, which updates the lock, and commit both).
if [ "$MODE" = "--check" ]; then
  cargo check --locked --release --target aarch64-unknown-linux-gnu
  exit 0
fi
cargo build --locked --release --target aarch64-unknown-linux-gnu ${PC:+--features ptrcomp} 2>&1 | tail -n 40
out=$CARGO_TARGET_DIR/aarch64-unknown-linux-gnu/release/powerboat
name=powerboat.aarch64
[ -z "$PC" ] && name=powerboat-noptrcomp.aarch64
# OUT_NAME: another output file (a V8PC_DIR test build must not replace the default runtime).
name=${OUT_NAME:-$name}
cp "$out" /repo/dist/$name
aarch64-linux-gnu-strip /repo/dist/$name
{
  file /repo/dist/$name
  aarch64-linux-gnu-readelf -d /repo/dist/$name | grep NEEDED
  hi=$(aarch64-linux-gnu-readelf -V /repo/dist/$name | grep -o 'GLIBC_2\.[0-9]*' | sort -uV | tail -1)
  echo "highest glibc symbol: $hi (floor $FLOOR)"
  ls -la /repo/dist/$name
  [ "$(printf '%s\n%s\n' "$hi" "GLIBC_$FLOOR" | sort -V | tail -1)" = "GLIBC_$FLOOR" ] || { echo "FAIL: above the $FLOOR floor"; exit 1; }
} | tee /repo/dist/build-aarch64.txt
chown -R "$HOST_UID:$HOST_GID" /target /cargo /repo/dist
CONTAINER
