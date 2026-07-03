#!/usr/bin/env bash
# IP-leak gate for the Vecteur CLI (sub-plan 05 WP-5.6 / M8).
#
# The CLI is a THIN client: it must ship only data shapes, never the agent, the space
# libraries, prompts, ontology, or provider keys. This gate fails the build if any banned
# marker appears in the shipped artifact. It scans `dist/` (compiled output) — the thing that
# actually ships — plus src, and includes a planted-secret self-test so the gate can't rot
# into a no-op.
#
# Usage: bash scripts/check-no-ip-leak.sh [dir]   (default: dist)
set -euo pipefail

cd "$(dirname "$0")/.."
TARGET="${1:-dist}"

# Banned markers: server-side IP that must never reach a client artifact.
# Word-ish boundaries where useful to cut false positives.
BANNED=(
  'albane'                # agent packages
  'vectspsgold'           # physics library
  'vectphys'              # physics core
  'ANTHROPIC_API_KEY'
  'MISTRAL_API_KEY'
  'OPENAI_API_KEY'
  'sk-ant-'               # anthropic key prefix
  'SYSTEM_PROMPT'
  'ontology'              # engineering ontology / skeletons
  'skeleton'
)

# Known-benign occurrences (allow-list). Keep tight; each entry needs a reason.
# (none yet — the CLI has no legitimate reason to mention any banned marker)
ALLOW_REGEX='^$'

scan() {
  local dir="$1"
  local hits=0
  for marker in "${BANNED[@]}"; do
    # -F fixed string, -r recursive, -I skip binary; filter the allow-list.
    if grep -rInF "$marker" "$dir" 2>/dev/null | grep -vE "$ALLOW_REGEX" | grep -q .; then
      echo "LEAK: banned marker '$marker' found in $dir:"
      grep -rInF "$marker" "$dir" 2>/dev/null | grep -vE "$ALLOW_REGEX" | head -5
      hits=$((hits + 1))
    fi
  done
  return "$hits"
}

echo "== IP-leak gate: scanning '$TARGET' + src =="
if [ ! -d "$TARGET" ]; then
  echo "note: '$TARGET' not found (run 'npm run build' first); scanning src only"
  TARGET=""
fi

leaks=0
for d in $TARGET src; do
  [ -d "$d" ] || continue
  # Call scan directly and add its return (hit count). Do NOT wrap in `! scan` — the `!`
  # negation resets $? to 0, so the accumulator never sees the hit count (silent no-op gate).
  scan "$d"
  leaks=$((leaks + $?))
done

# Self-test: a planted marker MUST be caught, else the gate is broken.
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
echo "const x = 'vectspsgold-PLANTED-LEAK-MARKER'" > "$tmp/planted.js"
if scan "$tmp" >/dev/null 2>&1; then
  echo "SELF-TEST FAILED: gate did not catch a planted leak — the gate is broken."
  exit 2
fi

if [ "$leaks" -gt 0 ]; then
  echo "== FAIL: $leaks banned marker(s) present in the shipped artifact =="
  exit 1
fi
echo "== PASS: no IP leaks; self-test confirmed the gate catches a planted marker =="
