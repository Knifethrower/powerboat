# Cross-build environment for powerboat: aarch64 handhelds (Knulli, ROCKNIX, muOS,
# dArkOS, AmberELEC).
#
# Ubuntu 22.04 for its toolchain and the arm64 libSDL2/libvpx it supplies; the binary links against
# Debian 10's glibc 2.28 (WSL ~/sysroot-buster, mounted by build.sh), so the floor is 2.28
# (2026-10-13; it was 2.35 before, user decision 2026-10-12). Modelled on retsurf-rmmv's focal image
# (~/retsurf-rmmv/tools/arm64/Dockerfile): Debian multiarch, no sysroot for the libraries.
FROM ubuntu:22.04

# arm64 packages come from ports.ubuntu.com, so the existing sources must be
# pinned to amd64 first or apt fails the update on arm64 indexes it cannot find.
RUN sed -i 's|^deb |deb [arch=amd64] |' /etc/apt/sources.list \
 && printf '%s\n' \
      'deb [arch=arm64] http://ports.ubuntu.com/ubuntu-ports jammy main universe' \
      'deb [arch=arm64] http://ports.ubuntu.com/ubuntu-ports jammy-updates main universe' \
    > /etc/apt/sources.list.d/arm64.list \
 && dpkg --add-architecture arm64

# Host toolchain, the aarch64 cross compiler, and clang for bindgen.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      build-essential cmake pkg-config ca-certificates curl git xz-utils file zip \
      python3 clang libclang-dev \
      gcc-aarch64-linux-gnu g++-aarch64-linux-gnu \
 && rm -rf /var/lib/apt/lists/*

# What the runtime links: SDL2 and GLES/EGL headers (the devices' own libraries at
# run time), ALSA for audio, libvpx (static) for WebM, zlib.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      libsdl2-dev:arm64 libgles2-mesa-dev:arm64 libegl1-mesa-dev:arm64 \
      libasound2-dev:arm64 libvpx-dev:arm64 zlib1g-dev:arm64 \
 && rm -rf /var/lib/apt/lists/* \
 && ls -l /usr/lib/aarch64-linux-gnu/libvpx.a \
 && PKG_CONFIG_ALLOW_CROSS=1 \
    PKG_CONFIG_LIBDIR=/usr/lib/aarch64-linux-gnu/pkgconfig:/usr/share/pkgconfig \
    pkg-config --libs --cflags sdl2 alsa glesv2 egl

# Rust comes in at build time (rustup into a mounted cache), as in retsurf-rmmv.
ENV CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc \
    CC_aarch64_unknown_linux_gnu=aarch64-linux-gnu-gcc \
    CXX_aarch64_unknown_linux_gnu=aarch64-linux-gnu-g++ \
    PKG_CONFIG_ALLOW_CROSS=1 \
    PKG_CONFIG_LIBDIR=/usr/lib/aarch64-linux-gnu/pkgconfig:/usr/share/pkgconfig
