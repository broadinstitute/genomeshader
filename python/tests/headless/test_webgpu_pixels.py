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


def _base_green(p):  # SNP 'A' tile uses the base palette green [0,200,0], opaque
    r, g, b = p
    return g > 150 and g - r > 60 and g - b > 60


def test_reads_show_snp_markers(gpu_browser):
    """Per-read SNP markers paint on the sample track. Guards against the
    individual SNP tiles silently vanishing from the read pileup. (SNP *detection*
    — MD tag or reference fallback — is covered by the Rust alignment tests; this
    guards the render end of the pipe: a read carrying a Diff element paints a
    base-colored tile distinct from the haplotype-colored body.)"""
    with hg.open_viewer(gpu_browser) as (page, errors):
        hg.set_span(page, 60)  # zoom in so per-base SNP tiles are wide
        res = hg.seed_reads(page, n=10, haplotype=1, snp=True, snp_base="A")
        assert res["hasWebGPU"] is True
        page.wait_for_timeout(400)
        _img, px = hg.region_pixels(page, hg.canvas_box(page))
        assert hg.frac_matching(px, _base_green) > 0.002, \
            "no base-colored SNP tiles painted on the reads (SNP markers vanished?)"
        assert errors == [], errors


def test_snp_letter_sits_on_tile(gpu_browser):
    """The SNP base letter (2D text overlay) must land ON its colored tile
    (WebGPU), not below it. The text canvas is inline by default, so as a later
    sibling of the WebGPU canvas it picked up a line-box gap and sat ~a font
    descent too low — the white letter then drew on the white background below
    the tile (invisible). Assert white glyph pixels fall inside the tile's box."""
    with hg.open_viewer(gpu_browser) as (page, errors):
        hg.set_span(page, 20)  # wide per-base tiles so the letter renders
        hg.seed_reads(page, n=1, haplotype=1, snp=True, snp_base="A")
        page.wait_for_timeout(400)
        img, px = hg.region_pixels(page, hg.canvas_box(page))
        W, _H = img.size
        green = [(i % W, i // W) for i, p in enumerate(px) if _base_green(p)]
        assert green, "no SNP tile painted"
        gx0, gx1 = min(x for x, _ in green), max(x for x, _ in green)
        gy0, gy1 = min(y for _, y in green), max(y for _, y in green)
        white_in_tile = [
            (i % W, i // W) for i, p in enumerate(px)
            if gx0 <= i % W <= gx1 and gy0 <= i // W <= gy1
            and p[0] > 235 and p[1] > 235 and p[2] > 235
        ]
        assert white_in_tile, "no white letter pixels inside the SNP tile (letter offset off the box)"
        assert errors == [], errors


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
    """#80 + #81: in vertical mode the read pileup must PAINT on the first frame
    and span the full genomic (Y) axis. Two bugs met here: (#80) the vertical
    branch passed the cross-axis length as the genomic-axis length to
    yGenomeCanonical, squashing reads into the top ~24%; (#81) the WebGPU
    projection was only synced at init/resize, so on load (before layout settled)
    all geometry mapped offscreen and nothing painted until a manual resize. Now
    asserts painted red (hap-1) pixels span most of the canvas height on the
    first paint — no resize nudge."""
    with hg.open_viewer(gpu_browser, orientation="vertical") as (page, errors):
        hg.set_span(page, 900)
        res = hg.seed_reads(page, n=14, haplotype=1, snp=True)
        assert res["hasWebGPU"] is True, "vertical smart track fell back to Canvas2D"
        page.wait_for_timeout(500)  # first paint only — no resize
        box = hg.canvas_box(page)
        assert box and box["h"] > 0
        img, px = hg.region_pixels(page, box)
        W, Hh = img.size
        ys = [i // W for i, p in enumerate(px) if _reddish(p)]
        assert ys, "no haplotype-1 read pixels on first paint (regressed #81?)"
        span = (max(ys) - min(ys)) / Hh
        assert span > 0.6, (
            f"vertical reads span only {span:.0%} of the genomic axis "
            f"(y[{min(ys)},{max(ys)}]/{Hh}) — crammed, not a full pileup")
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


# Instrument the 2D context BEFORE load: count thin vertical strokes (the
# per-variant connector line was a 1px vertical stroke over the allele stack).
_CONNECTOR_PROBE = r"""
window.__GS_THINV = 0;
(function () {
  const P = CanvasRenderingContext2D.prototype;
  let x0, y0, x1, y1, act = false;
  const rs = () => { x0 = y0 = 1e9; x1 = y1 = -1e9; act = true; };
  const pt = (x, y) => { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; };
  const ob = P.beginPath; P.beginPath = function () { rs(); return ob.apply(this, arguments); };
  ["moveTo", "lineTo"].forEach((m) => { const o = P[m]; P[m] = function (x, y) { if (act) pt(x, y); return o.apply(this, arguments); }; });
  const oa = P.arcTo; P.arcTo = function (a, b, c, d) { if (act) { pt(a, b); pt(c, d); } return oa.apply(this, arguments); };
  const os = P.stroke; P.stroke = function () {
    if (act && x1 >= x0 && Math.abs(x1 - x0) <= 3 && Math.abs(y1 - y0) >= 6) window.__GS_THINV++;
    return os.apply(this, arguments);
  };
})();
"""


def test_no_per_variant_connector_line(gpu_browser):
    """Regression: the variant/flow track must NOT draw a per-variant thin grey
    vertical connector line over the top of the allele stack (looked like a
    circle-less lollipop). It was ctx.moveTo(vx,6)->lineTo(cx,junctionY)->stroke
    in drawOneFlowBand. Instrument the 2D context and assert no thin vertical
    strokes are painted."""
    with hg.open_viewer(gpu_browser, init_script=_CONNECTOR_PROBE) as (page, errors):
        page.wait_for_function(
            "() => (window._alleleNodePositions || []).length > 0", timeout=20000)
        page.wait_for_timeout(400)
        thin = page.evaluate("() => window.__GS_THINV || 0")
        assert thin == 0, f"per-variant connector line(s) drawn: {thin} thin vertical strokes"
        assert not [e for e in errors if "pageerror" in e], errors


def test_reference_allele_node_present(gpu_browser):
    """Regression: the reference allele node must render on the variant track (an
    earlier fix wrongly skipped it). At least one allele node whose label is the
    formatted reference allele should exist for a variant that has one."""
    with hg.open_viewer(gpu_browser) as (page, _):
        page.wait_for_function(
            "() => (window._alleleNodePositions || []).length > 0", timeout=20000)
        has_ref = page.evaluate(
            """() => {
                const cfg = window.GENOMESHADER_CONFIG || {};
                const vts = cfg.variant_tracks || [];
                const refs = new Set();
                vts.forEach(t => (t.variants_data || []).forEach(v => {
                    if (v.refAllele) refs.add(String(v.refAllele));
                }));
                if (refs.size === 0) return true;  // no ref info in fixture -> not applicable
                // a rendered node whose actual allele equals a variant's ref
                return (window._alleleNodePositions || []).some(n => {
                    const lbl = String(n.label || "");
                    // ref label is "<REF> (n bp)"; match the leading allele token
                    const tok = lbl.split(" ")[0];
                    return refs.has(tok);
                });
            }""")
        assert has_ref, "reference allele node not rendered on the variant track"


def test_indel_lollipop_click_expands_not_selects(gpu_browser):
    """Clicking the indel lollipop must expand the indel, NOT select the variant.
    The lollipop lives in a separate overlay from the flow's variant-select layer;
    its hit-area must swallow the whole gesture (mousedown/pointerdown/click) so a
    click can't leak through to the variant hoverRect / mousedown-select below."""
    cfg = {
        "region": "chr1:100835-100855",
        "data_bounds": {"start": 100835, "end": 100855},
        "reference_data": "ATTATCTAGTTTAGAAAAA",
        "chrom_lengths": {"chr1": 248000000},
        "variant_tracks": [{"id": "flow-0", "label": "WGS", "variants_phased": False,
            "variants_data": [{"id": "i1", "pos": 100845, "position": 100845,
                "refAllele": "A", "altAlleles": ["ATTT"], "isInsertion": True,
                "isDeletion": False, "ref": "A", "alt": "ATTT", "n_ref": 90,
                "n_alt": 6, "n_missing": 3, "n_samples": 99, "genotypes": [], "samples": []}]}],
        "viewport_variant_loading": False,
    }
    with hg.open_viewer(gpu_browser, config=cfg) as (page, errors):
        page.wait_for_function(
            '() => !!document.querySelector("#flowIndelOverlay line[data-variant-id]")',
            timeout=20000)
        # Stacking invariant: the lollipop overlay MUST sit above the flow
        # container (a z-index:101 stacking context). If it drops below, the
        # flow's variant hoverRects capture every hover/click and the indel is
        # unreachable — the exact bug this guards.
        zc = page.evaluate("""() => ({
            flow: parseInt(getComputedStyle(document.getElementById('flow')).zIndex) || 0,
            indel: parseInt(getComputedStyle(document.getElementById('flowIndelOverlay')).zIndex) || 0,
        })""")
        assert zc["indel"] > zc["flow"], f"lollipop overlay not above the flow: {zc}"

        pts = page.evaluate("""() => {
            const head = document.querySelector('#flowIndelOverlay circle[style*="pointer-events: all"]');
            const stem = document.querySelector('#flowIndelOverlay line[data-variant-id]');
            const hr = head.getBoundingClientRect(), sr = stem.getBoundingClientRect();
            return {
                head: { x: hr.x + hr.width / 2, y: hr.y + hr.height / 2 },
                // near the bottom of the stem — should be click-through (below the head)
                stem: { x: sr.x + sr.width / 2, y: sr.y + sr.height * 0.85 },
            };
        }""")
        # The head hit-disc must be the topmost element at its own point (not a
        # variant hoverRect from the flow layer below).
        topvid = page.evaluate(
            "(p) => { const e = document.elementFromPoint(p.head.x, p.head.y); return e && e.getAttribute && e.getAttribute('data-variant-id'); }",
            pts)
        assert topvid == "i1", f"lollipop head not on top at its own point (got {topvid})"

        # Clicking the HEAD expands the indel, without leaking to variant select.
        page.mouse.click(pts["head"]["x"], pts["head"]["y"])
        page.wait_for_timeout(200)
        st = page.evaluate("""() => ({
            exp: [...(window.__GS_STATE.expandedInsertions || [])],
            sel: window.__GS_STATE.selectedAlleles ? [...window.__GS_STATE.selectedAlleles] : [],
        })""")
        assert st["exp"] == ["i1"], f"lollipop head click did not expand the indel: {st}"
        assert st["sel"] == [], f"lollipop head click leaked to variant select: {st}"

        # Clicking the STEM (not the head) must NOT expand — only the head toggles;
        # the stem/strip stays click-through so the alleles underneath are usable.
        page.evaluate("() => { window.__GS_STATE.expandedInsertions.clear(); }")
        page.mouse.click(pts["stem"]["x"], pts["stem"]["y"])
        page.wait_for_timeout(150)
        exp2 = page.evaluate("() => [...(window.__GS_STATE.expandedInsertions || [])]")
        assert exp2 == [], f"clicking the stem expanded the indel (should be head-only): {exp2}"


@pytest.mark.skip(reason="overscan pan disabled from the drag path (misaligned variants + "
                         "half-painted tracks on real data); re-enable with this test when "
                         "validated against real variant/gene data")
def test_overscan_live_pan_reveals_content(gpu_browser):
    """#41: horizontal live pan uses render overscan — the pan layers are painted
    WIDER than the viewport and translated, so the leading edge is never blank and
    there's no per-frame rebuild stutter. Drive a real drag and assert overscan
    engages (reads canvas widens + shifts left, reads keep painting), then settles
    (canvas restored, view actually panned), with no JS errors."""
    with hg.open_viewer(gpu_browser) as (page, errors):
        hg.set_span(page, 400)
        res = hg.seed_reads(page, n=24, haplotype=1)
        assert res["hasWebGPU"] is True
        page.wait_for_timeout(400)

        rest = page.evaluate(
            """() => { const c = document.querySelector('[id^="smart-track-webgpu-"]');
                 const r = c.getBoundingClientRect();
                 return { start: window.__GS_STATE.startBp, w: r.width, x: r.x,
                          pad: window.__GS_STATE.renderPadPx || 0 }; }""")
        assert rest["pad"] == 0, "overscan should be off at rest"

        box = hg.canvas_box(page)
        cx, cy = box["x"] + box["w"] / 2, box["y"] + box["h"] / 2
        page.mouse.move(cx, cy)
        page.mouse.down()
        for i in range(1, 7):
            page.mouse.move(cx + i * 20, cy)  # drag right ~120px (reveals earlier bp on the left)

        during = page.evaluate(
            """() => { const c = document.querySelector('[id^="smart-track-webgpu-"]');
                 const r = c.getBoundingClientRect();
                 return { pad: window.__GS_STATE.renderPadPx || 0,
                          off: window.__GS_STATE.livePanOffset || 0,
                          w: r.width, x: r.x }; }""")
        assert during["pad"] > 0, "overscan did not engage during the drag"
        assert during["off"] != 0, "no live-pan translate accumulated"
        assert during["w"] > rest["w"] + 50, \
            f"reads canvas did not widen for overscan ({rest['w']:.0f}->{during['w']:.0f})"
        assert during["x"] < rest["x"] - 10, "widened canvas not offset left by the pad"

        # reads still paint on the widened, translated canvas (sample its visible span)
        vx = max(0.0, during["x"])
        vw = min(during["w"], 1200 - vx)
        _i, px = hg.region_pixels(page, {"x": vx, "y": box["y"], "w": vw, "h": box["h"]})
        assert hg.frac_matching(px, _reddish) > 0.005, "reads vanished during overscan pan"

        page.mouse.up()
        page.wait_for_timeout(300)  # let the settle repaint fire

        after = page.evaluate(
            """() => { const c = document.querySelector('[id^="smart-track-webgpu-"]');
                 const r = c.getBoundingClientRect();
                 return { start: window.__GS_STATE.startBp, w: r.width, x: r.x,
                          pad: window.__GS_STATE.renderPadPx || 0 }; }""")
        assert after["pad"] == 0, "overscan not cleared on settle"
        assert abs(after["w"] - rest["w"]) < 5, \
            f"canvas width not restored after commit ({rest['w']:.0f}->{after['w']:.0f})"
        assert after["start"] < rest["start"] - 1, "drag-right did not pan to an earlier locus"

        _i2, px2 = hg.region_pixels(page, hg.canvas_box(page))
        assert hg.frac_matching(px2, _reddish) > 0.005, "reads gone after commit"
        assert errors == [], errors


def _near_white(p):
    r, g, b = p
    return r > 230 and g > 230 and b > 230


def test_vertical_reads_show_strand_arrows(gpu_browser):
    """#bug6: vertical read pileup must draw the strand-direction (read-pair)
    arrow, like the horizontal branch. The arrow is a white triangle drawn on the
    read body — so within the bounding box of the (reddish) hap-1 read pixels
    there must be near-white pixels. The vertical branch used to draw the body
    only, so no white sat inside the reads."""
    with hg.open_viewer(gpu_browser, orientation="vertical") as (page, errors):
        hg.set_span(page, 900)
        res = hg.seed_reads(page, n=12, haplotype=1)  # no SNPs -> only white is the arrow
        assert res["hasWebGPU"] is True, "vertical smart track fell back to Canvas2D"
        page.wait_for_timeout(500)
        img, px = hg.region_pixels(page, hg.canvas_box(page))
        W, _H = img.size
        reds = [(i % W, i // W) for i, p in enumerate(px) if _reddish(p)]
        assert reds, "no hap-1 read bodies painted"
        rx0, rx1 = min(x for x, _ in reds), max(x for x, _ in reds)
        ry0, ry1 = min(y for _, y in reds), max(y for _, y in reds)
        white_in_reads = sum(
            1 for i, p in enumerate(px)
            if rx0 <= i % W <= rx1 and ry0 <= i // W <= ry1 and _near_white(p))
        assert white_in_reads > 0, "no strand-direction arrow pixels inside the vertical reads"
        assert errors == [], errors


def test_orientation_flip_keeps_smart_canvas_clean(gpu_browser):
    """#bug5: vertical -> horizontal -> vertical must not leave the smart-track
    canvas with a stale horizontal CSS box (sticky position + fixed px width) over
    a vertical backing store — that rendered zoomed/pixelated and broke scrolling.
    After returning to vertical the canvas CSS size must match its backing (÷dpr)
    and the sticky/marginTop leftovers must be cleared."""
    with hg.open_viewer(gpu_browser, orientation="vertical") as (page, errors):
        hg.set_span(page, 900)
        res = hg.seed_reads(page, n=12, haplotype=1)
        assert res["hasWebGPU"] is True
        page.wait_for_timeout(400)

        def flip(o):
            page.evaluate("(o) => window.__GS_TEST_setOrientation(o)", o)
            page.wait_for_timeout(400)

        flip("horizontal")
        flip("vertical")

        m = page.evaluate(
            """() => { const c = document.querySelector('[id^="smart-track-webgpu-"]');
                 if (!c) return null;
                 const r = c.getBoundingClientRect();
                 return { backW: c.width, backH: c.height,
                          cssW: r.width, cssH: r.height, dpr: window.devicePixelRatio || 1,
                          pos: c.style.position || '', mt: c.style.marginTop || '' }; }""")
        assert m, "smart-track canvas missing after orientation flips"
        # backing matches the CSS box (no zoom/pixelation), within 2px * dpr
        assert abs(m["backW"] - m["cssW"] * m["dpr"]) <= 2 * m["dpr"], m
        assert abs(m["backH"] - m["cssH"] * m["dpr"]) <= 2 * m["dpr"], m
        assert m["pos"] != "sticky", f"stale horizontal sticky position after flip: {m}"
        assert m["mt"] in ("", "0px"), f"stale negative marginTop after flip: {m}"

        # reads still paint after the round-trip
        _i, px = hg.region_pixels(page, hg.canvas_box(page))
        assert hg.frac_matching(px, _reddish) > 0.005, "reads gone after orientation round-trip"
        assert errors == [], errors


def test_vertical_collapsed_shows_aggregate_variants(gpu_browser):
    """#bug88: a COLLAPSED vertical sample track must render the whole sample's
    variants/SNPs (aggregated onto one column), like horizontal collapsed — not
    just a single read's. Seed many SNP-bearing reads at different positions,
    collapse, and assert base-colored SNP pixels span multiple genomic (Y) rows.
    The vertical branch used to skip every read but row 0, so only one read's SNP
    showed."""
    with hg.open_viewer(gpu_browser, orientation="vertical") as (page, errors):
        hg.set_span(page, 300)
        res = hg.seed_reads(page, n=12, haplotype=1, snp=True, snp_base="A", collapsed=True)
        assert res["hasWebGPU"] is True
        page.wait_for_timeout(500)
        img, px = hg.region_pixels(page, hg.canvas_box(page))
        W, _H = img.size
        greens = [i // W for i, p in enumerate(px) if _base_green(p)]  # y of SNP pixels
        assert greens, "no SNP markers in the collapsed vertical track (aggregate not drawn)"
        span = max(greens) - min(greens)
        assert span > 20, (
            f"collapsed SNP markers span only {span}px on the genomic axis — looks "
            f"like one read, not the whole-sample aggregate")
        assert errors == [], errors


def test_vertical_horizontal_scroll_across_columns(gpu_browser):
    """#bug87: in vertical mode, many expanded sample tracks lay out as
    side-by-side columns that overflow the viewport width. A horizontal wheel
    must scroll them (cross-axis), moving every column left in lockstep while the
    genomic ruler gutter stays put — the equivalent of the sample scroll, on the
    horizontal axis."""
    with hg.open_viewer(gpu_browser, orientation="vertical") as (page, errors):
        page.evaluate(
            """async () => { const S = window.__GS_STATE;
                 for (let k = 0; k < 8; k++) {
                   const reads = {query_name:['r'+k], element_type:[0],
                     reference_start:[S.startBp+10], reference_end:[S.endBp-10],
                     is_forward:[true], haplotype:[1], sample_name:['S'+k], sequence:['']};
                   await window.__GS_TEST_seedSmartTrack('S'+k, reads, {collapsed:false});
                 } }""")
        page.wait_for_timeout(700)

        def lefts():
            return page.evaluate(
                """() => [...document.querySelectorAll('[id^="smart-track-container-"]')]
                     .map(c => Math.round(c.getBoundingClientRect().x))""")

        before = lefts()
        assert len(before) >= 4, f"expected several sample columns, got {len(before)}"

        box = page.evaluate(
            "() => { const m = document.getElementById('main'); const r = m.getBoundingClientRect(); return {x:r.x+r.width/2, y:r.y+r.height/2}; }")
        page.mouse.move(box["x"], box["y"])
        for _ in range(4):
            page.mouse.wheel(120, 0)  # horizontal scroll
            page.wait_for_timeout(60)
        page.wait_for_timeout(250)

        sx = page.evaluate("() => window.__GS_STATE.vertScrollX || 0")
        after = lefts()
        assert sx > 0, "horizontal wheel did not scroll the vertical track columns"
        moved = sum(1 for a, b in zip(sorted(before), sorted(after)) if b < a - 50)
        assert moved >= 4, f"columns did not shift left with the scroll ({before} -> {after})"
        assert errors == [], errors


@pytest.mark.skip(reason="overscan pan disabled from the drag path pending real-data validation")
def test_overscan_flow_overlays_track_the_pan(gpu_browser):
    """#bug90: the flow SVG overlays (flowIndelOverlay for indels, flowOverlay for
    hover/selection) share the genome axis with the variant canvas, so during an
    overscan live-pan they must WIDEN + TRANSLATE in lockstep with flowWebGPU and
    keep their viewBox == displayed width. flowIndelOverlay used to stay
    viewport-width + untranslated with a widened viewBox -> a 2x-compressed static
    ghost of the variants (a 'separate set' that didn't move with the pan)."""
    with hg.open_viewer(gpu_browser, orientation="horizontal") as (page, errors):
        hg.set_span(page, 500)
        page.wait_for_timeout(400)
        box = page.evaluate(
            "() => { const m = document.getElementById('main'); const r = m.getBoundingClientRect(); return {x:r.x+r.width*0.5, y:r.y+r.height*0.82}; }")
        page.mouse.move(box["x"], box["y"])
        page.mouse.down()
        for i in range(1, 7):
            page.mouse.move(box["x"] + i * 22, box["y"])
        page.wait_for_timeout(40)

        m = page.evaluate(
            """() => {
                 const g = (id) => { const e = document.getElementById(id); if (!e) return null;
                   const r = e.getBoundingClientRect();
                   const vb = (e.getAttribute('viewBox') || '').split(/\\s+/);
                   return { w: Math.round(r.width), x: Math.round(r.x),
                            tx: e.style.transform || '', vbW: vb.length === 4 ? Math.round(+vb[2]) : null }; };
                 return { pad: window.__GS_STATE.renderPadPx || 0,
                          flow: g('flowWebGPU'), indel: g('flowIndelOverlay'), ov: g('flowOverlay') }; }""")
        page.mouse.up()

        assert m["pad"] > 0, "overscan did not engage"
        flow, indel, ov = m["flow"], m["indel"], m["ov"]
        # flowIndelOverlay must be widened + translated like the variant canvas
        assert abs(indel["w"] - flow["w"]) <= 4, f"flowIndelOverlay not widened with the flow: {m}"
        assert abs(indel["x"] - flow["x"]) <= 4, f"flowIndelOverlay not translated with the flow: {m}"
        # its viewBox width must match its displayed width (else the content scales)
        assert indel["vbW"] and abs(indel["vbW"] - indel["w"]) <= 4, f"flowIndelOverlay viewBox != width: {m}"
        assert ov["vbW"] and abs(ov["vbW"] - ov["w"]) <= 4, f"flowOverlay viewBox != width: {m}"
        assert errors == [], errors


def test_comment_pins_survive_pan_settle(gpu_browser):
    """#bug93: comment flags vanished after a horizontal pan (briefly visible
    while scrolling, gone on settle). The overscan settle cleared the inline
    style.width the overlay was sized with, collapsing #commentPinOverlay. Add a
    comment, pan and release, and assert the overlay is still full-width and the
    pin is present."""
    with hg.open_viewer(gpu_browser, orientation="horizontal") as (page, errors):
        hg.set_span(page, 500)
        page.wait_for_timeout(300)
        # place a comment at the center of the current view and render its pin
        page.evaluate(
            """() => { const S = window.__GS_STATE;
                 const pos = Math.round((S.startBp + S.endBp) / 2);
                 S.comments = [{ id: 'c1', author: 'a', body: 'hi',
                   anchor: { type: 'variant', locus: { contig: S.contig, pos } } }];
                 window.dispatchEvent(new Event('resize')); }""")
        page.wait_for_timeout(200)
        pins0 = page.evaluate("() => document.querySelectorAll('#commentPinOverlay .gs-comment-pin').length")
        assert pins0 >= 1, "comment pin did not render initially"

        box = page.evaluate(
            "() => { const m = document.getElementById('main'); const r = m.getBoundingClientRect(); return {x:r.x+r.width*0.5, y:r.y+r.height*0.82}; }")
        page.mouse.move(box["x"], box["y"]); page.mouse.down()
        for i in range(1, 5):
            page.mouse.move(box["x"] + i * 15, box["y"])
        page.mouse.up()
        page.wait_for_timeout(300)  # settle

        m = page.evaluate(
            """() => { const o = document.getElementById('commentPinOverlay');
                 const r = o.getBoundingClientRect();
                 return { w: Math.round(r.width),
                          pins: o.querySelectorAll('.gs-comment-pin').length,
                          styleW: o.style.width || '' }; }""")
        assert m["w"] > 400, f"commentPinOverlay collapsed after pan settle: {m}"
        assert m["pins"] >= 1, f"comment pins gone after pan settle: {m}"
        assert errors == [], errors


def test_smart_track_group_scroll_via_shift_wheel(gpu_browser):
    """Regression: opening several sample tracks that overflow the viewport must
    stay scrollable by wheel. The group wrapper (#smartScroll) owns the one
    scrollbar, but macOS overlay scrollbars auto-hide — and shift+wheel was
    hijacked to scroll the (scrollbar-hidden, non-overflowing) inner container
    and preventDefault'd, killing the native group scroll. So on a Mac the stack
    became unscrollable "in any way whatsoever". shift+wheel must now scroll
    #smartScroll between tracks."""
    with hg.open_viewer(gpu_browser) as (page, errors):
        page.evaluate(
            """async () => { const S = window.__GS_STATE;
                 for (let k = 0; k < 12; k++) {
                   const reads = {query_name:['r'+k], element_type:[0],
                     reference_start:[S.startBp+10], reference_end:[S.endBp-10],
                     is_forward:[true], haplotype:[1], sample_name:['S'+k], sequence:['']};
                   await window.__GS_TEST_seedSmartTrack('S'+k, reads, {collapsed:false});
                 } }""")
        page.wait_for_timeout(700)
        info = page.evaluate(
            """() => { const w = document.getElementById('smartScroll');
                 return w ? {sh: w.scrollHeight, ch: w.clientHeight} : null; }""")
        assert info, "no #smartScroll wrapper"
        assert info["sh"] > info["ch"], f"tracks don't overflow the wrapper ({info}) — seed more"

        # Aim into the sample-track region (below the pinned header). #smartScroll
        # starts at headerTop, so center-of-viewport can land in the header.
        box = page.evaluate(
            "() => { const w = document.getElementById('smartScroll');"
            "  const r = w.getBoundingClientRect();"
            "  return {x: r.x + r.width/2, y: r.y + Math.min(40, r.height/2)}; }")
        page.mouse.move(box["x"], box["y"])
        page.keyboard.down("Shift")
        for _ in range(4):
            page.mouse.wheel(0, 120)
            page.wait_for_timeout(60)
        page.keyboard.up("Shift")
        page.wait_for_timeout(200)

        top = page.evaluate("() => document.getElementById('smartScroll').scrollTop")
        assert top > 0, "shift+wheel did not scroll the sample-track group (#smartScroll)"
        assert errors == [], errors


def test_expanded_track_keeps_aggregate_overview_row(gpu_browser):
    """The sample overview (aggregate SNP/indel summary the collapsed view
    shows) must persist as the top row of an EXPANDED track once reads are
    displayed. Seeds an expanded deep pileup with SNPs; asserts the top strip
    paints the aggregate and the read rows are pushed below it."""
    with hg.open_viewer(gpu_browser) as (page, errors):
        hg.set_span(page, 400)
        hg.seed_reads(page, n=40, haplotype=1, rows_deep=True, snp=True)
        page.wait_for_timeout(500)
        box = hg.canvas_box(page)
        img, px = hg.region_pixels(page, box)
        W, Hh = img.size

        def row_nonblank(y):
            return sum(1 for x in range(W) if _non_blank(px[y * W + x]))

        # Overview strip lives in roughly the top ~28px (top=8, overviewH=rowH+4).
        overview_hits = max(row_nonblank(y) for y in range(10, 26))
        assert overview_hits > 5, "overview row painted nothing at the top of the expanded track"

        # Reads (hap1 = reddish) must start BELOW the overview strip (~y>=28),
        # i.e. no read body bleeds into the overview row.
        reddish_ys = [i // W for i, p in enumerate(px) if _reddish(p)]
        assert reddish_ys, "no reads painted"
        assert min(reddish_ys) >= 24, (
            f"reads not pushed below the overview row (topmost read pixel at "
            f"y={min(reddish_ys)}, expected >= 24)")
        assert errors == [], errors


def test_loaded_sample_reads_render_via_renderall(gpu_browser):
    """A loaded sample's reads must materialize from renderAll() alone — the
    real fetch_reads_response path ends in renderAll(), NOT a direct
    renderSmartTrack() (that extra call is only in the test seam). Guards the
    reported "loaded a sample and the reads did not materialize": clear the
    smart-track layers, re-render via renderAll() only, assert reads repaint."""
    with hg.open_viewer(gpu_browser) as (page, errors):
        res = hg.seed_reads(page, n=24, haplotype=1)
        tid = res["trackId"]
        page.wait_for_timeout(400)
        _i0, before = hg.region_pixels(page, hg.canvas_box(page))
        assert hg.frac_matching(before, _reddish) > 0.01, "reads never painted on load"

        # Wipe the track's GPU + 2D layers, then re-render ONLY through renderAll
        # (setSpan with the same span triggers renderAll without moving the view).
        page.evaluate(
            """(tid) => { const S = window.__GS_STATE;
                 const rec = S.smartTrackRenderers.get(tid);
                 if (rec && rec.instancedRenderer && rec.instancedRenderer.clear) rec.instancedRenderer.clear();
                 for (const id of ['smart-track-canvas-'+tid, 'smart-track-webgpu-'+tid]) {
                   const c = document.getElementById(id);
                   if (c) { try { const x = c.getContext('2d'); x && x.clearRect(0,0,c.width,c.height); } catch(e){} }
                 } }""", tid)
        span = page.evaluate("() => Math.round(window.__GS_STATE.endBp - window.__GS_STATE.startBp)")
        page.evaluate("(s) => window.__GS_TEST_setSpan(s)", span)  # -> renderAll()
        page.wait_for_timeout(500)

        _i1, after = hg.region_pixels(page, hg.canvas_box(page))
        assert hg.frac_matching(after, _reddish) > 0.01, \
            "reads did not materialize after renderAll() (load-path render regression)"
        assert errors == [], errors


def test_overview_row_pins_during_scroll(gpu_browser):
    """The sample overview row stays pinned at the track's top (in-line with the
    pinned sample name) as the read pileup scrolls under it — it must not scroll
    away with the reads."""
    with hg.open_viewer(gpu_browser) as (page, errors):
        hg.set_span(page, 400)
        res = hg.seed_reads(page, n=60, haplotype=1, rows_deep=True, snp=True)
        tid = res["trackId"]
        page.wait_for_timeout(500)
        box = hg.canvas_box(page)

        def strip_hits():
            img, px = hg.region_pixels(page, box)
            W, _H = img.size
            # Aggregate markers (opaque SNP tiles) in the top overview strip.
            return max(sum(1 for x in range(W) if _non_blank(px[y * W + x]))
                       for y in range(10, 24))

        before = strip_hits()
        assert before > 5, f"overview strip empty before scroll ({before})"
        # Scroll the pileup (per-track or group scroller).
        page.evaluate(
            """(tid) => { const c = document.getElementById('smart-track-container-'+tid);
                 const sc = document.getElementById('smartScroll');
                 const t = (sc && sc.scrollHeight > sc.clientHeight) ? sc : c;
                 t.scrollTop = 400; t.dispatchEvent(new Event('scroll')); }""", tid)
        page.wait_for_timeout(500)
        after = strip_hits()
        assert after > 5, f"overview strip vanished after scroll ({after}) — not pinned"
        assert errors == [], errors


def test_expanded_overview_sits_behind_sample_name(gpu_browser):
    """The aggregate overview must render at the very TOP of an expanded sample
    track, behind the sample name — not on a separate line below it. That means
    the reads canvas starts at the track top (no reserved header strip), so its
    top aligns with the track's control/name row (within a few px)."""
    with hg.open_viewer(gpu_browser) as (page, errors):
        res = hg.seed_reads(page, n=24, haplotype=1)
        tid = res["trackId"]
        page.wait_for_timeout(500)
        d = page.evaluate(
            """(tid) => {
                 const cont = document.getElementById('smart-track-container-'+tid);
                 const tcs = [...document.querySelectorAll('.track-control-container')]
                     .filter(c => !c.className.includes('standard-track'));
                 const sc = tcs[tcs.length - 1];
                 const nm = sc && sc.querySelector('.track-label, .smart-track-label-text');
                 return { cont: cont ? Math.round(cont.getBoundingClientRect().top) : null,
                          ctrl: sc ? Math.round(sc.getBoundingClientRect().top) : null,
                          name: nm ? Math.round(nm.getBoundingClientRect().top) : null }; }""",
            tid)
        assert d["cont"] is not None and d["ctrl"] is not None, d
        assert abs(d["cont"] - d["ctrl"]) <= 6, \
            f"reads canvas not at the track top (24px header not removed): {d}"
        assert errors == [], errors
