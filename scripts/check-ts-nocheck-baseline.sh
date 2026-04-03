#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASELINE_FILE="$ROOT_DIR/.ts-nocheck-baseline"

if [[ ! -f "$BASELINE_FILE" ]]; then
  echo "Missing baseline file: $BASELINE_FILE" >&2
  exit 1
fi

baseline="$(tr -d '[:space:]' < "$BASELINE_FILE")"
if [[ -z "$baseline" || ! "$baseline" =~ ^[0-9]+$ ]]; then
  echo "Invalid baseline value in $BASELINE_FILE: '$baseline'" >&2
  exit 1
fi

current="$(
  rg -n '@ts-nocheck' "$ROOT_DIR/src" -S \
    --glob '!**/*.d.ts' \
    | wc -l \
    | tr -d '[:space:]'
)"

if (( current > baseline )); then
  echo "New @ts-nocheck usage detected: baseline=$baseline current=$current" >&2
  echo "Remove new suppressions or update the baseline intentionally." >&2
  exit 1
fi

echo "@ts-nocheck guard passed: baseline=$baseline current=$current"
