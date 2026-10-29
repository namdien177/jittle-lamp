#!/usr/bin/env bash
# Packages the native macOS app for release: builds and signs "Jittle Lamp.app" with
# apps/desktop/scripts/bundle.sh, notarizes and staples it when Apple credentials are set, then
# wraps it in a DMG at apps/desktop/target/bundle/jittle-lamp-desktop-<version>-macos-arm64.dmg.
#
#   JL_SIGN_IDENTITY   Developer ID Application identity (name or SHA-1); unset means ad-hoc.
#   Notarization, for signed builds, uses either
#     APPLE_API_KEY (.p8 path or contents), APPLE_API_KEY_ID, APPLE_API_ISSUER
#   or the App Store Connect key variables aion-mobile's fastlane already uses
#     ASC_KEY_ID, ASC_ISSUER_ID, and ASC_KEY_PATH (.p8 file) or ASC_KEY_CONTENT (base64 .p8)
#   or
#     APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
desktop="$root/apps/desktop"
version="$(sed -n 's/^version = "\(.*\)"/\1/p' "$desktop/Cargo.toml" | head -1)"
app="$desktop/target/bundle/Jittle Lamp.app"
dmg="$desktop/target/bundle/jittle-lamp-desktop-$version-macos-arm64.dmg"
identity="${JL_SIGN_IDENTITY:--}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

notary_args=()
# Same App Store Connect API key as the LittleLives mobile apps (fastlane's ASC_* variables).
if [[ -z "${APPLE_API_KEY:-}" && -n "${ASC_KEY_ID:-}" && -n "${ASC_ISSUER_ID:-}" ]]; then
  if [[ -n "${ASC_KEY_PATH:-}" ]]; then
    APPLE_API_KEY="$ASC_KEY_PATH"
  elif [[ -n "${ASC_KEY_CONTENT:-}" ]]; then
    APPLE_API_KEY="$(printf '%s' "$ASC_KEY_CONTENT" | base64 --decode)"
  fi
  APPLE_API_KEY_ID="$ASC_KEY_ID"
  APPLE_API_ISSUER="$ASC_ISSUER_ID"
fi
if [[ -n "${APPLE_API_KEY:-}" && -n "${APPLE_API_KEY_ID:-}" && -n "${APPLE_API_ISSUER:-}" ]]; then
  key="$APPLE_API_KEY"
  if [[ ! -f "$key" ]]; then
    key="$work/AuthKey.p8"
    printf '%s\n' "$APPLE_API_KEY" > "$key"
  fi
  notary_args=(--key "$key" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER")
elif [[ -n "${APPLE_ID:-}" && -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]; then
  notary_args=(--apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID")
fi

notarize=false
if [[ "$identity" != "-" && ${#notary_args[@]} -gt 0 ]]; then
  notarize=true
fi

# Submits a file, waits for the verdict and prints Apple's log when it is not accepted.
notarize_file() {
  local result="$work/notary.json"
  xcrun notarytool submit "$1" "${notary_args[@]}" --wait --output-format json > "$result"
  local status
  status="$(plutil -extract status raw -o - "$result")"
  if [[ "$status" != "Accepted" ]]; then
    xcrun notarytool log "$(plutil -extract id raw -o - "$result")" "${notary_args[@]}" >&2 || true
    echo "Notarization of $(basename "$1") finished with status: $status" >&2
    exit 1
  fi
}

"$desktop/scripts/bundle.sh"

if [[ "$notarize" == true ]]; then
  ditto -c -k --keepParent "$app" "$work/app.zip"
  notarize_file "$work/app.zip"
  xcrun stapler staple "$app"
fi

staging="$work/dmg"
mkdir -p "$staging"
ditto "$app" "$staging/Jittle Lamp.app"
ln -s /Applications "$staging/Applications"
rm -f "$dmg"
hdiutil create -volname "Jittle Lamp" -srcfolder "$staging" -fs HFS+ -format UDZO "$dmg" >/dev/null

if [[ "$identity" != "-" ]]; then
  codesign --force --timestamp --sign "$identity" "$dmg"
fi
if [[ "$notarize" == true ]]; then
  notarize_file "$dmg"
  xcrun stapler staple "$dmg"
fi

echo "$dmg"
