#!/usr/bin/env bash
# Collects the Tauri bundles of one OS into <out>/ and appends their stable.json entries to <out>/<os>.jsonl.
# Usage: scripts/release/collect-desktop.sh <linux|windows|darwin> <version> <out> <bundle-dir> <with-updater:true|false>
# Updater entries (kind=updater, with the minisign signature) only when the build was signed.
set -euo pipefail
os="$1"; version="$2"; out="$3"; bundle="$4"; updater="$5"
mkdir -p "$out"
fragments="$out/$os.jsonl"
: > "$fragments"

add() { # add <file> <arch> <kind> [signature-file]
  local file="$1" arch="$2" kind="$3" sig="${4:-}" name
  name="$(basename "$file" | tr ' ' '_')"
  cp "$file" "$out/$name"
  node scripts/release/channel.mjs describe --app desktop --version "$version" --target "$os" --arch "$arch" \
    --kind "$kind" ${sig:+--signature "$sig"} "$out/$name" >> "$fragments"
}

shopt -s nullglob
case "$os" in
  linux)
    for f in "$bundle"/deb/*.deb; do add "$f" x86_64 installer; done
    for f in "$bundle"/appimage/*.AppImage; do
      add "$f" x86_64 installer
      [ "$updater" = true ] && add "$f" x86_64 updater "$f.sig"
    done
    ;;
  windows)
    for f in "$bundle"/msi/*.msi; do add "$f" x86_64 installer; done
    for f in "$bundle"/nsis/*-setup.exe; do
      add "$f" x86_64 installer
      [ "$updater" = true ] && add "$f" x86_64 updater "$f.sig"
    done
    ;;
  darwin)
    # Universal build: one file for both architectures.
    for f in "$bundle"/dmg/*.dmg; do add "$f" aarch64 installer; add "$f" x86_64 installer; done
    if [ "$updater" = true ]; then
      for f in "$bundle"/macos/*.app.tar.gz; do add "$f" aarch64 updater "$f.sig"; add "$f" x86_64 updater "$f.sig"; done
    fi
    ;;
  *) echo "unknown os $os"; exit 2 ;;
esac
[ -s "$fragments" ] || { echo "::error::no bundles found in $bundle"; exit 1; }
cat "$fragments"
