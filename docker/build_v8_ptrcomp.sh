#!/bin/bash
# Builds rusty_v8 (the v8 crate deno_core uses) from source for aarch64 with pointer compression,
# which rusty_v8 publishes prebuilt only for x86_64 (and never together with simdutf, which
# deno_core turns on). The crates.io package lacks files a source build needs (icudtl.dat, vendored
# crates' build.rs), so this uses the git tag with its submodules, as rusty_v8's README says.
# Output, for docker/build.sh (RUSTY_V8_ARCHIVE, RUSTY_V8_SRC_BINDING_PATH):
#   ~/.cache/powerboat/v8-ptrcomp-aarch64/{librusty_v8.a,src_binding.rs}
# rusty_v8's build.rs downloads Chromium's clang, gn/ninja and the Debian arm64 sysroot itself.
# Run in WSL as the build user (about an hour on 12 cores, a few GB of checkout):
#   bash docker/build_v8_ptrcomp.sh
# Env: V8_EXTRA_GN_ARGS (passed to rusty_v8 as EXTRA_GN_ARGS, e.g. 'v8_enable_builtins_profiling=true'
# for a builtins-PGO profiling build), V8_OUT (output folder, default v8-ptrcomp-aarch64).
set -euo pipefail
cache=$HOME/.cache/powerboat
out=${V8_OUT:-$cache/v8-ptrcomp-aarch64}
src=$cache/rusty_v8-v150.4.0
export CARGO_HOME=$cache/cargo RUSTUP_HOME=$cache/cargo PATH="$cache/cargo/bin:$PATH"
rustup target add aarch64-unknown-linux-gnu >/dev/null
mkdir -p "$out"
if [ ! -f "$src/Cargo.toml" ]; then
  git clone --depth 1 --branch v150.4.0 --recurse-submodules --shallow-submodules -j 8 \
    https://github.com/denoland/rusty_v8.git "$src"
fi
cd "$src"
git submodule update --init --recursive --depth 1 -j 8 >/dev/null
obj=$src/target/aarch64-unknown-linux-gnu/release/gn_out/obj
stamp=$(date +%s)
# The last step (bindgen) fails with this system's libclang, too old for Chromium's libc++; the
# library is built by then, so the cargo status is not the verdict: a librusty_v8.a newer than this
# run is. The binding file is the same for every rusty_v8 variant (md5-checked on 2026-10-29), so
# the published aarch64 one is used.
EXTRA_GN_ARGS="${V8_EXTRA_GN_ARGS:-}" V8_FROM_SOURCE=1 CARGO_TARGET_DIR=$src/target \
  cargo build --release --target aarch64-unknown-linux-gnu --features v8_enable_pointer_compression,simdutf 2>&1 | tail -n 30 || true
lib=$obj/librusty_v8.a
[ -f "$lib" ] && [ "$(stat -c %Y "$lib")" -ge "$stamp" ] || { echo "librusty_v8.a was not (re)built"; exit 1; }
binding=$cache/v8-ptrcomp-x86/src_binding_release_aarch64-unknown-linux-gnu.rs
[ -f "$binding" ] || curl -sfL -o "$binding" https://github.com/denoland/rusty_v8/releases/download/v150.4.0/src_binding_release_aarch64-unknown-linux-gnu.rs
cp "$lib" "$out/librusty_v8.a"
cp "$binding" "$out/src_binding.rs"
ls -la "$out"
