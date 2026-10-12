#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Error: macOS bundle verification requires macOS." >&2
  exit 1
fi

case "${1:-}" in
  aarch64-apple-darwin) arch=arm64 ;;
  x86_64-apple-darwin) arch=x86_64 ;;
  *) echo "Error: expected a supported macOS build target." >&2; exit 1 ;;
esac

root="$(cd "$(dirname "$0")/.." && pwd)"
bundle_dir="$root/src-tauri/target/$1/release/bundle"
app_name="Codex Account Manager.app"

verify_app() {
  local app="$1"
  [[ -d "$app" ]] || { echo "Error: missing application: $app" >&2; return 1; }
  /usr/bin/codesign --verify --deep --strict --verbose=2 "$app"
  local details
  details="$(/usr/bin/codesign --display --verbose=4 "$app" 2>&1)"
  if ! printf '%s\n' "$details" | /usr/bin/grep -q '^Signature=adhoc$'; then
    echo "Error: application does not have the expected ad-hoc signature." >&2
    return 1
  fi
  /usr/bin/lipo -verify_arch "$arch" "$app/Contents/MacOS/codex-account-manager"
}

verify_app "$bundle_dir/macos/$app_name"

shopt -s nullglob
dmgs=("$bundle_dir/dmg/"*.dmg)
if [[ ${#dmgs[@]} -ne 1 ]]; then
  echo "Error: expected exactly one DMG for target $1." >&2
  exit 1
fi

mount_dir="$(mktemp -d "${TMPDIR:-/tmp}/codex-macos-verify.XXXXXX")"
mounted=false
cleanup() {
  if [[ "$mounted" == true ]]; then
    /usr/bin/hdiutil detach "$mount_dir" >/dev/null || return 1
  fi
  rmdir "$mount_dir"
}
trap cleanup EXIT
/usr/bin/hdiutil attach -readonly -nobrowse -mountpoint "$mount_dir" "${dmgs[0]}"
mounted=true
verify_app "$mount_dir/$app_name"
echo "Verified ad-hoc signature and $arch architecture in the application and DMG."
