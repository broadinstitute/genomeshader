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
