"""WebGPU pixel regression tests (real Chrome, real GPU).

These render the actual viewer and assert on painted pixels — the layer the
plain headless suite (software GL) can't reach. They guard the WebGPU render
paths: the smart-track read canvas (#65 virtualization), the SNP glyph overlay
(#67), and read coloring.

Requires a working WebGPU GPU (see planning/WEBGPU_TESTING.md). The whole module
skips cleanly when Playwright/Chrome/GPU aren't present, so `pytest -q` on a
GPU-less host is unaffected.

Reads are seeded through `window.__GS_TEST_seedSmartTrack` (the test seam in
smart-tracks.js), which mirrors the real comm-driven read-load path.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(__file__))
pytest.importorskip("playwright")
pytest.importorskip("anywidget")
pytest.importorskip("PIL")

from playwright.sync_api import sync_playwright  # noqa: E402
import harness_gpu as hg  # noqa: E402


# --- fixtures --------------------------------------------------------------

@pytest.fixture(scope="module")
def gpu_browser():
    with sync_playwright() as pw:
        browser = hg.launch(pw)
        if browser is None:
            pytest.skip("real Chrome (channel=chrome) not installed")
        if not hg.webgpu_works(browser):
            browser.close()
            pytest.skip("no working WebGPU adapter (no GPU / headless / no --device nvidia-modeset)")
        yield browser
        browser.close()


# --- pixel predicates ------------------------------------------------------

def _reddish(p):   # hap1 read [255,100,100]@.5 over white ~ (255,177,177)
    r, g, b = p
    return r > 190 and r - g > 35 and r - b > 35


def _bluish(p):    # hap2 read [100,100,255]@.5 over white ~ (177,177,255)
    r, g, b = p
    return b > 190 and b - r > 35 and b - g > 35


def _non_blank(p):  # anything clearly off white
    r, g, b = p
    return (255 - r) + (255 - g) + (255 - b) > 40


# --- tests -----------------------------------------------------------------

def test_smart_track_paints_reads_on_webgpu(gpu_browser):
    """Seeded reads actually paint on the smart-track WebGPU canvas — the
    fundamental thing the software-GL headless suite cannot verify. Also guards
    the adapter-retry fix (first track after load must get WebGPU, not silently
    fall back to Canvas2D)."""
    with hg.open_viewer(gpu_browser) as (page, errors):
        res = hg.seed_reads(page, n=24, haplotype=1)
        assert res["readCount"] == 24
        assert res["hasWebGPU"] is True, "smart track fell back to Canvas2D (adapter not obtained)"
        page.wait_for_timeout(400)
        box = hg.canvas_box(page)
        assert box and box["w"] > 0 and box["h"] > 0
        _img, px = hg.region_pixels(page, box)
        assert hg.frac_matching(px, _non_blank) > 0.01, "WebGPU read canvas is blank"
        assert hg.frac_matching(px, _reddish) > 0.01, "no haplotype-1 (red) read pixels painted"
        assert errors == [], errors


def test_read_haplotype_colors(gpu_browser):
    """Haplotype coloring: hap1 paints red, hap2 paints blue."""
    with hg.open_viewer(gpu_browser) as (page, _):
        hg.seed_reads(page, sample_id="H1", n=20, haplotype=1)
        page.wait_for_timeout(300)
        _i, px = hg.region_pixels(page, hg.canvas_box(page))
        assert hg.frac_matching(px, _reddish) > 0.01
        assert hg.frac_matching(px, _bluish) < 0.005

    with hg.open_viewer(gpu_browser) as (page, _):
        hg.seed_reads(page, sample_id="H2", n=20, haplotype=2)
        page.wait_for_timeout(300)
        _i, px = hg.region_pixels(page, hg.canvas_box(page))
        assert hg.frac_matching(px, _bluish) > 0.01
        assert hg.frac_matching(px, _reddish) < 0.005


def test_virtualization_lifts_read_cap(gpu_browser):
    """#65: a deep pileup (well past the old 300-read cap) renders on WebGPU
    without crashing — all reads kept, packed into many rows."""
    with hg.open_viewer(gpu_browser) as (page, errors):
        res = hg.seed_reads(page, n=500, haplotype=1, rows_deep=True)
        assert res["readCount"] == 500, "reads were capped/dropped"
        assert res["rowCount"] > 300, f"deep pileup only made {res['rowCount']} rows"
        assert res["hasWebGPU"] is True
        page.wait_for_timeout(400)
        _i, px = hg.region_pixels(page, hg.canvas_box(page))
        assert hg.frac_matching(px, _non_blank) > 0.02, "deep pileup painted nothing"
        assert errors == [], errors


def test_vertical_reads_span_genomic_axis(gpu_browser):
    """#80: in vertical mode the read pileup must span the full genomic (Y) axis,
    not cram into the top. The bug passed the cross-axis length (container width,
    ~H) as the genomic-axis length to yGenomeCanonical, squashing every read into
    the top ~H/W of the canvas.

    Asserts the geometry the renderer emits (the read-body rect instances span
    most of the canvas height), not painted pixels — the vertical smart track has
    a separate first-frame paint quirk (alpha-blended bodies appear only after a
    context reconfigure) that makes pixel readback flaky; the coordinate mapping
    this test guards is deterministic."""
    with hg.open_viewer(gpu_browser, orientation="vertical") as (page, errors):
        hg.set_span(page, 900)
        # Record every rect instance the smart-track renderers emit.
        page.evaluate("""() => {
          window.__RECTS = [];
          const S = window.__GS_STATE;
          const patch = () => {
            for (const [tid, r] of (S.smartTrackRenderers || new Map())) {
              const ir = r.instancedRenderer;
              if (!ir || ir.__spy) continue; ir.__spy = 1;
              const o = ir.addRect.bind(ir);
              ir.addRect = (x, y, w, h, c, a) => {
                window.__RECTS.push({ y, h, alpha: (c && c.length > 3) ? c[3] : 1 });
                return o(x, y, w, h, c, a);
              };
            }
          };
          window.__spyPoll = setInterval(patch, 8); patch();
        }""")
        res = hg.seed_reads(page, n=14, haplotype=1, snp=True)
        assert res["hasWebGPU"] is True, "vertical smart track fell back to Canvas2D"
        page.wait_for_timeout(500)
        geom = page.evaluate("""() => {
          const c = document.querySelector('[id^="smart-track-webgpu-"]');
          const bodies = (window.__RECTS || []).filter(r => r.alpha < 0.7); // read bodies (a=.5)
          if (!bodies.length) return { n: 0 };
          const top = Math.min(...bodies.map(r => r.y));
          const bot = Math.max(...bodies.map(r => r.y + r.h));
          return { n: bodies.length, top, bot, canvasH: c ? c.height : 0 };
        }""")
        assert geom["n"] >= 14, f"read bodies not emitted in vertical mode: {geom}"
        span = (geom["bot"] - geom["top"]) / geom["canvasH"]
        assert span > 0.6, (
            f"vertical read bodies span only {span:.0%} of the genomic axis "
            f"({geom}) — crammed, not a full pileup")
        assert errors == [], errors


def test_virtualization_scroll_repaints(gpu_browser):
    """#65: scrolling the virtualized canvas repaints a different row window —
    the painted pixels must change (viewport-sized canvas + scroll offset)."""
    with hg.open_viewer(gpu_browser) as (page, _):
        res = hg.seed_reads(page, n=400, haplotype=1, rows_deep=True)
        tid = res["trackId"]
        page.wait_for_timeout(400)
        box = hg.canvas_box(page)
        _i0, before = hg.region_pixels(page, box)
        # scroll the smart-track container's scroll region and let it repaint
        scrolled = page.evaluate(
            """(tid) => {
                const c = document.getElementById('smart-track-container-'+tid);
                const sc = document.getElementById('smartScroll') || c;
                const target = (sc && sc.scrollHeight > sc.clientHeight) ? sc : c;
                target.scrollTop = 600;
                target.dispatchEvent(new Event('scroll'));
                return { top: target.scrollTop, id: target.id };
            }""", tid)
        assert scrolled["top"] > 0, "container did not scroll (not virtualized/scrollable)"
        page.wait_for_timeout(500)
        _i1, after = hg.region_pixels(page, box)
        diff = sum(1 for a, b in zip(before, after) if a != b) / max(1, len(before))
        assert diff > 0.02, f"scroll did not repaint the canvas (diff={diff:.3f})"


def test_smart_track_canvas_is_viewport_bounded(gpu_browser):
    """#65/#66: a deep pileup must NOT inflate the WebGPU canvas — it stays
    viewport-sized (the depth lives in the scroll spacer). This is what obviates
    the old "collapse smart tracks to one canvas" (#66) memory concern: every
    per-track canvas is bounded regardless of read depth, so N tracks cost N ×
    viewport, never N × full-stack. Guards against a regression back to
    full-stack canvases (the ~16384px GPU wall behind the old 300-read cap)."""
    with hg.open_viewer(gpu_browser) as (page, _):
        res = hg.seed_reads(page, n=400, haplotype=1, rows_deep=True)
        assert res["rowCount"] > 300  # genuinely a deep pileup
        page.wait_for_timeout(300)
        m = page.evaluate(
            """() => {
                const c = document.querySelector('[id^="smart-track-webgpu-"]');
                const sp = document.querySelector('.smart-track-vspacer');
                return { canvasH: c ? c.height : -1,
                         spacerH: sp ? parseInt(sp.style.height || '0', 10) : 0 };
            }""")
        # canvas backing height is viewport-bounded (open track ~220px * dpr),
        # far below the full stack the spacer represents.
        assert 0 < m["canvasH"] <= 700, f"canvas backing not viewport-bounded: {m}"
        assert m["spacerH"] > 3000, f"deep pileup not represented in the scroll spacer: {m}"
        assert m["spacerH"] > m["canvasH"] * 4, "canvas is tracking pileup depth (not virtualized)"


def test_snp_glyph_overlay(gpu_browser):
    """#67: SNP (Diff) elements paint a base letter on the text overlay canvas.
    The overlay is a Canvas2D layer, so read its pixels directly (getImageData):
    a seed with SNPs must leave non-transparent glyph pixels; one without must
    not."""
    with hg.open_viewer(gpu_browser) as (page, _):
        hg.set_span(page, 60)  # zoom in so per-base SNP tiles are wide enough for letters
        res = hg.seed_reads(page, n=16, haplotype=1, snp=True, snp_base="A")
        tid = res["trackId"]
        page.wait_for_timeout(500)
        nonblank = page.evaluate(
            """(tid) => {
                const t = document.getElementById('smart-track-text-'+tid);
                if (!t || !t.width || !t.height) return -1;
                const ctx = t.getContext('2d');
                const d = ctx.getImageData(0, 0, t.width, t.height).data;
                let n = 0;
                for (let i = 3; i < d.length; i += 4) if (d[i] > 10) n++;
                return n;
            }""", tid)
        assert nonblank > 0, "no SNP glyph pixels drawn on the text overlay"

    # control: no SNPs -> overlay has no glyph pixels
    with hg.open_viewer(gpu_browser) as (page, _):
        res = hg.seed_reads(page, n=16, haplotype=1, snp=False)
        tid = res["trackId"]
        page.wait_for_timeout(500)
        nonblank = page.evaluate(
            """(tid) => {
                const t = document.getElementById('smart-track-text-'+tid);
                if (!t || !t.width || !t.height) return 0;
                const d = t.getContext('2d').getImageData(0, 0, t.width, t.height).data;
                let n = 0;
                for (let i = 3; i < d.length; i += 4) if (d[i] > 10) n++;
                return n;
            }""", tid)
        assert nonblank == 0, "text overlay painted glyphs with no SNP elements present"
