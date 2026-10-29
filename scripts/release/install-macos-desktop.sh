#!/usr/bin/env bash
set -euo pipefail

repo="namdien177/jittle-lamp"
app_name="Jittle Lamp.app"
install_dir="/Applications"
tag="${JITTLE_LAMP_VERSION:-}"
requested_signing_suffix="${JITTLE_LAMP_SIGNING_SUFFIX:-}"

if [[ "$(uname -m)" != "arm64" ]]; then
  echo "This installer only supports the current macOS arm64 desktop release." >&2
  exit 1
fi

if [[ -z "$tag" ]]; then
  latest_url="$(curl -fsSLI -o /dev/null -w "%{url_effective}" "https://github.com/${repo}/releases/latest")"
  tag="${latest_url##*/}"
fi

if [[ ! "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Unable to resolve a stable Jittle Lamp release tag. Received: ${tag}" >&2
  exit 1
fi

asset_name=""
asset_url=""

if [[ -n "$requested_signing_suffix" ]]; then
  candidate_suffixes=("$requested_signing_suffix")
else
  candidate_suffixes=("unsigned" "adhoc" "signed")
fi

for suffix in "${candidate_suffixes[@]}"; do
  candidate_name="jittle-lamp-desktop-${tag}-macos-arm64-${suffix}.dmg"
  candidate_url="https://github.com/${repo}/releases/download/${tag}/${candidate_name}"

  if curl -fsIL -o /dev/null "$candidate_url"; then
    asset_name="$candidate_name"
    asset_url="$candidate_url"
    break
  fi
done

if [[ -z "$asset_url" ]]; then
  echo "Unable to find a macOS arm64 desktop DMG for ${tag}." >&2
  exit 1
fi

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/jittle-lamp-install.XXXXXX")"
dmg_path="${tmp_dir}/${asset_name}"
mount_point=""

cleanup() {
  if [[ -n "$mount_point" ]]; then
    hdiutil detach "$mount_point" -quiet || hdiutil detach "$mount_point" -force -quiet || true
  fi

  rm -rf "$tmp_dir"
}

trap cleanup EXIT

echo "Downloading ${asset_url}"
curl -fL --retry 3 --connect-timeout 20 -o "$dmg_path" "$asset_url"

echo "Mounting ${asset_name}"
mount_point="$(hdiutil attach "$dmg_path" -nobrowse -readonly | awk '/\/Volumes\// { print substr($0, index($0, "/Volumes/")); exit }')"

if [[ -z "$mount_point" || ! -d "${mount_point}/${app_name}" ]]; then
  echo "Mounted image does not contain ${app_name}." >&2
  exit 1
fi

echo "Waiting for ${app_name} to close"
osascript -e 'tell application id "dev.jittlelamp.desktop" to quit' >/dev/null 2>&1 || true
for _ in {1..30}; do
  # jittle-lamp is the native app; "Jittle Lamp" is the Electron app it replaces.
  if ! pgrep -x "jittle-lamp" >/dev/null 2>&1 && ! pgrep -x "Jittle Lamp" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo "Installing ${app_name} to ${install_dir}"
if [[ -w "$install_dir" ]]; then
  ditto "${mount_point}/${app_name}" "${install_dir}/${app_name}"
else
  copy_command="ditto $(printf "%q" "${mount_point}/${app_name}") $(printf "%q" "${install_dir}/${app_name}")"
  copy_command="${copy_command//\\/\\\\}"
  copy_command="${copy_command//\"/\\\"}"
  osascript -e "do shell script \"${copy_command}\" with administrator privileges"
fi

xattr -cr "${install_dir}/${app_name}" >/dev/null 2>&1 || true

echo "Installed ${install_dir}/${app_name}"
