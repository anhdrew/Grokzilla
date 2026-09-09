#!/usr/bin/env bash
# Ad-hoc-sign extra cargo binaries before Tauri copies them into
# Contents/MacOS. Native arm64 bins are already linker-signed; cross-
# compiled x86_64 bins are not, and codesign then refuses to sign the
# main executable because the unsigned sibling is nested code.
set -euo pipefail

if [[ "${TAURI_ENV_PLATFORM:-darwin}" != "darwin" ]]; then
  exit 0
fi

root="$(cd "$(dirname "$0")/.." && pwd)"
triple="${TAURI_ENV_TARGET_TRIPLE:-}"
profile="release"
if [[ "${TAURI_ENV_DEBUG:-}" == "true" ]]; then
  profile="debug"
fi

candidates=()
if [[ -n "$triple" ]]; then
  candidates+=("$root/target/$triple/$profile/grokzilla-ctl")
fi
candidates+=("$root/target/$profile/grokzilla-ctl")

found=0
for bin in "${candidates[@]}"; do
  if [[ -f "$bin" ]]; then
    codesign --force --sign - --identifier ai.grokzilla.ctl "$bin"
    echo "ad-hoc signed $bin"
    found=1
  fi
done

if [[ "$found" -eq 0 ]]; then
  echo "error: grokzilla-ctl not found (looked in ${candidates[*]})" >&2
  exit 1
fi
