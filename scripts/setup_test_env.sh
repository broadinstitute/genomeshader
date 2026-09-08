#!/usr/bin/env bash
# Re-create the closed-loop test environment for genomeshader.
#
# The container is ephemeral — run this after a rebuild to get back to a state
# where you (or the agent) can build the Rust extension and run the FULL test
# suite, including the integration tests that exercise the real compiled
# extension end to end (synthetic VCF -> Rust -> Python payload).
#
# Discovered setup (2026-09-02): the base image already ships python 3.11 +
# maturin + polars + rust + Playwright's Chromium under /opt/claude-venv and
# ~/.cache/ms-playwright. The ONLY thing maturin needs is VIRTUAL_ENV pointing at
# that venv (it refuses to build without a detected venv/conda). No pip installs
# were required.
#
# Usage:  source scripts/setup_test_env.sh    # (source, so VIRTUAL_ENV persists)
#     or  bash   scripts/setup_test_env.sh    # (build only)
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
cd "$REPO"

# 1. Point maturin/pip at the pre-provisioned venv (the fix for the "Couldn't
#    find a virtualenv" error). Fall back to any active venv or a local .venv.
if [ -z "${VIRTUAL_ENV:-}" ]; then
  if [ -x /opt/claude-venv/bin/python ]; then
    export VIRTUAL_ENV=/opt/claude-venv
  elif [ -x .venv/bin/python ]; then
    export VIRTUAL_ENV="$REPO/.venv"
  else
    echo "No venv found. Creating .venv + installing build deps..."
    python3 -m venv .venv
    export VIRTUAL_ENV="$REPO/.venv"
    "$VIRTUAL_ENV/bin/pip" -q install maturin polars pyarrow requests anywidget playwright pytest
    "$VIRTUAL_ENV/bin/playwright" install chromium || true
  fi
fi
export PATH="$VIRTUAL_ENV/bin:$PATH"
echo "VIRTUAL_ENV=$VIRTUAL_ENV"

# 2. Sanity: required tools. bgzip/tabix are used by the integration test to
#    build synthetic bgzipped+tabixed VCFs.
for t in maturin cargo bgzip tabix; do
  command -v "$t" >/dev/null || { echo "MISSING: $t"; MISSING=1; }
done
[ "${MISSING:-0}" = 1 ] && echo "Install the missing tools above before continuing."

# 3. Build the Rust extension in place (editable). This is what exposes the
#    PyO3 bindings (get_locus_variants, get_locus_variant_aggregates,
#    fetch_reads_for_locus, ...). Re-run after any src/*.rs change.
echo "== maturin develop --release =="
maturin develop --release

# 4. Verify the compiled bindings load + expose the scale methods.
python3 - <<'PY'
import genomeshader.genomeshader as gs
sess = gs._init(None)
need = ["get_locus_variants", "get_locus_variant_aggregates",
        "attach_variants", "fetch_reads_for_locus", "parse_locus"]
missing = [m for m in need if not hasattr(sess, m)]
assert not missing, f"compiled session missing methods: {missing}"
print("OK compiled extension:", gs.__file__)
print("OK session methods present:", ", ".join(need))
PY

echo
echo "Environment ready. Run the suite:"
echo "  VIRTUAL_ENV=$VIRTUAL_ENV cargo test --lib"
echo "  VIRTUAL_ENV=$VIRTUAL_ENV python -m pytest python/tests -q"
echo "  VIRTUAL_ENV=$VIRTUAL_ENV python -m pytest python/tests/headless -q   # WebGPU pixels still can't be verified headless (see planning/DEV_ENV.md)"
