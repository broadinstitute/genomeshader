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
3. **Headless DOM** (`tests/headless/test_headless.py`) — the real viewer in
   headless Chromium (software GL) via Playwright; asserts on SVG/DOM/interaction
   (WebGPU doesn't paint under software GL, so pixels are covered by layer 4).
4. **WebGPU pixels** (`tests/headless/test_webgpu_pixels.py`) — the real viewer on
   a real GPU (real Chrome, headed under Xvfb). Asserts painted pixels: reads on
   the smart-track WebGPU canvas, haplotype colors, #65 virtualization (500-read
   pileup lifts the 300 cap; scroll repaints), #67 SNP glyph letters. Skips
   cleanly with no GPU. Requires the setup in the next section; guide in
   planning/WEBGPU_TESTING.md. (This layer caught a real bug: `requestAdapter()`
   had no retry, so the first read track after load intermittently dropped to
   Canvas2D — fixed in webgpu-core.js.)

### WebGPU on the real GPU — NOW WORKING (2026-09-03)

**Reversed the 2026-09-02 dead end.** WebGPU paint+readback works on the Quadro
RTX 8000. The developer-facing guide is
[planning/WEBGPU_TESTING.md](WEBGPU_TESTING.md) (setup, writing pixel tests,
troubleshooting); `scripts/setup_gpu_webgpu.sh` is the idempotent rebuild and the
executable source of truth. Quick check:

```bash
source scripts/setup_gpu_webgpu.sh    # loader+ICD+Xvfb+Chrome, checks the GPU
python scripts/webgpu_smoke.py        # PASS: pixel [64,128,192,255] exact on nvidia/turing
```

Agent-recreation notes specific to this container: only the operator-side
`--device /dev/nvidia-modeset` (needed, else Vulkan `INITIALIZATION_FAILED`)
persists across relaunch; the loader, ICD json, device perms, and Xvfb all reset
— re-run the setup script. The load-bearing non-obvious bit (see the guide): the
NVIDIA Vulkan ICD links libX11 and won't init without a live X display, so Xvfb
is mandatory even for "headless".

--- historical probe log (2026-09-02), kept for context ---

Spent a full pass trying to paint+read back a WebGPU frame so #65/#67 could
self-test. Findings below were the pre-GPU-passthrough state (headless, no
`--device nvidia-modeset`, no real GPU). Superseded by the section above:

- **Playwright's bundled Chromium** (`chromium-1234`, even the full build, not just
  `chromium_headless_shell`): `navigator.gpu` is **undefined** — the WebGPU JS
  binding is compiled out. No flag brings it back.
- **Real Google Chrome** (`playwright install chrome` → Chrome 152) is required.
  Then `navigator.gpu` appears, but ONLY with BOTH:
  - `ignore_default_args=["--disable-gpu"]` — Playwright injects `--disable-gpu`,
    which hides WebGPU; and
  - a **real secure origin** — `page.set_content()` (opaque about:blank) hides
    `navigator.gpu`; serving over `http://127.0.0.1:<port>` (localhost is secure)
    exposes it.
- Even then, **no config yields a working adapter+device+pixel**:
  - `headless=True` (+swiftshader OR lavapipe): `requestAdapter()` throws
    `OperationError: A valid external Instance reference no longer exists` — Chrome
    headless tears down the WebGPU instance immediately.
  - `headless=False` under **Xvfb** + `--use-angle=swiftshader`: device request
    hangs indefinitely.
  - `headless=False` under **Xvfb** + Mesa **lavapipe** (`apt install
    mesa-vulkan-drivers`; `VK_ICD_FILENAMES=…/lvp_icd.x86_64.json`;
    `--use-angle=vulkan`): `vulkaninfo` sees the `llvmpipe` device fine, but
    Chrome's `requestAdapter()` never resolves (still timing out at 40s).

Net: WebGPU can be *enabled* but not *driven* here. A working path would need
debugging Dawn↔Vulkan↔lavapipe (a Dawn instance/toggle flag, or a newer lavapipe)
— disproportionate vs. verifying #65/#67 in the user's browser. Real Chrome +
lavapipe are now installed in this (ephemeral) container; NOT added to
setup_test_env.sh since they don't yield working WebGPU. Resume from this exact
stopping point if the payoff ever justifies it.

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
