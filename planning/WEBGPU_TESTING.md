# WebGPU pixel testing (real GPU)

How to run — and write — tests that render the viewer's **actual WebGPU output**
and assert on the pixels. This is a separate capability from the
[headless UI suite](../README.md#headless-ui-tests): that one renders the
DOM/layout in headless Chromium and never touches the GPU. Anything that only
shows up once WebGPU actually paints — the virtualized smart-track canvas (#65),
the SNP base-letter glyph atlas (#67), read colors, indel shading — needs this
path.

## TL;DR

```bash
python scripts/webgpu_smoke.py       # PASS: pixel [64,128,192,255] on your GPU
```

If it prints `PASS`, WebGPU pixel readback works on your machine and you can
run/write pixel tests. If it prints `SKIP`, the setup below isn't complete; if
it `FAIL`s, see [Troubleshooting](#troubleshooting).

## What the setup needs

Three things, most already present on a normal dev workstation with a GPU:

1. **A GPU + browser that support WebGPU.** Any recent discrete GPU with
   up-to-date drivers. Verify your browser at `chrome://gpu` — "WebGPU: Hardware
   accelerated".
2. **Real Google Chrome** (or Chromium with WebGPU enabled) — *not* Playwright's
   bundled Chromium, which is built with WebGPU compiled out (`navigator.gpu` is
   `undefined`). Install once:
   ```bash
   pip install playwright
   python -m playwright install chrome     # the real Chrome channel
   ```
   The tests launch it with `channel="chrome"`.
3. **A secure origin.** `navigator.gpu` is exposed over `http://127.0.0.1` (and
   https), but hidden on opaque `about:blank`. The test harness serves the page
   from a localhost HTTP server for you.

On a desktop with a display and a GPU, that's all — `webgpu_smoke.py` should
`PASS`.

## Running without a display (headless server / CI)

If the machine has **no display** (a headless build server, CI runner, or a
container), WebGPU needs a couple of extra pieces, because the GPU driver's
graphics stack won't initialize without one. `scripts/setup_gpu_webgpu.sh` sets
all of it up idempotently; run it once per machine (or per container start):

```bash
source scripts/setup_gpu_webgpu.sh    # installs deps, starts a virtual display, checks the GPU
python  scripts/webgpu_smoke.py
```

What it handles that a desktop already has:

- **A virtual X display** — `Xvfb`, exported as `DISPLAY`. On NVIDIA the Vulkan
  driver links libX11 and won't initialize headless at all (Vulkan negotiation
  fails); a virtual display satisfies it. Chrome then runs **headed inside
  Xvfb** (fully headless Chrome tears down the WebGPU instance during adapter
  creation).
- **The Vulkan loader + a driver ICD** for your GPU, and (NVIDIA) pinning the
  hardware ICD so software `llvmpipe` doesn't win adapter selection.
- **In a container specifically**, the GPU's graphics device must be exposed to
  the container, not just the compute device — for NVIDIA that means the
  `nvidia-modeset` device (`--device /dev/nvidia-modeset` at launch, or the
  full `graphics` driver capability). The script checks this and tells you if
  it's missing.

## The pixel test suite

`python/tests/headless/test_webgpu_pixels.py` is the suite; it renders the real
viewer on the GPU and asserts on painted pixels. Run it:

```bash
source scripts/setup_gpu_webgpu.sh            # headless hosts only; desktop can skip
pytest python/tests/headless/test_webgpu_pixels.py -q
```

It covers: reads actually paint on the smart-track WebGPU canvas; haplotype
colors (hap1 red / hap2 blue); #65 virtualization (a 500-read pileup lifts the
old 300-read cap and packs into >300 rows; scrolling repaints a different row
window); and #67 SNP base-letter glyphs on the text overlay. The whole module
skips cleanly (no GPU / no Chrome / no display), so `pytest -q` is unaffected.

The plumbing is in `python/tests/headless/harness_gpu.py`: it serves the real
viewer (via `harness.build_page`) over `http://127.0.0.1`, launches real Chrome
headed with the WebGPU/Vulkan flags, and exposes helpers — `open_viewer`,
`seed_reads`, `set_span`, `canvas_box`, `region_pixels`, `frac_matching`.

Reads are seeded through a test seam in `smart-tracks.js`,
`window.__GS_TEST_seedSmartTrack(sampleId, rawReads, opts)`, which mirrors the
real comm-driven read-load path (createSmartTrack → set readsData/readsLayout →
renderSmartTrack). `window.__GS_TEST_setSpan(bp)` zooms the locus so per-base
SNP tiles are wide enough to draw letters. These are inert in production (same
`window.__GS_*` seam pattern as `__GS_processReadsData`).

### Writing a new pixel test

1. `with hg.open_viewer(browser) as (page, errors):` — real viewer, ready.
2. `hg.seed_reads(page, n=…, haplotype=…, rows_deep=…, snp=…)` — canned reads.
3. Read pixels back —
   - **Screenshot a canvas region**: `hg.region_pixels(page, hg.canvas_box(page))`
     + `hg.frac_matching(px, predicate)` (the WebGPU read canvas; screenshot is
     the only readback for a `webgpu` context).
   - **Direct `getImageData`**: the SNP text overlay is a Canvas2D layer — read
     its pixels straight from `smart-track-text-<id>` (deterministic, no
     screenshot).
4. Assert with lenient thresholds — solid fills tolerate a wide band; anti-
   aliased text just needs "non-blank". Also assert `errors == []`.

`scripts/webgpu_smoke.py` remains the minimal standalone example (own render
pass + exact `copyTextureToBuffer` readback) if you need pixel-exact control.

## CI

- **Default gate** (`.github/workflows/ci.yml`, GitHub-hosted): Rust +
  Python + headless-UI. It also *collects* the pixel suite, which **skips**
  there (no GPU / no real-Chrome channel), so the gate stays green.
- **GPU gate** (`.github/workflows/webgpu.yml`): runs the pixel suite for real
  on a **self-hosted runner** labeled `[self-hosted, gpu]`. Triggered manually
  (`workflow_dispatch`) or by adding the `webgpu` label to a PR. Register a
  runner on a host with an NVIDIA GPU (this doc's setup); until one exists the
  job simply doesn't run and nothing blocks.
- One command runs every layer locally: `scripts/run_all_tests.sh [--gpu|--fast]`.

`webgpu_smoke.py` and every pixel test exit/skip cleanly when Playwright or
`navigator.gpu` is missing, so `pytest -q` on a laptop stays green. Where no GPU
runs them, #65/#67 render correctness is also spot-checked by a human per
[MANUAL_TESTS.md](MANUAL_TESTS.md).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `no navigator.gpu` | bundled Chromium, or insecure origin | `python -m playwright install chrome` + launch `channel="chrome"`; serve over `http://127.0.0.1`, not `about:blank` |
| `no adapter` | fully headless, or `--disable-gpu` present | `headless=False`; `ignore_default_args=["--disable-gpu"]` (on a headless host, under Xvfb) |
| `vulkaninfo` shows only `llvmpipe` (CPU) | hardware ICD didn't load | ensure a display is set (`DISPLAY`, Xvfb if headless); pin `VK_DRIVER_FILES` at your GPU's ICD |
| Vulkan init fails on a headless host | no X display | `Xvfb :99` + `export DISPLAY=:99` (or just run `setup_gpu_webgpu.sh`) |
| adapter vendor is software, not your GPU | software ICD won selection | keep `VK_DRIVER_FILES` set to the hardware ICD in the test env |
| (container) graphics init fails though compute works | only the compute device is exposed | expose the graphics device too (NVIDIA: `--device /dev/nvidia-modeset`) |

`scripts/setup_gpu_webgpu.sh` is the executable source of truth for the headless
setup; keep this doc in sync with it.
