"""Render-overscan geometry invariants (#41).

At rest renderPadBp/renderPadPx are 0, so the render-window helpers must be a
pure no-op: xGenome/yGenome map exactly as before. When pad>0 (widened window
during a live pan) the WHOLE layer shifts by exactly renderPadPx in the genomic
direction — that is the invariant the pan translate compensates for. These
guard that the ui-state abstraction stays a safe no-op off and shifts cleanly
on, in both orientations.
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


# fn = 'x' or 'y'; returns [x(mid) at pad0, x(mid) at pad>0, renderPadPx]
_PROBE = """
() => {
  const st = window.__GS_STATE;
  const map = window.__GS_%s;
  if (!st || typeof map !== 'function') return null;
  const bp = Math.round((st.startBp + st.endBp) / 2);
  st.renderPadBp = 0; st.renderPadPx = 0;
  const at0 = map(bp);
  const span = st.endBp - st.startBp;
  const padBp = Math.max(1, Math.round(span * 0.25));
  st.renderPadBp = padBp;
  st.renderPadPx = padBp * (st.pxPerBp || 1);
  const atPad = map(bp);
  const padPx = st.renderPadPx;
  st.renderPadBp = 0; st.renderPadPx = 0;  // restore
  return [at0, atPad, padPx];
}
"""


@pytest.mark.parametrize("orientation,fn", [("horizontal", "xGenome"),
                                            ("vertical", "yGenome")])
def test_overscan_shifts_layer_by_pad(browser, orientation, fn):
    page = _open(browser, orientation)
    res = page.evaluate(_PROBE % fn)
    page.close()
    assert res is not None, f"{fn} not exposed"
    at0, atPad, padPx = res
    assert padPx > 0
    # x grows with bp; the genomic axis inverts for y (bottom=start), so a wider
    # window inset from the start moves y the other way. Magnitude is what the
    # pan translate cancels: |shift| == padPx.
    assert abs(abs(atPad - at0) - padPx) < 1.0, (at0, atPad, padPx)


# max genomic-axis coordinate over the tracks SVG (x for horizontal, y for
# vertical). With overscan on, the ruler/reference draw past the viewport edge.
_MAXCOORD = """
(vertical) => {
  const st = window.__GS_STATE;
  st.renderPadBp = 0; st.renderPadPx = 0;
  window.dispatchEvent(new Event('resize'));
  const measure = () => {
    const svg = document.getElementById('tracksSvg');
    let m = -1e9;
    svg.querySelectorAll('line,text,rect').forEach(el => {
      for (const a of vertical ? ['y1','y2','y'] : ['x1','x2','x']) {
        const v = parseFloat(el.getAttribute(a));
        if (!isNaN(v)) m = Math.max(m, v);
      }
    });
    return m;
  };
  const at0 = measure();
  const span = st.endBp - st.startBp;
  const padBp = Math.max(1, Math.round(span * 0.5));
  st.renderPadBp = padBp;
  st.renderPadPx = padBp * (st.pxPerBp || 1);
  window.dispatchEvent(new Event('resize'));
  const atPad = measure();
  st.renderPadBp = 0; st.renderPadPx = 0;
  window.dispatchEvent(new Event('resize'));
  return [at0, atPad, st.renderPadPx || (padBp * (st.pxPerBp || 1))];
}
"""


@pytest.mark.parametrize("orientation", ["horizontal", "vertical"])
def test_overscan_paints_tracks_into_margin(browser, orientation):
    page = _open(browser, orientation)
    is_vert = orientation == "vertical"
    res = page.evaluate(_MAXCOORD, is_vert)
    page.close()
    at0, atPad, padPx = res
    # padded render reaches into the overscan margin (grows by ~padPx), so the
    # newly-revealed edge is pre-painted, not blank.
    assert atPad > at0 + 0.5 * padPx, (at0, atPad, padPx)
