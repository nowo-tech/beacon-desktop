#!/usr/bin/env bash
# Decides which CI jobs a change needs. Prints "web=true|false" and "rust=true|false" (append to $GITHUB_OUTPUT).
#
# Usage: ci-changes.sh <event-name> [base-ref] [head-ref]
#   push (or any non pull_request event) -> both true, so main is always fully verified.
#   pull_request -> diff base..head (CI passes HEAD^1..HEAD of the merge commit, i.e. the whole PR against
#   its base). Any failure to compute the diff runs both jobs.
set -uo pipefail

event=${1:-}
base=${2:-HEAD^1}
head=${3:-HEAD}

both() { echo "web=true"; echo "rust=true"; exit 0; }

[ "$event" = "pull_request" ] || both
files=$(git diff --name-only "$base" "$head" 2>/dev/null) || both

# Shared: CI definition and the Tauri config (read by both the frontend build and the Rust crate).
shared='^(\.github/workflows/ci\.yml|\.github/scripts/ci-changes\.sh|src-tauri/tauri\.conf\.json)$'
# Frontend: sources, tests, fixtures, tooling and every root-level config (eslint lints the whole tree).
web='^(src/|tests/|public/|mock-server/|scripts/|index\.html$|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|[^/]+\.(json|[cm]?[jt]s)$)'
# Rust crate and toolchain.
rust='^(src-tauri/|Cargo\.|rust-toolchain)'

run_web=false
run_rust=false
if grep -Eq "$shared" <<<"$files"; then run_web=true; run_rust=true; fi
grep -Eq "$web" <<<"$files" && run_web=true
grep -Eq "$rust" <<<"$files" && run_rust=true
# tauri.conf.json takes the app version from ../package.json, so a version bump also needs the Rust job.
if grep -qx 'package.json' <<<"$files" && git diff "$base" "$head" -- package.json | grep -Eq '^[-+][[:space:]]*"version"'; then
  run_rust=true
fi

echo "web=$run_web"
echo "rust=$run_rust"
