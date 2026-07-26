#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "$script_dir/.." && pwd)"

try_export_path() {
  local executable="$1"
  if ! "$executable" --version >/dev/null 2>&1; then
    return 1
  fi
  if [ -n "${GITHUB_ENV:-}" ]; then
    echo "GITVIBE_CODEX_PATH=$executable" >> "$GITHUB_ENV"
  fi
  echo "Using Codex executable at $executable"
}

codex_version() {
  node -e '
const { readFileSync } = require("node:fs");
const pkg = JSON.parse(readFileSync(process.argv[1], "utf8"));
const range = pkg.dependencies?.["@openai/codex-sdk"];
const match = typeof range === "string" ? range.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/) : undefined;
if (!match) process.exit(1);
console.log(match[0]);
' "$repo_dir/package.json"
}

run_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    pnpm "$@"
    return
  fi
  if command -v corepack >/dev/null 2>&1; then
    corepack pnpm "$@"
    return
  fi
  echo "::error::Codex is not available and pnpm or Corepack is required to install it."
  exit 127
}

cleanup_codex_install() {
  if [ -n "${GITVIBE_CODEX_TMP_DIR:-}" ]; then
    rm -rf "$GITVIBE_CODEX_TMP_DIR"
  fi
  if [ -n "${GITVIBE_CODEX_LOCK_DIR:-}" ]; then
    rmdir "$GITVIBE_CODEX_LOCK_DIR" 2>/dev/null || true
  fi
}

install_codex() {
  local version="$1"
  local root="${GITVIBE_PROVIDER_CACHE_DIR:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/git-vibe/providers}"
  local install_dir="$root/codex-$version"
  local executable="$install_dir/node_modules/.bin/codex"
  local lock_dir="$install_dir.lock"

  if [ -x "$executable" ]; then
    if try_export_path "$executable"; then
      exit 0
    fi
    echo "::warning::Replacing unusable cached Codex executable at $executable."
  fi

  mkdir -p "$root"
  for _ in $(seq 1 120); do
    if mkdir "$lock_dir" 2>/dev/null; then
      GITVIBE_CODEX_LOCK_DIR="$lock_dir"
      trap cleanup_codex_install EXIT
      GITVIBE_CODEX_TMP_DIR="$(mktemp -d "$root/codex-$version.XXXXXX")"
      run_pnpm --dir "$GITVIBE_CODEX_TMP_DIR" add --prod --ignore-workspace "@openai/codex@$version"
      rm -rf "$install_dir"
      mv "$GITVIBE_CODEX_TMP_DIR" "$install_dir"
      GITVIBE_CODEX_TMP_DIR=""
      rmdir "$lock_dir"
      GITVIBE_CODEX_LOCK_DIR=""
      if try_export_path "$executable"; then
        exit 0
      fi
      echo "::error::Installed Codex executable failed validation: $executable"
      exit 1
    fi

    if [ -x "$executable" ] && try_export_path "$executable"; then
      exit 0
    fi
    sleep 1
  done

  echo "::error::Timed out waiting for Codex provider install lock: $lock_dir"
  exit 1
}

if [ -n "${GITVIBE_CODEX_PATH:-}" ]; then
  if [ ! -x "$GITVIBE_CODEX_PATH" ]; then
    echo "::error::GITVIBE_CODEX_PATH is not executable: $GITVIBE_CODEX_PATH"
    exit 1
  fi
  if try_export_path "$GITVIBE_CODEX_PATH"; then
    exit 0
  fi
  echo "::error::GITVIBE_CODEX_PATH failed Codex executable validation: $GITVIBE_CODEX_PATH"
  exit 1
fi

if resolved="$(node "$repo_dir/scripts/resolve-codex-path.mjs" 2>/dev/null)" && [ -n "$resolved" ]; then
  if try_export_path "$resolved"; then
    exit 0
  fi
  echo "::warning::Ignoring unusable auto-resolved Codex executable at $resolved."
fi

if command -v codex >/dev/null 2>&1; then
  global_codex="$(command -v codex)"
  if try_export_path "$global_codex"; then
    exit 0
  fi
  echo "::warning::Ignoring unusable Codex executable on PATH at $global_codex."
fi

case "$(uname -s)" in
  Darwin|Linux) ;;
  *)
    echo "::error::GitVibe Codex setup supports Linux and macOS runners only."
    exit 1
    ;;
esac

if version="$(codex_version)" && [ -n "$version" ]; then
  install_codex "$version"
else
  echo "::error::Failed to determine Codex CLI version from @openai/codex-sdk dependency."
  exit 1
fi
