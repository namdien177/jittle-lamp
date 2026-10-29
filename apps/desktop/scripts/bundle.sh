#!/usr/bin/env bash
# Builds "Jittle Lamp.app" from the release binary.
#
#   scripts/bundle.sh            release build, ad-hoc signed
#   JL_SIGN_IDENTITY="Developer ID Application: …" scripts/bundle.sh
#
# Screen Recording, Accessibility and Keychain access belong to the bundle's signed identity, so
# capture features are best tested from the bundle rather than `cargo run`.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
root="$(cd "$here/../.." && pwd)"
cd "$here"

# Build-time origins come from the workspace .env, as for the other apps; values already set in the
# environment win.
if [[ -f "$root/.env" ]]; then
  while IFS='=' read -r key value; do
    case "$key" in
      JITTLE_LAMP_API_ORIGIN|JITTLE_LAMP_WEB_ORIGIN) [[ -n "${!key:-}" ]] || export "$key=${value//\"/}" ;;
    esac
  done < <(grep -E '^(JITTLE_LAMP_API_ORIGIN|JITTLE_LAMP_WEB_ORIGIN)=' "$root/.env" || true)
fi

export PATH="$HOME/.cargo/bin:$PATH"
export MACOSX_DEPLOYMENT_TARGET=15.0

# Homebrew's libvpx targets the build machine's macOS; link one built for macOS 15 instead.
if [[ -z "${JL_LIBVPX_DIR:-}" ]]; then
  if [[ ! -f target/libvpx/lib/libvpx.a ]]; then
    crates/jl-media/scripts/build-libvpx.sh target/libvpx
  fi
  export JL_LIBVPX_DIR="$here/target/libvpx/lib"
fi

cargo build --release -p jl-app

version="$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)"
app="$here/target/bundle/Jittle Lamp.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp target/release/jittle-lamp "$app/Contents/MacOS/jittle-lamp"
# The on-device suggestion helper (Apple Intelligence + Vision), run as a child process.
cp target/release/jl-intelligence-helper "$app/Contents/MacOS/jl-intelligence-helper"
sed "s/__VERSION__/$version/g" packaging/Info.plist > "$app/Contents/Info.plist"

# App icon from the brand artwork.
iconset="$(mktemp -d)/AppIcon.iconset"
mkdir -p "$iconset"
for size in 16 32 128 256 512; do
  sips -s format png -z "$size" "$size" "$root/assets/jittle-lamp-logo.jpg" --out "$iconset/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -s format png -z "$double" "$double" "$root/assets/jittle-lamp-logo.jpg" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$iconset" -o "$app/Contents/Resources/AppIcon.icns"

identity="${JL_SIGN_IDENTITY:--}"
# Notarization requires a secure timestamp on Developer ID signatures; ad-hoc ones cannot have one.
timestamp="--timestamp"
[[ "$identity" == "-" ]] && timestamp="--timestamp=none"
# Nested code first, then the app that seals it.
codesign --force --options runtime "$timestamp" --identifier dev.jittlelamp.desktop.intelligence-helper --sign "$identity" "$app/Contents/MacOS/jl-intelligence-helper"
codesign --force --options runtime "$timestamp" --entitlements packaging/entitlements.plist --sign "$identity" "$app"
codesign --verify --strict "$app"
echo "$app"
