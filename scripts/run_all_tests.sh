#!/usr/bin/env bash
# One command to run every genomeshader test layer. Used locally and by CI.
#
# Layers (each skips cleanly if its prerequisites are absent, so this is safe to
# run anywhere):
#   1. Rust        — cargo test --lib
#   2. Python      — unit + real-extension integration (needs the maturin build)
#   3. Headless UI — the real viewer in headless Chromium (software GL); asserts
#                    on SVG/DOM/interaction
#   4. WebGPU px   — the real viewer on a real GPU; asserts on painted pixels.
#                    Auto-skips without a GPU. On a GPU host, source
#                    scripts/setup_gpu_webgpu.sh first (or pass --gpu below) so
#                    these actually run instead of skipping.
#
# Usage:
#   scripts/run_all_tests.sh            # all layers; webgpu skips w/o GPU env
#   scripts/run_all_tests.sh --gpu      # set up the GPU/WebGPU env first, then run
#   scripts/run_all_tests.sh --fast     # skip the slow browser layers (3 & 4)
set -euo pipefail
cd "$(dirname "$0")/.."

GPU=0; FAST=0
for a in "$@"; do
  case "$a" in
    --gpu)  GPU=1 ;;
    --fast) FAST=1 ;;
    *) echo "unknown arg: $a" >&2; exit 2 ;;
  esac
done

# Pick an interpreter: prefer an active venv, else the repo's known venv, else python3.
PY="${PYTHON:-}"
if [ -z "$PY" ]; then
  if [ -n "${VIRTUAL_ENV:-}" ] && [ -x "$VIRTUAL_ENV/bin/python" ]; then PY="$VIRTUAL_ENV/bin/python"
  elif [ -x /opt/claude-venv/bin/python ]; then PY=/opt/claude-venv/bin/python
  elif [ -x .venv/bin/python ]; then PY=.venv/bin/python
  else PY=python3; fi
fi
echo "== interpreter: $PY =="

if [ "$GPU" = 1 ]; then
  echo "== setting up GPU/WebGPU env =="
  # shellcheck disable=SC1091
  source scripts/setup_gpu_webgpu.sh
fi

echo "== 1/4 Rust (cargo test) =="
cargo test --lib

echo "== ensure the extension is built for the Python layers =="
if ! "$PY" -c "import genomeshader.genomeshader" 2>/dev/null; then
  VIRTUAL_ENV="${VIRTUAL_ENV:-$(dirname "$(dirname "$PY")")}" maturin develop --release
fi

echo "== 2/4 Python unit + integration =="
"$PY" -m pytest python/tests -q --ignore=python/tests/headless

if [ "$FAST" = 1 ]; then
  echo "== skipping browser layers (--fast) =="
  exit 0
fi

echo "== 3/4 Headless UI (software GL) =="
"$PY" -m pytest python/tests/headless/test_headless.py -q

echo "== 4/4 WebGPU pixels (real GPU; skips without one) =="
"$PY" -m pytest python/tests/headless/test_webgpu_pixels.py -q

echo "== all layers done =="
