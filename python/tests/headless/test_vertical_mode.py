"""Vertical-mode layout guards (#49).

Renders the viewer in vertical orientation (headless Chromium, no GPU — this
asserts DOM/CSS layout, not WebGPU pixels) and checks the things #49 fixed:
track-name headers stay UPRIGHT (horizontal text), not rotated 90°. An earlier
inline `rotate(-90deg)` on the label beat the CSS and produced sideways,
clipped headers; this guards against that regressing.
"""
import os
import sys
import tempfile

import pytest

sys.path.insert(0, os.path.dirname(__file__))
pytest.importorskip("playwright")
pytest.importorskip("anywidget")

from playwright.sync_api import sync_playwright  # noqa: E402
import harness  # noqa: E402

VIEWPORT = {"width": 1200, "height": 900}


def _open(browser, orientation):
    page = browser.new_page(viewport=VIEWPORT)
    page.add_init_script(
        "try{localStorage.setItem('genomeshader.orientation',%r);"
        "localStorage.setItem('genomeshader.theme','light');}catch(e){}" % orientation)
    f = os.path.join(tempfile.mkdtemp(), "v.html")
    open(f, "w").write(harness.build_page())
    page.goto("file://" + f, wait_until="load")
    page.wait_for_function("() => window.__GS_READY === true", timeout=20000)
    page.wait_for_timeout(300)
    return page


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as pw:
        try:
            b = pw.chromium.launch(args=harness.CHROMIUM_ARGS)
        except Exception as e:
            pytest.skip(f"headless chromium unavailable: {e}")
        yield b
        b.close()


def _label_transforms(page):
    # computed `transform` of every track-name label; a 90° rotation shows up as
    # a matrix(...) with off-diagonal terms, upright text is 'none'.
    return page.evaluate(
        """() => Array.from(document.querySelectorAll('.main.vertical .track-label'))
             .map(el => ({ text: (el.textContent||'').trim().slice(0,20),
                           transform: getComputedStyle(el).transform }))""")


def test_vertical_track_labels_are_upright(browser):
    page = _open(browser, "vertical")
    labels = _label_transforms(page)
    assert labels, "no track labels found in vertical mode"
    for lab in labels:
        # upright => no rotation. Rotation -90° => matrix(a,b,c,d,..) with b/c = ±1.
        t = lab["transform"]
        assert t in ("none", "") or "matrix(1," in t, \
            f"track label {lab['text']!r} is rotated (not upright): {t}"
    page.close()


def test_vertical_render_has_no_errors(browser):
    page = _open(browser, "vertical")
    assert page.evaluate("() => window.__GS_ERR") is None
    page.close()


_RULER_CFG = {
    "region": "Pf3D7_01_v3:99000-101000",
    "chrom_lengths": {"Pf3D7_01_v3": 640851},
    "reference_data": "ACGTACGTAC" * 200,
    "viewport_variant_loading": False,
}


def _open_cfg_collapsed(browser, cfg):
    page = browser.new_page(viewport=VIEWPORT)
    page.add_init_script(
        "try{localStorage.setItem('genomeshader.orientation','vertical');"
        "localStorage.setItem('genomeshader.theme','light');}catch(e){}")
    f = os.path.join(tempfile.mkdtemp(), "v.html")
    open(f, "w").write(harness.build_page(config=cfg))
    page.goto("file://" + f, wait_until="load")
    page.wait_for_function("() => window.__GS_READY === true", timeout=20000)
    # Real notebook viewing state: left sidebar collapsed to the 8px rail.
    page.evaluate("() => document.querySelector('.app').classList.add('sidebar-collapsed')")
    page.evaluate("() => window.dispatchEvent(new Event('resize'))")
    page.wait_for_timeout(300)
    return page


