#!/usr/bin/env bash
# Build ax-bridge for the current arch. Run on macOS with Xcode CLT
# installed (`xcode-select --install`). The resulting binary is written
# next to this script and picked up at runtime by src/agent/os/providers/mac.ts.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "swiftc not found. Install Xcode Command Line Tools: xcode-select --install" >&2
  exit 1
fi

if [[ "$(uname)" != "Darwin" ]]; then
  echo "ax-bridge is macOS-only (uses ApplicationServices/AppKit)." >&2
  exit 1
fi

echo "[ax-bridge] compiling for $(uname -m)…"
swiftc -O -o ax-bridge ax-bridge.swift
echo "[ax-bridge] built: $(pwd)/ax-bridge"

# Clear the quarantine xattr that Gatekeeper applies to anything
# downloaded — for an unsigned dev build, this lets the binary run
# without a "Cannot be opened" prompt on first launch.
xattr -d com.apple.quarantine ax-bridge 2>/dev/null || true

echo "[ax-bridge] done. Grant Accessibility permission to the process that"
echo "[ax-bridge] invokes this binary (Claude Code / Electron / tsx), NOT to"
echo "[ax-bridge] ax-bridge itself."
