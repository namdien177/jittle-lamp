#!/usr/bin/env bash
# Run from a checkout, or pipe the published script into bash.
set +x
set -euo pipefail
umask 077

fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
info() { printf '%s\n' "$*"; }

usage() {
  cat <<'USAGE'
Install the Jittle Lamp local MCP for Codex, Claude Code, or both.

  bash scripts/install-mcp.sh [options]
  curl -fsSL <published-script-url> | bash -s -- [options]

Options:
  --client codex|claude|both  Client to register; prompts when omitted
  --source-dir PATH          Build a local checkout instead of downloading source
  --install-dir PATH         Default: ~/.local/share/jittle-lamp/mcp
  --repo URL                 Source repository (defaults to the public GitHub mirror)
  --ref REF                  Branch or tag to clone (default: main)
  --help                    Show this help

Environment:
  JL_AI_TOKEN               Jittle Lamp AI or automation token; hidden prompt when omitted
  JITTLE_LAMP_API_ORIGIN     Default: https://jl-api.monthlyparty.com
  JITTLE_LAMP_WEB_ORIGIN     Default: https://jittlelamp.dev

Requires your chosen client CLI and Git when downloading source. Installs Bun
1.3.11 in the MCP directory if a suitable Bun is unavailable (curl/unzip needed).
Saves the token in private client configuration. Replaces only the jittlelamp
entry in Codex and/or Claude's user scope. Restart the client after installation.
Automation tokens retain their upload-only access; other tools report permission errors.
USAGE
}

client=''
source_dir=''
install_dir="${XDG_DATA_HOME:-$HOME/.local/share}/jittle-lamp/mcp"
repo='https://github.com/namdien177/jittle-lamp.git'
ref='main'
download_source=false
ai_token="${JL_AI_TOKEN:-}"
# Dependency installers and other subprocesses must not inherit this credential.
unset JL_AI_TOKEN
api_origin="${JITTLE_LAMP_API_ORIGIN:-https://jl-api.monthlyparty.com}"
web_origin="${JITTLE_LAMP_WEB_ORIGIN:-https://jittlelamp.dev}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --client|--source-dir|--install-dir|--repo|--ref)
      [[ $# -ge 2 && -n "$2" ]] || fail "$1 requires a value"
      case "$1" in
        --client) client="$2" ;;
        --source-dir) source_dir="$2" ;;
        --install-dir) install_dir="$2" ;;
        --repo) repo="$2"; download_source=true ;;
        --ref) ref="$2"; download_source=true ;;
      esac
      shift 2 ;;
    *) fail "Unknown option: $1. Use --help." ;;
  esac
done

open_tty() {
  # stdin contains the script during curl | bash, so read prompts from the terminal.
  { exec 3<>/dev/tty; } 2>/dev/null ||
    fail 'No terminal available. Supply --client and JL_AI_TOKEN for unattended installation.'
}

if [[ -z "$client" ]]; then
  open_tty
  printf 'Install for Codex, Claude Code, or both? [codex/claude/both]: ' >&3
  IFS= read -r client <&3 || fail 'Client selection cancelled'
fi
case "$client" in codex|claude|both) ;; *) fail 'Choose codex, claude, or both.' ;; esac

codex_bin=''
claude_bin=''
if [[ "$client" == codex || "$client" == both ]]; then
  codex_bin="$(command -v codex)" || fail 'Install the Codex CLI first, then run this installer again.'
fi
if [[ "$client" == claude || "$client" == both ]]; then
  claude_bin="$(command -v claude)" || fail 'Install Claude Code first, then run this installer again.'
fi

if [[ -z "$ai_token" ]]; then
  open_tty
  printf 'Jittle Lamp token (AI or automation): ' >&3
  IFS= read -rs ai_token <&3 || fail 'Token entry cancelled'
  printf '\n' >&3
fi
[[ "$ai_token" =~ ^jl_(ai|api)_[A-Za-z0-9_-]{18,}$ ]] ||
  fail 'Invalid token format. Use a Jittle Lamp AI (jl_ai_) or automation (jl_api_) token.'
exec 3>&-

# A script invoked from disk uses its checkout. Piped scripts download source.
if [[ -n "$source_dir" && "$download_source" == true ]]; then
  fail 'Use --source-dir or --repo/--ref, not both.'
