"""Headless UI regression tests (Playwright + headless Chromium).

Each test guards a real regression fixed in the viewer:

- renders in both orientations without console errors
- renders in a sandboxed / opaque origin (the localStorage-guard fix)
- ruler variant marks stay aligned with flow variant nodes
- vertical mode spreads variants across the full genome axis
- fullscreen enter/exit/enter keeps the tracks
- double-clicking an allele coalesces to a single render (not the 6-render storm)

Setup (also in README):
    pip install playwright anywidget
    python -m playwright install chromium
    pytest python/tests/headless

The whole module skips cleanly if Playwright or the browser isn't installed, so
the normal `pytest -q` run is unaffected.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(__file__))
pytest.importorskip("playwright")
pytest.importorskip("anywidget")

from playwright.sync_api import sync_playwright  # noqa: E402
import harness  # noqa: E402

VIEWPORT = {"width": 1200, "height": 900}

# --- helpers ---------------------------------------------------------------

_SVG_COUNT = (
    "() => { const r=document.querySelector('[id^=\"genomeshader-root-\"]');"
    " const s=r&&r.querySelector('#tracksSvg'); return s?s.childElementCount:-1; }"
)


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as pw:
        try:
            b = pw.chromium.launch(args=harness.CHROMIUM_ARGS)
        except Exception as e:  # browser binary not installed in this env
            pytest.skip(f"headless chromium unavailable: {e}")
        yield b
        b.close()


def _open(browser, tmp_path, orientation="horizontal", config=None, instrument=False):
    """New page with orientation/theme pinned, viewer loaded, errors captured."""
    page = browser.new_page(viewport=VIEWPORT)
    errors = []
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    page.on("console", lambda m: errors.append(f"console.error: {m.text}")
            if m.type == "error" else None)
    page.add_init_script(
        "try{localStorage.setItem('genomeshader.orientation',%r);"
        "localStorage.setItem('genomeshader.theme','light');}catch(e){}" % orientation
    )
    uri = harness.write_page(tmp_path, harness.build_page(config=config, instrument=instrument))
    page.goto(uri, wait_until="load")
    return page, errors


def _wait_ready(page):
    page.wait_for_function("() => window.__GS_READY === true", timeout=20000)
    page.wait_for_timeout(300)


def _wait_nodes(page):
    page.wait_for_function(
        "() => window._alleleNodePositions && window._alleleNodePositions.length > 0",
        timeout=20000,
    )


# --- tests -----------------------------------------------------------------

@pytest.mark.parametrize("orientation", ["horizontal", "vertical"])
def test_viewer_renders(browser, tmp_path, orientation):
    page, errors = _open(browser, tmp_path, orientation)
    _wait_ready(page)
    assert page.evaluate("() => window.__GS_ERR") is None
    assert page.evaluate(_SVG_COUNT) > 0
    assert errors == [], errors
    page.close()


def test_renders_in_sandboxed_origin(browser):
    """The real ESM, imported as a strict module from an opaque blob origin
    (localStorage throws) — reproduces VS Code / Colab / Terra sandboxed output.
    Guards the gsLocalStorage shim; without it the whole viewer aborts blank."""
    page = browser.new_page(viewport=VIEWPORT)
    page.set_content("<!doctype html><html><body><div id='mount'></div></body></html>",
                     wait_until="load")
    svg_children = page.evaluate(
        """async (esmText) => {
            const url = URL.createObjectURL(new Blob([esmText], {type:'text/javascript'}));
            const mod = await import(url);
            const model = { get:(k)=>({config:{}, view_id:'gswidget'}[k]),
                            set(){}, save_changes(){}, on(){}, off(){}, send(){} };
            mod.default.render({ model, el: document.getElementById('mount') });
            await new Promise(r => setTimeout(r, 2500));
            const svg = document.querySelector('#mount [id^="genomeshader-root-"] #tracksSvg');
            return svg ? svg.childElementCount : -1;
        }""",
        harness.esm_module_source(),
    )
    assert svg_children > 0, "viewer rendered blank in a sandboxed origin"
    page.close()


def test_ruler_flow_alignment(browser, tmp_path):
    """Ruler variant marks must sit at the same x as their flow nodes."""
    page, _ = _open(browser, tmp_path, "horizontal")
    _wait_nodes(page)
    diffs = page.evaluate(
        """() => {
            const root = document.querySelector('[id^="genomeshader-root-"]');
            const ruler = {};
            root.querySelectorAll('#tracksSvg line[data-variant-id]').forEach(l => {
                const x1 = +l.getAttribute('x1'), x2 = +l.getAttribute('x2');
                if (Math.abs(x1 - x2) < 0.5) ruler[l.getAttribute('data-variant-id')] = x1;
            });
            const flow = {};
            (window._alleleNodePositions || []).forEach(n => {
                if (flow[n.variantId] == null) flow[n.variantId] = n.x + n.w / 2;
            });
            return Object.keys(ruler).filter(id => flow[id] != null)
                .map(id => Math.abs(ruler[id] - flow[id]));
        }"""
    )
    assert diffs, "no comparable ruler/flow variants found"
    assert all(d < 1.5 for d in diffs), f"ruler/flow misaligned: {diffs}"
    page.close()


def test_vertical_spreads_variants(browser, tmp_path):
    """Vertical mode maps variants across the full height (genome axis), not
    crammed into the band thickness."""
    page, _ = _open(browser, tmp_path, "vertical")
    _wait_nodes(page)
    ys = page.evaluate("() => (window._alleleNodePositions || []).map(n => n.y)")
    assert ys and (max(ys) - min(ys)) > 300, f"variants not spread on the genome axis: {ys}"
    page.close()


def test_fullscreen_cycle_keeps_tracks(browser, tmp_path):
    """Enter/exit/enter fullscreen must not lose the tracks."""
    page, _ = _open(browser, tmp_path, "horizontal")
    _wait_ready(page)

    def svg_n():
        return page.evaluate(_SVG_COUNT)

    def toggle_fs():
        page.evaluate("() => { const e=document.getElementById('fullscreenItem'); if(e) e.click(); }")
        page.wait_for_timeout(400)

    assert svg_n() > 0
    for _ in range(2):
        toggle_fs()            # enter
        assert svg_n() > 0, "tracks vanished entering fullscreen"
        toggle_fs()            # exit
        assert svg_n() > 0, "tracks vanished exiting fullscreen"
    page.close()


def test_double_click_coalesces_renders(browser, tmp_path):
    """Double-clicking an allele opens both panels + switches tab. That must
    coalesce to a single render, not the 6-renderAll storm that froze the UI."""
    page, _ = _open(browser, tmp_path, "horizontal", instrument=True)
    _wait_nodes(page)
    pos = page.evaluate(
        """() => { const n = window._alleleNodePositions[0];
                   const c = document.getElementById('flowCanvas').getBoundingClientRect();
                   return { x: c.x + n.x + n.w/2, y: c.y + n.y + n.h/2 }; }"""
    )
    page.evaluate("() => { window.__rc = 0; }")
    page.mouse.dblclick(pos["x"], pos["y"])
    page.wait_for_timeout(1500)
    rc = page.evaluate("() => window.__rc")
    assert rc <= 2, f"double-click triggered {rc} renderAll (regression to the render storm)"
    page.close()

def test_right_click_does_not_stick_pan(browser, tmp_path):
    """Right-click then a button-less move must not scroll the view (the pan
    must not get stuck 'on')."""
    page, _ = _open(browser, tmp_path, "horizontal")
    _wait_ready(page)
    start = page.evaluate("() => window.__GS_STATE.startBp")
    page.mouse.move(600, 400)
    page.mouse.down(button="right")
    page.mouse.up(button="right")
    page.mouse.move(400, 400)      # move with no button held
    page.mouse.move(250, 400)
    page.wait_for_timeout(200)
    end = page.evaluate("() => window.__GS_STATE.startBp")
    assert end == start, f"view scrolled after a right-click ({start} -> {end})"
    page.close()


def test_allele_reorder_indicator_matches_landing(browser, tmp_path):
    """The blue drop bar must sit exactly where the dragged allele lands. This
    guards the reorder desync bug: the move handler's drop-index, the indicator
    bar position, and the mouseup reorder all go through the shared
    allele-reorder helpers, so a sweep over pointer positions and drag sources
    proves indicator-position == landing-position. Pure geometry (the real
    exposed functions), so it runs without the WebGPU layer painting."""
    page, _ = _open(browser, tmp_path, "horizontal")
    _wait_ready(page)
    mismatches = page.evaluate(
        """() => {
          const nid = window.__gsAlleleNearestDropIndex;
          const ins = window.__gsAlleleDropInsertAt;
          const pos = window.__gsAlleleDropIndicatorPos;
          if (!nid || !ins || !pos) return ['helpers not exposed'];
          const sizes = [10, 30, 8, 20, 14], gap = 8, start = 100;
          const layout = (sz) => { const p=[]; let c=start; for(const s of sz){p.push(c); c+=s+gap;} return p; };
          const mids = (sz) => layout(sz).map((x,i)=>x+sz[i]/2);
          const bad = [];
          for (let from=0; from<sizes.length; from++) {
            for (let x=start-20; x<start+220; x++) {
              // real move-handler rule via the exposed nearest-drop-index
              const m = mids(sizes);
              // emulate the handler's start/sizes: same array, same centering
              const dropIndex = nid(x, start, sizes, gap);
              const insertAt = ins(dropIndex, from);
              if (insertAt === from) continue;               // no-op, bar hidden
              const indicator = pos(start, sizes, gap, from, insertAt);
              // landing: remove dragged, insert at insertAt, relayout
              const order = sizes.map((_,i)=>i), sz = sizes.slice();
              const d = order.splice(from,1)[0], ds = sz.splice(from,1)[0];
              order.splice(insertAt,0,d); sz.splice(insertAt,0,ds);
              const landed = layout(sz)[insertAt];
              if (Math.abs(landed - indicator) > 0.001)
                bad.push(`from=${from} x=${x} drop=${dropIndex} insertAt=${insertAt} bar=${indicator} landed=${landed}`);
            }
          }
          return bad;
        }"""
    )
    assert mismatches == [], mismatches[:5]
    page.close()


# NOTE: allele *selection* is driven by the WebGPU interaction layer, which does
# not paint (or receive clicks) under swiftshader in headless Chromium, so
# selection behavior (e.g. double-click-keeps-selection) can't be asserted here.
# Those fixes are verified by inspection + in a real browser.