def test_nav_bar_does_not_overlap_tracks_with_container_override(browser):
    # The widget's _container_override_css makes .app a flex row and forces the
    # panels to position:relative;top:auto — overriding the inline top:36px, so
    # the flex row (and its track-header chips) filled from y=0 UNDER the absolute
    # locus bar. The override now reserves the bar's height via padding-top. This
    # only reproduces WITH the override applied (plain harness looked fine).
    from genomeshader.widget import _container_override_css
    override = _container_override_css("genomeshader-root-gswidget")
    page = browser.new_page(viewport=VIEWPORT)
    page.add_init_script(
        "try{localStorage.setItem('genomeshader.orientation','vertical');"
        "localStorage.setItem('genomeshader.theme','light');}catch(e){}")
    html = harness.build_page(config=_RULER_CFG).replace(
        "</head>", f"<style>{override}</style></head>")
    f = os.path.join(tempfile.mkdtemp(), "v.html")
    open(f, "w").write(html)
    page.goto("file://" + f, wait_until="load")
    page.wait_for_function("() => window.__GS_READY === true", timeout=20000)
    page.wait_for_timeout(300)
    bar_bottom = page.eval_on_selector("#locusBar", "e => e.getBoundingClientRect().bottom")
    min_chip_y = page.evaluate(
        "() => { const es = [...document.querySelectorAll('#trackControls *')]"
        ".filter(e => e.textContent && e.getBoundingClientRect().height > 0);"
        " return es.length ? Math.min(...es.map(e => e.getBoundingClientRect().y)) : 9999; }")
    assert min_chip_y >= bar_bottom - 1, \
        f"track chips (y={min_chip_y}) overlap the locus bar (bottom={bar_bottom})"
    page.close()


def test_vertical_drag_down_moves_content_with_finger(browser):
    # #3: click-drag in vertical mode must move content WITH the finger (grab-drag,
    # like horizontal). Dragging DOWN on the bottom=start axis increases startBp.
    # Previously the dy sign was negated -> content scrolled backwards.
    page = _open_cfg_collapsed(browser, _RULER_CFG)
    before = page.evaluate("() => window.__GS_STATE.startBp")
    page.mouse.move(600, 300)
    page.mouse.down()
    page.mouse.move(600, 480, steps=8)
    page.mouse.up()
    page.wait_for_timeout(150)
    after = page.evaluate("() => window.__GS_STATE.startBp")
    assert after > before + 10, f"drag-down should advance startBp (grab-drag), {before}->{after}"
    page.close()


def test_vertical_comment_pin_sticks_left_of_reference(browser):
    # #2: in vertical the comment pin must stick out the LEFT of the reference
    # column (toward the ruler gutter), not the right into the data tracks. The
    # stem runs from the anchor (line x1) out to the circle (cx); left => cx < x1.
    page = _open_cfg_collapsed(browser, _RULER_CFG)
    rendered = page.evaluate(
        """() => {
            const contig = window.__GS_STATE.contig;
            window.__GS_STATE.comments = [{ id: 'c1', author: 'a', body: 'hi',
              anchor: { type: 'reference', locus: { contig: contig, pos: 100500 } } }];
            if (typeof renderAll === 'function') renderAll();
            const g = document.querySelector('#commentPinOverlay .gs-comment-pin');
            if (!g) return null;
            const line = g.querySelector('line'), circ = g.querySelector('circle');
            if (!line || !circ) return null;
            return { x1: +line.getAttribute('x1'), cx: +circ.getAttribute('cx') };
        }""")
    if not rendered:
        pytest.skip("comment pin overlay not rendered in this harness config")
    assert rendered["cx"] < rendered["x1"], \
        f"comment pin sticks the wrong way (cx={rendered['cx']} should be left of anchor x1={rendered['x1']})"
    page.close()


def test_vertical_variant_hover_tooltip_outside_flow_band(browser):
    # The variant hover box must NOT cover the variant. In vertical mode the flow
    # band is a narrow packed column, so the on-canvas label is suppressed and the
    # hover shows as a DOM tooltip placed to the RIGHT of the flow band.
    page = _open_cfg_collapsed(browser, _RULER_CFG)
    page.evaluate(
        """() => {
            const flow = document.getElementById('flow');
            const fr = flow.getBoundingClientRect();
            window.__GS_STATE.hoveredAlleleNodeTooltip =
                { text: 'A>G ref/alt', x: fr.left + 70, y: fr.top + fr.height/2 };
            window.dispatchEvent(new Event('resize'));  // triggers a render -> updateTooltip
        }""")
    page.wait_for_timeout(150)
    r = page.evaluate(
        """() => {
            const tt = document.querySelector('.tooltip');
            if (!tt || !tt.classList.contains('visible')) return { visible: false };
            const tr = tt.getBoundingClientRect();
            const fr = document.getElementById('flow').getBoundingClientRect();
            return { visible: true, ttLeft: tr.left, flowRight: fr.right };
        }""")
    assert r.get("visible"), "vertical variant hover tooltip not shown"
    assert r["ttLeft"] >= r["flowRight"] - 1, \
        f"hover tooltip overlaps the flow band (ttLeft={r['ttLeft']} < flowRight={r['flowRight']})"
    page.close()