fi
if [[ -z "$source_dir" && "$download_source" == false && -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  candidate="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
  if [[ -f "$candidate/apps/mcp/src/index.ts" ]]; then source_dir="$candidate"; fi
fi
if [[ -n "$source_dir" ]]; then
  [[ -f "$source_dir/apps/mcp/src/index.ts" && -f "$source_dir/bun.lock" ]] ||
    fail 'Source directory must contain apps/mcp/src/index.ts and bun.lock.'
  source_dir="$(cd -- "$source_dir" && pwd -P)"
else
  command -v git >/dev/null || fail 'Git is required to download Jittle Lamp.'
fi

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/jittle-lamp-mcp.XXXXXX")"
bundle_tmp=''
cleanup() {
  unset ai_token
  [[ -z "$bundle_tmp" ]] || rm -f -- "$bundle_tmp"
  rm -rf -- "$work_dir"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p -- "$install_dir"
install_dir="$(cd -- "$install_dir" && pwd -P)"

usable_bun() {
  local version
  [[ -x "$1" ]] || return 1
  version="$("$1" --version 2>/dev/null)" || return 1
  [[ "$version" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || return 1
  (( 10#${BASH_REMATCH[1]} > 1 ||
     (10#${BASH_REMATCH[1]} == 1 && 10#${BASH_REMATCH[2]} > 3) ||
     (10#${BASH_REMATCH[1]} == 1 && 10#${BASH_REMATCH[2]} == 3 && 10#${BASH_REMATCH[3]} >= 11) ))
}

bun_bin="$(command -v bun || true)"
if ! usable_bun "$bun_bin"; then
  bun_bin="$install_dir/runtime/bin/bun"
  if ! usable_bun "$bun_bin"; then
    command -v curl >/dev/null || fail 'curl is required to install Bun.'
    command -v unzip >/dev/null || fail 'unzip is required to install Bun.'
    case "$(uname -s)-$(uname -m)" in
      Darwin-arm64) target='darwin-aarch64' ;;
      Darwin-x86_64) target='darwin-x64-baseline' ;;
      Linux-aarch64|Linux-arm64) target='linux-aarch64' ;;
      Linux-x86_64) target='linux-x64-baseline' ;;
      *) fail 'Automatic Bun installation supports macOS/Linux on arm64 or x64. Install Bun manually.' ;;
    esac
    if [[ "$target" == linux-* && -f /etc/alpine-release ]]; then
      case "$target" in
        linux-x64-baseline) target='linux-x64-musl-baseline' ;;
        linux-aarch64) target='linux-aarch64-musl' ;;
      esac
    fi
    info 'Installing Bun 1.3.11 for Jittle Lamp...'
    curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v1.3.11/bun-$target.zip" \
      -o "$work_dir/bun.zip" || fail 'Could not download Bun.'
    unzip -q "$work_dir/bun.zip" -d "$work_dir/runtime" || fail 'Could not extract Bun.'
    usable_bun "$work_dir/runtime/bun-$target/bun" || fail 'Downloaded Bun could not run.'
    mkdir -p -- "$install_dir/runtime/bin"
    cp -- "$work_dir/runtime/bun-$target/bun" "$bun_bin"
  fi
fi
# Persist an absolute executable path, even when PATH contains relative entries.
bun_bin="$(cd -- "$(dirname -- "$bun_bin")" && pwd -P)/$(basename -- "$bun_bin")"

if [[ -z "$source_dir" ]]; then
  info "Downloading Jittle Lamp ($ref)..."
  git clone --depth 1 --branch "$ref" -- "$repo" "$work_dir/source" </dev/null ||
    fail 'Could not download source. Check repository access, or use --source-dir with a checkout.'
  source_dir="$work_dir/source"
fi
[[ -f "$source_dir/apps/mcp/src/index.ts" ]] || fail 'This source version does not contain the MCP server.'

info 'Installing dependencies and building the MCP...'
(
  cd -- "$source_dir"
  "$bun_bin" install --frozen-lockfile --ignore-scripts </dev/null || exit 1
  "$bun_bin" build --target bun --outfile "$work_dir/index.js" apps/mcp/src/index.ts </dev/null || exit 1
) || fail 'MCP build failed. Existing client registrations were not changed.'
[[ -s "$work_dir/index.js" ]] || fail 'The MCP build did not produce a bundle.'

# Check startup and origin configuration without making an API request or using
# the user's credential. EOF closes stdio immediately after startup.
JL_AI_TOKEN=jl_ai_installer_probe_000000000 \
  JITTLE_LAMP_API_ORIGIN="$api_origin" JITTLE_LAMP_WEB_ORIGIN="$web_origin" \
  "$bun_bin" run "$work_dir/index.js" </dev/null >"$work_dir/startup.log" 2>&1 ||
  fail 'MCP startup failed. Check Bun and the API/web origins. Existing registrations were not changed.'

bundle_tmp="$(mktemp "$install_dir/.index.XXXXXX")"
cp -- "$work_dir/index.js" "$bundle_tmp"
mv -f -- "$bundle_tmp" "$install_dir/index.js"
bundle_tmp=''

# Client CLIs may echo configuration, including tokens, on either output stream.
env_args=(--env "JL_AI_TOKEN=$ai_token" --env "JITTLE_LAMP_API_ORIGIN=$api_origin" --env "JITTLE_LAMP_WEB_ORIGIN=$web_origin")
if [[ -n "$codex_bin" ]]; then
  "$codex_bin" mcp add jittlelamp "${env_args[@]}" -- "$bun_bin" run "$install_dir/index.js" \
    </dev/null >"$work_dir/codex.log" 2>&1 || fail 'Codex registration failed. Check codex mcp add --help and rerun the installer.'
  info 'Registered jittlelamp with Codex.'
fi
if [[ -n "$claude_bin" ]]; then
  register_claude() {
    "$claude_bin" mcp add --scope user --transport stdio jittlelamp "${env_args[@]}" \
      -- "$bun_bin" run "$install_dir/index.js" </dev/null >"$work_dir/claude.log" 2>&1
  }
  if ! register_claude; then
    # Claude refuses duplicate names; replace only its user-scoped entry.
    if ! grep -Eq 'MCP server jittlelamp already exists in user config' "$work_dir/claude.log"; then
      fail 'Claude Code registration failed. Check claude mcp add --help and rerun the installer.'
    fi
    "$claude_bin" mcp remove --scope user jittlelamp </dev/null >"$work_dir/claude-remove.log" 2>&1 ||
      fail 'Could not replace the existing Claude Code user entry.'
    register_claude || fail 'Claude Code registration failed after removing its old user entry. Rerun the installer.'
  fi
  info 'Registered jittlelamp with Claude Code (user scope).'
fi
unset ai_token env_args
info "MCP installed at $install_dir/index.js"
info 'Restart your client, then ask it to get your Jittle Lamp context to verify access.'
