#!/bin/sh
# Builds a decoder-only static libvpx for the app's deployment target (macOS 15, arm64).
#
# Homebrew's libvpx.a is compiled for the build machine's macOS version, so release builds
# should link this one instead:
#
#   crates/jl-media/scripts/build-libvpx.sh            # -> target/libvpx/{lib,include}
#   JL_LIBVPX_DIR=$PWD/target/libvpx/lib cargo build --release
set -eu

VERSION=${LIBVPX_VERSION:-v1.17.0}
DEPLOYMENT_TARGET=${MACOSX_DEPLOYMENT_TARGET:-15.0}
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
PREFIX=${1:-$ROOT/target/libvpx}
mkdir -p "$PREFIX"
PREFIX=$(cd "$PREFIX" && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$VERSION" https://chromium.googlesource.com/webm/libvpx "$WORK/src"
mkdir "$WORK/build"
cd "$WORK/build"
MACOSX_DEPLOYMENT_TARGET=$DEPLOYMENT_TARGET "$WORK/src/configure" \
  --target=arm64-darwin20-gcc \
  --prefix="$PREFIX" \
  --extra-cflags="-mmacosx-version-min=$DEPLOYMENT_TARGET" \
  --disable-examples --disable-tools --disable-docs --disable-unit-tests \
  --disable-vp8-encoder --disable-vp9-encoder \
  --enable-vp8-decoder --enable-vp9-decoder \
  --enable-pic --disable-shared --enable-static >/dev/null
make -j"$(sysctl -n hw.ncpu)" >/dev/null
make install >/dev/null
echo "libvpx $VERSION (decoders only, macOS $DEPLOYMENT_TARGET) installed to $PREFIX"
echo "export JL_LIBVPX_DIR=$PREFIX/lib"
