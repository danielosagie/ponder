#!/usr/bin/env bash
# Sets up the local Holo3 path:
#   1. Downloads the chosen Holo3 GGUF tier + mmproj sidecar from HuggingFace
#   2. Imports it into Ollama as the model named `holo3`
#
# Usage (TIER controls which weight file is downloaded; mmproj is always pulled):
#   bash scripts/setup-local.sh                    # default I-Compact (17GB) — Windows + 32GB RAM
#   TIER=I-Mini bash scripts/setup-local.sh        # 14GB — for 16GB M1 (tight)
#   TIER=I-Quality bash scripts/setup-local.sh     # 23GB — needs A10G/L40S or 32GB+ unified
#
# Tiers in mudler/Holo3-35B-A3B-APEX-GGUF:
#   I-Mini (14.3GB), I-Compact (17.3GB), Compact (17.3GB),
#   I-Quality (22.8GB), Quality (22.8GB),
#   I-Balanced (25.6GB), Balanced (25.6GB)
# (I-* are imatrix variants — slightly better quality at the same size.)
#
# Requires: huggingface-cli (`pipx install huggingface_hub`), ollama running.

set -euo pipefail

TIER="${TIER:-I-Compact}"
REPO="mudler/Holo3-35B-A3B-APEX-GGUF"
WEIGHTS="Holo3-35B-A3B-APEX-${TIER}.gguf"
MMPROJ="mmproj.gguf"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODELS_DIR="$ROOT/models"
MODELFILE="$ROOT/scripts/Holo3.Modelfile"

mkdir -p "$MODELS_DIR"

download() {
  local fname="$1"
  if [[ -f "$MODELS_DIR/$fname" ]]; then
    echo "→ $fname already present."
    return
  fi
  echo "→ Downloading $fname from $REPO …"
  huggingface-cli download "$REPO" "$fname" --local-dir "$MODELS_DIR" --local-dir-use-symlinks False
}

download "$WEIGHTS"
download "$MMPROJ"

if ! command -v ollama >/dev/null 2>&1; then
  echo "ollama not found on PATH. Install it from https://ollama.com/download and re-run." >&2
  exit 1
fi

# Patch a temp Modelfile so FROM points at the absolute local path of the chosen tier.
TMPFILE="$(mktemp)"
{
  echo "FROM $MODELS_DIR/$WEIGHTS"
  # carry over PARAMETER / TEMPLATE / SYSTEM lines from the canonical Modelfile
  awk '/^FROM /{next} {print}' "$MODELFILE"
} > "$TMPFILE"

echo "→ Importing into Ollama as 'holo3' (tier=$TIER)…"
ollama create holo3 -f "$TMPFILE"
rm -f "$TMPFILE"

echo "✓ Local Holo3 ready. Test with:  ollama run holo3 \"hello\""
