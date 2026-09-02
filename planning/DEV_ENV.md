# Dev / closed-loop test environment

How to rebuild the environment the agent uses to self-test genomeshader after
the (ephemeral) container is destroyed. One command:

```bash
source scripts/setup_test_env.sh
```

That script is the source of truth; this doc explains *why* and what's verified.

## What the base image already ships (2026-09-02)

- Python 3.11 venv at **`/opt/claude-venv`** with maturin, polars 1.43.2,
  pyarrow, requests, anywidget, playwright, pytest.
- Rust toolchain + cargo (release build of the extension in ~0.2s incremental).
- `bgzip` + `tabix` (htslib) — used to build synthetic bgzipped/tabixed VCFs.
- Playwright's Chromium under `~/.cache/ms-playwright` (headless DOM tests).

No pip installs were needed. The **only** required step maturin can't infer is
pointing it at the venv:

```bash
export VIRTUAL_ENV=/opt/claude-venv     # maturin refuses to build without this
maturin develop --release               # builds python/genomeshader/genomeshader.abi3.so
```

## The three test layers (all part of `pytest python/tests`)

1. **Pure-Python unit** (`test_scale.py`, `test_view*.py`, `test_widget.py`,
   `test_plasmodb.py`) — no compiled extension needed.
2. **Real-extension integration** (`test_integration_extension.py`, NEW) — builds
   a synthetic multi-sample VCF, attaches it through the actual PyO3 session
   (`gs._init`), and asserts:
   - `get_locus_variant_aggregates` (Rust) == brute-force truth. Semantics
     confirmed: `n_ref`/`n_alt` are **per-sample carrier counts** (a het counts in
     BOTH), `n_missing` = #samples with missing GT.
   - view.py `fetch_carriers` resolves the right sample names end-to-end
     (regression guard for the zero-width-locus panic; see below).
   Skips (not fails) if the extension isn't built or bgzip/tabix are absent.
3. **Headless DOM** (`tests/headless/`) — pure-JS + jsdom cores via Playwright.
   ⚠️ **WebGPU pixels do NOT paint headless** under SwiftShader, so the smart-track
   canvas render (#65) and SNP letters (#67) still can't be pixel-verified here —
   only their pure-JS layout cores (`__gsComputeVirtualRowWindow`,
   `__gsTranslateFrame`, etc.) are tested. Those two need a real browser
   (see planning/MANUAL_TESTS.md §5–6). Probing a Dawn/flag path to paint WebGPU
   headless is the one remaining gap to fully close the loop.

Run everything:
```bash
cargo test --lib                        # Rust unit + aggregate==longformat equivalence
VIRTUAL_ENV=/opt/claude-venv python -m pytest python/tests -q   # 121 tests, ~3min (headless dominates)
```

## Bug this harness already caught

Building the integration test immediately surfaced a real production bug:
`parse_locus("chr1:100-100")` returned `(chr1, 100, 100)` — an **empty**
half-open interval. Once the Rust `staged_tree` was populated by any prior query,
`fetch_carriers` (which builds `"chr:pos-pos"`) hit `iset.iter(100..100)` and
**panicked** (`Interval is empty`). Carriers-on-demand would have crashed on every
real cohort. Fixed in `parse_locus` (src/lib.rs): widen `stop<=start` to
`start+1`, and `saturating_sub` the 2-part `chr:pos` underflow. This is exactly
the class of bug headless JS tests can't see — the closed loop earned its keep on
day one.
