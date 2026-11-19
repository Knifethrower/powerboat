#!/bin/bash
# Fetches the MIT-licensed Phaser builds the test scenes in tests/phaser use (not committed).
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
lib=$repo/tests/phaser/lib
mkdir -p "$lib"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
get() { # npm package, version, file inside the package, output name
  curl -sSfL "https://registry.npmjs.org/$1/-/$1-$2.tgz" -o "$tmp/$1-$2.tgz"
  tar -xzf "$tmp/$1-$2.tgz" -C "$tmp" "package/$3"
  mv "$tmp/package/$3" "$lib/$4"
  rm -rf "$tmp/package"
}
get phaser-ce 2.21.0 build/phaser.min.js phaser2.min.js
get phaser 3.90.0 dist/phaser.min.js phaser3.min.js
get phaser 4.2.1 dist/phaser.min.js phaser4.min.js
ls -la "$lib"