def test_vertical_wheel_zooms_not_pans(browser):
    # new-#1: a plain mouse wheel must ZOOM in vertical (was mapped to pan). Zoom
    # shrinks the span around the cursor; a pan would keep the span and shift the
    # start. Assert the span changed materially.
    page = _open_cfg_collapsed(browser, _RULER_CFG)
    before = page.evaluate("() => window.__GS_STATE.endBp - window.__GS_STATE.startBp")
    page.mouse.move(700, 400)
    page.mouse.wheel(0, -240)   # wheel up = zoom in
    page.wait_for_timeout(120)
    after = page.evaluate("() => window.__GS_STATE.endBp - window.__GS_STATE.startBp")
    assert after < before * 0.95, f"vertical wheel should zoom (span {before}->{after})"
    page.close()


def test_vertical_collapsed_sample_menus_dont_overlap(browser):
    # Multiple loaded sample tracks each get a control menu; in vertical mode the
    # collapsed menus must stay inside their own narrow column (stacked/bounded),
    # not overflow into the neighbouring track.
    page = _open_cfg_collapsed(browser, _RULER_CFG)
    ok = page.evaluate(
        """async () => {
            if (typeof window.__GS_TEST_seedSmartTrack !== 'function') return null;
            const reads = [{ start: 100450, end: 100550, strand: '+', name: 'r' }];
            for (const s of ['FP0009-C', 'FP0019-CW', 'FP0024-C']) {
                await window.__GS_TEST_seedSmartTrack(s, reads, { collapsed: true });
            }
            window.dispatchEvent(new Event('resize'));
            return true;
        }""")
    if not ok:
        pytest.skip("smart-track seed seam unavailable")
    page.wait_for_timeout(400)
    rects = page.evaluate(
        "() => Array.from(document.querySelectorAll("
        "'.track-control-container[data-track-id^=\"smart-track-\"]'))"
        ".map(c => { const r = c.getBoundingClientRect();"
        " return { x: r.x, right: r.right }; })")
    assert len(rects) >= 2, f"expected multiple sample menus, got {rects}"
    rects.sort(key=lambda o: o["x"])
    for i in range(len(rects) - 1):
        assert rects[i]["right"] <= rects[i + 1]["x"] + 1, \
            f"sample menu {i} overflows into the next column: {rects}"
    # ...and the collapsed menu is ROTATED (stacked down the column), not the
    # horizontal bar that gets truncated in a narrow column.
    flexdir = page.evaluate(
        "() => { const c = document.querySelector("
        "'.track-control-container.track-collapsed .track-controls[data-track-id^=\"smart-track-\"]');"
        " return c ? getComputedStyle(c).flexDirection : null; }")
    assert flexdir == "column", f"collapsed sample menu not rotated/stacked (flex-direction={flexdir})"
    page.close()


def test_vertical_wheel_over_reads_passthrough_zooms(browser):
    # In vertical mode #smartScroll is a full-size transparent passthrough. Its
    # wheel listener used to stopPropagation unconditionally, killing zoom over
    # that whole area (even with no sample tracks loaded). A plain wheel targeting
    # it must now bubble to the zoom handler.
    page = _open_cfg_collapsed(browser, _RULER_CFG)
    before = page.evaluate("() => window.__GS_STATE.endBp - window.__GS_STATE.startBp")
    zoomed = page.evaluate(
        """() => {
            const w = document.getElementById('smartScroll');
            if (!w) return null;
            const r = w.getBoundingClientRect();
            w.dispatchEvent(new WheelEvent('wheel', { deltaY: -240, bubbles: true,
                cancelable: true, clientX: r.x + r.width/2, clientY: r.y + r.height/2 }));
            return true;
        }""")
    if not zoomed:
        pytest.skip("no #smartScroll wrapper")
    page.wait_for_timeout(120)
    after = page.evaluate("() => window.__GS_STATE.endBp - window.__GS_STATE.startBp")
    assert after < before * 0.98, f"wheel over reads passthrough should zoom ({before}->{after})"
    page.close()


