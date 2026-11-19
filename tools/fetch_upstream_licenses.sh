#!/bin/bash
# Fetches the license texts of what rusty_v8's prebuilt librusty_v8.a links into powerboat (the v8
# crate ships none), pinned to the revisions V8 15.0.245.2's DEPS names (rusty_v8 v150.4.0).
# Which parts are linked was read from the binary's symbols (2026-10-13): V8, ICU, libc++/libc++abi,
# llvm-libc, abseil, simdutf, fast_float, dragonbox, fp16, inspector_protocol (crdtp), utf8-decoder.
# Not linked: highway, zlib, re2, V8's third_party/glibc. PartitionAlloc is linked since the source build (below).
# Output: tools/upstream-licenses/<name>.txt (kept in the repo; collect_licenses.py reads them).
set -euo pipefail
out=$(cd "$(dirname "$0")" && pwd)/upstream-licenses
mkdir -p "$out"
G=https://chromium.googlesource.com
gs() { curl -fsSL "$G/$1/+/$2/$3?format=TEXT" | base64 -d > "$out/$4"; echo "$4 <- $G/$1 @ $2 $3"; }
gh() { curl -fsSL "https://raw.githubusercontent.com/$1/$2/$3" > "$out/$4"; echo "$4 <- github $1 @ $2 $3"; }
gh v8/v8 15.0.245.2 LICENSE v8.LICENSE
gh v8/v8 15.0.245.2 LICENSE.fdlibm v8.LICENSE.fdlibm
gh v8/v8 15.0.245.2 LICENSE.strongtalk v8.LICENSE.strongtalk
gh v8/v8 15.0.245.2 third_party/utf8-decoder/LICENSE utf8-decoder.LICENSE
gh v8/v8 15.0.245.2 third_party/inspector_protocol/LICENSE inspector_protocol.LICENSE
gh denoland/rusty_v8 v150.4.0 LICENSE rusty_v8.LICENSE
gs chromium/deps/icu ee5f27adc28bd3f15b2c293f726d14d2e336cbd5 LICENSE icu.LICENSE
gs chromium/src/third_party/abseil-cpp d16e32215c3ab90ba57c2e904a5344d85c7353e4 LICENSE abseil-cpp.LICENSE
gs chromium/src/third_party/simdutf f7356eed293f8208c40b3c1b344a50bd70971983 LICENSE simdutf.LICENSE
gh fastfloat/fast_float 05087a303dad9c98768b33c829d398223a649bc6 LICENSE-MIT fast_float.LICENSE-MIT
gh jk-jeon/dragonbox beeeef91cf6fef89a4d4ba5e95d47ca64ccb3a44 LICENSE-Boost dragonbox.LICENSE-Boost
gh Maratyszcza/FP16 3d2de1816307bac63c16a297e8c4dc501b4076df LICENSE fp16.LICENSE
gs external/github.com/llvm/llvm-project/libcxx 5abc7f839700f0f17338434e1c1c6a8c87c00c11 LICENSE.TXT libcxx.LICENSE
gs external/github.com/llvm/llvm-project/libcxxabi 8f11bb1d4438d0239d0dfc1bd9456a9f31629dda LICENSE.TXT libcxxabi.LICENSE
gs external/github.com/llvm/llvm-project/libc 9309c117ebae84dd2f9df1ef99de4782162527d5 LICENSE.TXT llvm-libc.LICENSE
# Since 2026-10-29 V8 is built from source with pointer compression (docker/build_v8_ptrcomp.sh), and that
# build links PartitionAlloc too (its file paths are in the binary's strings; checked 2026-11-07). Highway is
# built but dropped at link time (none of its strings are in the binary). PartitionAlloc's own repository
# (ff3b8b885b83) has no license file: its sources point to Chromium's LICENSE. siphash and rapidhash are
# V8's own third_party code, compiled into V8's objects.
gs chromium/src main LICENSE chromium.LICENSE
gh v8/v8 15.0.245.2 third_party/siphash/LICENSE siphash.LICENSE
gh v8/v8 15.0.245.2 third_party/rapidhash-v8/LICENSE rapidhash.LICENSE
wc -c "$out"/*

# Crates whose package has no license file (collect_licenses.py CRATE_TEXTS maps them to these).
gh denoland/deno_core HEAD LICENSE.md deno_core.LICENSE
gh denoland/deno_error HEAD LICENSE deno_error.LICENSE
gh denoland/deno HEAD LICENSE.md deno.LICENSE
gh Rust-SDL2/rust-sdl2 HEAD LICENSE rust-sdl2.LICENSE
gh libsdl-org/SDL release-2.30.0 LICENSE.txt sdl2.LICENSE
gh Nugine/simd HEAD LICENSE nugine-simd.LICENSE
wc -c "$out"/deno* "$out"/rust-sdl2* "$out"/sdl2* "$out"/nugine*
