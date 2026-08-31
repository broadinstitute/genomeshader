# genomeshader

An interactive, **population-scale** genome browser for genetic variation. You
navigate between variant sites — each shown with its alleles sized by cohort
frequency (the "alleuvial" flow) — then deep-dive from a variant into the reads
of the samples that carry it. It runs in the notebook as a Jupyter
[anywidget](https://anywidget.dev) (classic Notebook, JupyterLab, Notebook 7, VS
Code, Colab, Terra), is GPU-accelerated (WebGPU with an SVG fallback), and is
reference-agnostic (human and non-human assemblies).

The stack: a **Rust** data engine (rust-htslib BAM/VCF, indexed region seek,
polars) exposed to **Python** (orchestration, UCSC/annotation, the anywidget
host) driving a **JavaScript/WebGPU** viewer.

## Install (development)

```bash
python -m venv .venv && source .venv/bin/activate
pip install -U maturin
pip install -r dev-requirements.txt
maturin develop --release      # builds the Rust extension in-place
```

## Testing

Three suites. The Rust and Python suites are the default CI gate; the headless
UI suite renders the real frontend and guards browser-side regressions.

### Rust

```bash
cargo test
```

### Python (Rust + orchestration)

```bash
maturin develop            # the Python tests import the Rust extension
pytest -q                  # from the python/ dir, or: pytest python/tests -q
```

### Headless UI tests

`python/tests/headless/` renders the actual ~15k-line viewer in **headless
Chromium** via [Playwright](https://playwright.dev/python/) and asserts on
layout, coordinates, and interaction behavior — the class of regressions the
unit tests can't reach (blank renders, misaligned tracks, render storms, broken
orientations).

**Setup** (one-time browser download):

```bash
pip install playwright anywidget      # or: pip install -e '.[test-ui]'
python -m playwright install chromium
```

**Run:**

```bash
pytest python/tests/headless -q
```

The suite **skips cleanly** if Playwright or the browser isn't installed, so a
plain `pytest -q` is unaffected. CI installs the browser and runs it as an extra
step in the `test` job (reusing the maturin build).

#### How the harness works

`python/tests/headless/harness.py` mounts the viewer two ways, matching the two
things that actually break:

- **`build_page(config=None, instrument=False)`** — the concatenated viewer
  scripts wrapped in `__runViewer__` exactly as the anywidget host runs them,
  served from a `file://` origin (so `localStorage` works and orientation can be
  set). Renders the built-in demo data when `config` is empty. `instrument=True`
  injects a `window.__rc` counter incremented on every `renderAll()` (for
  render-coalescing / perf checks). Use for layout / coordinate / interaction
  tests.
- **`esm_module_source()`** — the real `_build_esm()` output (`export default
  {render}`). Import it as a strict ES module from an **opaque blob origin** to
  reproduce a sandboxed notebook output (VS Code / Colab / Terra), where
  `localStorage` throws. Use to guard the sandbox-render path.

**Caveat:** WebGPU does not paint under swiftshader in headless Chromium, so the
tests assert on the **SVG / DOM / interaction** layers (which do render), not on
WebGPU pixels. Signals the tests read: `window.__GS_READY` / `window.__GS_ERR`
(load state), `#tracksSvg` children (tracks rendered), `window._alleleNodePositions`
(flow node geometry, for hit-testing/alignment), and `window.__rc` (render count,
when instrumented).

#### What the tests cover

Each maps to a fixed regression:

| Test | Guards |
| ---- | ------ |
| `test_viewer_renders[horizontal/vertical]` | boots without console errors, tracks render, both orientations |
| `test_renders_in_sandboxed_origin` | the `localStorage` guard — viewer must render in an opaque/sandboxed origin |
| `test_ruler_flow_alignment` | ruler variant marks stay aligned with flow nodes |
| `test_vertical_spreads_variants` | vertical mode maps variants across the full genome axis |
| `test_fullscreen_cycle_keeps_tracks` | enter/exit/enter fullscreen keeps the tracks |
| `test_double_click_coalesces_renders` | double-click coalesces to one render (not the 6-render storm) |

#### Adding a test

```python
def test_something(browser, tmp_path):
    page, errors = _open(browser, tmp_path, "horizontal")   # or "vertical"
    _wait_ready(page)          # or _wait_nodes(page) once flow nodes exist
    value = page.evaluate("() => /* read a DOM/state signal */")
    assert ...
    assert errors == [], errors
    page.close()
```

Prefer deterministic DOM/state assertions over pixels or timing. For
interaction tests, drive real input (`page.mouse.click/dblclick`, `page.keyboard`)
rather than synthetic events — synthetic `MouseEvent`s default to clientX=0 and
trip edge handlers.
