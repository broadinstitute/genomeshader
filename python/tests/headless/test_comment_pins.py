"""Comment pin (flag) visibility guards.

The comment flags ride the reference track. Two regressions are guarded here:
 - the flag must actually be VISIBLE (painted blue pixels), not just present in
   the DOM (they once collapsed/hid via layer geometry);
 - collapsing the reference track must HIDE the flags, and expanding restores
   them (the overlay is cleared up front so a collapsed owner leaves no stale
   marks).

SVG pins render under software GL, so this runs on the plain headless harness
(no GPU needed).
"""
import os
import sys
import tempfile

import pytest

sys.path.insert(0, os.path.dirname(__file__))
pytest.importorskip("playwright")
pytest.importorskip("anywidget")
pytest.importorskip("PIL")

from playwright.sync_api import sync_playwright  # noqa: E402
import harness  # noqa: E402

VIEWPORT = {"width": 1200, "height": 900}


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as pw:
        try:
            b = pw.chromium.launch(args=harness.CHROMIUM_ARGS)
        except Exception as e:
            pytest.skip(f"headless chromium unavailable: {e}")
        yield b
        b.close()


def _open(browser):
    page = browser.new_page(viewport=VIEWPORT)
    page.add_init_script("try{localStorage.setItem('genomeshader.theme','light');}catch(e){}")
    f = os.path.join(tempfile.mkdtemp(), "h.html")
    open(f, "w").write(harness.build_page())
    page.goto("file://" + f, wait_until="load")
    page.wait_for_function("() => window.__GS_READY === true", timeout=20000)
    page.wait_for_timeout(200)
    return page


def _add_comment_and_render(page):
    page.evaluate(
        """() => { const S = window.__GS_STATE;
             const pos = Math.round((S.startBp + S.endBp) / 2);
             S.comments = [{ id: 'c1', author: 'a', body: 'hi',
               anchor: { type: 'variant', locus: { contig: S.contig, pos } } }];
             window.dispatchEvent(new Event('resize')); }""")
    page.wait_for_timeout(200)


def _collapse_reference(page, collapsed):
    page.evaluate(
        """(c) => { const t = window.__GS_STATE.tracks.find(t => t.id === 'reference');
             if (t) t.collapsed = c;
             if (typeof updateTracksHeight === 'function') updateTracksHeight();
             window.dispatchEvent(new Event('resize')); }""", collapsed)
    page.wait_for_timeout(200)


def _pin_count(page):
    return page.evaluate("() => document.querySelectorAll('#commentPinOverlay .gs-comment-pin').length")


def _pin_marker_blue_pixels(page):
    """Count blue-ish pixels (var(--blue) ~ #2b6fff) INSIDE the pin marker's own
    bounding box — proves the flag is actually painted there, not just in the DOM
    (and not counting other blue UI elsewhere in the tracks region)."""
    from PIL import Image
    import io
    bb = page.evaluate(
        """() => { const m = document.querySelector('#commentPinOverlay .gs-comment-pin circle, #commentPinOverlay .gs-comment-pin rect[rx]');
             if (!m) return null; const r = m.getBoundingClientRect();
             return {x:r.x - 3, y:r.y - 3, width:r.width + 6, height:r.height + 6}; }""")
    if not bb or bb["width"] <= 0 or bb["height"] <= 0:
        return 0
    png = page.screenshot(clip=bb)
    img = Image.open(io.BytesIO(png)).convert("RGB")
    raw = img.tobytes()
    n = 0
    for i in range(0, len(raw), 3):
        r, g, b = raw[i], raw[i + 1], raw[i + 2]
        if b > 150 and b - r > 40 and b - g > 30:  # blue marker
            n += 1
    return n


def test_comment_flag_visible_and_hides_on_reference_collapse(browser):
    page = _open(browser)
    _add_comment_and_render(page)
    assert _pin_count(page) == 1, "comment pin not in the overlay when reference is expanded"
    assert _pin_marker_blue_pixels(page) > 3, "comment flag marker is not actually painted (no blue pixels)"

    _collapse_reference(page, True)
    # DOM removal is the authoritative "hidden" signal (the overlay is cleared up
    # front when the reference track collapses).
    assert _pin_count(page) == 0, "comment flags did not hide when the reference track collapsed"

    _collapse_reference(page, False)
    assert _pin_count(page) == 1, "comment flags did not return when the reference track expanded"
    assert _pin_marker_blue_pixels(page) > 3, "comment flag not repainted after re-expanding"
    page.close()