def test_vertical_samples_track_scrolls_on_wheel(browser):
    # new-#3: a mouse wheel over the samples (smart) track must scroll its pileup.
    # The handler keyed off deltaX in vertical (0 for a mouse wheel) -> dead.
    page = _open_cfg_collapsed(browser, _RULER_CFG)
    # Seed a deep pileup so the virtualized container overflows (scrollable).
    seeded = page.evaluate(
        """async () => {
            if (typeof window.__GS_TEST_seedSmartTrack !== 'function') return null;
            const reads = [];
            for (let i = 0; i < 400; i++) reads.push(
              { start: 100450 + (i % 20), end: 100550 + (i % 20), strand: '+', name: 'r' + i });
            const r = await window.__GS_TEST_seedSmartTrack('S1', reads, {});
            const rec = window.__GS_STATE.smartTrackRenderers.get(r.trackId);
            const c = rec && rec.container;
            return c ? { scrollable: c.classList.contains('scrollable'),
                         over: c.scrollHeight - c.clientHeight, top0: c.scrollTop,
                         cx: c.getBoundingClientRect().x + c.getBoundingClientRect().width/2,
                         cy: c.getBoundingClientRect().y + c.getBoundingClientRect().height/2 } : null;
        }""")
    if not seeded or not seeded.get("scrollable") or seeded.get("over", 0) <= 0:
        pytest.skip(f"smart-track container not scrollable headless (needs depth/GPU): {seeded}")
    page.mouse.move(seeded["cx"], seeded["cy"])
    page.keyboard.down("Shift")   # shift+wheel scrolls the pileup; plain wheel zooms
    page.mouse.wheel(0, 200)
    page.keyboard.up("Shift")
    page.wait_for_timeout(120)
    top = page.evaluate(
        """() => { for (const [,rec] of window.__GS_STATE.smartTrackRenderers) {
             if (rec && rec.container) return rec.container.scrollTop; } return -1; }""")
    assert top > 0, f"wheel over samples track did not scroll it (scrollTop={top})"
    page.close()


def test_vertical_indel_overlay_uses_screen_dims(browser):
    # #4: the indel-lollipop overlay is a screen-space SVG; its width/viewBox must
    # be the true screen width, not the genomic-axis W (swapped in vertical), or
    # lollipops rescale rightward into the read tracks.
    page = _open_cfg_collapsed(browser, _RULER_CFG)
    d = page.evaluate(
        "() => { const o = document.getElementById('flowIndelOverlay');"
        " const r = o.getBoundingClientRect();"
        " return { attrW: +o.getAttribute('width'), cssW: Math.round(r.width) }; }")
    assert abs(d["attrW"] - d["cssW"]) <= 2, f"overlay viewBox width != screen width: {d}"
    page.close()


def test_vertical_axis_labels_sit_in_ruler_gutter(browser):
    # #82: coordinate tick labels must live in the reserved left ruler gutter —
    # not garble over the neighbouring track column, and not clip the leading
    # digit off the left edge ("101.00 kb" -> "01.00 kb").
    page = _open_cfg_collapsed(browser, _RULER_CFG)
    labels = page.evaluate(
        "() => Array.from(document.querySelectorAll('#tracksSvg text.svg-small'))"
        ".map(t => { const b = t.getBBox(); return { t: (t.textContent||'').trim(),"
        " x1: b.x, x2: b.x + b.width }; })")
    assert len(labels) >= 3, f"expected coordinate labels, got {labels}"
    for lab in labels:
        assert lab["x1"] >= 2, f"label {lab['t']!r} clipped off the left edge: {lab}"
        assert lab["x2"] <= 84, f"label {lab['t']!r} spills out of the gutter onto a track: {lab}"
    page.close()
