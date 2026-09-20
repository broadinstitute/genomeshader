"""Always-visible top locus bar (IGV-style): contig + position + Go + ideogram.

Drives the real viewer (headless Chromium) and asserts the jump behavior:
- the bar exists and is populated from chrom_lengths,
- the chromosome ideogram lives in the bar (not as a track),
- a start-end range jumps the view there,
- a single position expands +/-100 bp on each side,
- switching contig via the bar works.

Navigation issues a `navigate` comm which the harness rejects (no kernel), but
gsGoToLocus sets state synchronously BEFORE that, so state assertions hold.
"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(__file__))
import pytest

pytest.importorskip("playwright")
from playwright.sync_api import sync_playwright  # noqa: E402
import harness  # noqa: E402

CFG = {
    "region": "chr1:1000-2000",
    "chrom_lengths": {"chr1": 1_000_000, "chr2": 500_000},
    "viewport_variant_loading": False,
}


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as pw:
        try:
            b = pw.chromium.launch(args=harness.CHROMIUM_ARGS)
        except Exception as e:
            pytest.skip(f"headless chromium unavailable: {e}")
        yield b
        b.close()


def _open(browser, cfg=CFG):
    page = browser.new_page(viewport={"width": 1200, "height": 900})
    page.add_init_script(
        "try{localStorage.removeItem('genomeshader.lockView');"
        "localStorage.removeItem('genomeshader.panZoom');}catch(e){}"
    )
    html = harness.build_page(config=cfg)
    f = os.path.join(tempfile.mkdtemp(), "lb.html")
    open(f, "w").write(html)
    page.goto("file://" + f, wait_until="load")
    page.wait_for_function("() => window.__GS_READY === true", timeout=20000)
    page.wait_for_function(
        "() => !!(window.__GS_STATE && window.__GS_STATE.__ideogramHitRect "
        "&& window.__GS_STATE.__ideogramHitRect.w > 0)",
        timeout=10000)
    return page


def _state(page):
    return page.evaluate(
        "() => ({c: __GS_STATE.contig, s: Math.round(__GS_STATE.startBp), "
        "e: Math.round(__GS_STATE.endBp)})")


def test_bar_present_and_populated(browser):
    page = _open(browser)
    assert page.eval_on_selector("#locusBar", "el => !!el")
    opts = page.evaluate(
        "() => Array.from(document.getElementById('locusContigSelect').options).map(o => o.value)")
    assert "chr1" in opts and "chr2" in opts
    page.close()


def test_ideogram_lives_in_locus_bar_not_as_track(browser):
    page = _open(browser)
    layout = page.evaluate("""() => {
      const bar = document.getElementById('locusBar');
      const ids = [...bar.children].map(e => e.id);
      const go = document.getElementById('locusGoBtn').getBoundingClientRect();
      const ideo = document.getElementById('locusIdeogram').getBoundingClientRect();
      const readout = document.getElementById('locusReadout').getBoundingClientRect();
      const lock = document.getElementById('locusLockBtn').getBoundingClientRect();
      const fs = document.getElementById('locusFullscreenBtn').getBoundingClientRect();
      const pos = getComputedStyle(document.getElementById('locusPosInput'));
      return {
        ids,
        hasIdeogramTrack: (window.__GS_STATE.tracks || []).some(t => t.id === 'ideogram'),
        hasIdeogramControls: !!document.querySelector('#trackControls [data-track-id="ideogram"]'),
        nRects: document.querySelectorAll('#locusIdeogram rect').length,
        goRight: go.right, ideoLeft: ideo.left, ideoRight: ideo.right,
            readoutLeft: readout.left, readoutRight: readout.right,
            readoutW: readout.width,
            lockLeft: lock.left, lockRight: lock.right, lockW: lock.width,
        fsLeft: fs.left, fsW: fs.width, fsCx: fs.left + fs.width / 2,
        iconCx: (() => {
          const ic = document.querySelector('.sidebar-right-command-strip .command-strip-icon');
          if (!ic) return null;
          const r = ic.getBoundingClientRect();
          return r.left + r.width / 2;
        })(),
        posMaxWidth: pos.maxWidth,
      };
    }""")
    assert layout["ids"].index("locusGoBtn") < layout["ids"].index("locusIdeogram")
    assert layout["ids"].index("locusIdeogram") < layout["ids"].index("locusReadout")
    assert layout["ids"].index("locusReadout") < layout["ids"].index("locusLockBtn")
    assert layout["ids"].index("locusLockBtn") < layout["ids"].index("locusFullscreenBtn")
    assert layout["hasIdeogramTrack"] is False
    assert layout["hasIdeogramControls"] is False
    assert layout["nRects"] >= 2, layout
    assert layout["goRight"] <= layout["ideoLeft"] + 1, layout
    assert layout["ideoRight"] <= layout["readoutLeft"] + 1, layout
    assert layout["readoutRight"] <= layout["lockLeft"] + 1, layout
    assert layout["lockRight"] <= layout["fsLeft"] + 1, layout
    assert layout["iconCx"] is not None
    assert abs(layout["fsCx"] - layout["iconCx"]) < 2, layout
    assert layout["posMaxWidth"] == "180px", layout
    # 18ch tabular readout: fits chr22:123,456,789 without ellipsis.
    assert 120 < layout["readoutW"] < 150, layout
    assert layout["lockW"] == 32, layout
    assert layout["fsW"] == 32, layout      # equal slot with Connect/Lock (icon pitch); right inset is a margin
    nine = page.evaluate("""() => {
      const el = document.getElementById('locusReadout');
      el.textContent = 'chr22:123,456,789';
      return el.scrollWidth <= el.clientWidth + 1;
    }""")
    assert nine is True, "9-digit position should not truncate"
    # Fixed readout width: changing the coordinate string must not resize the ideogram.
    before = page.evaluate("() => document.getElementById('locusIdeogram').getBoundingClientRect().width")
    page.evaluate("""() => {
      const t = document.getElementById('tracksContainer').getBoundingClientRect();
      const ev = new PointerEvent('pointermove', {
        bubbles: true, clientX: t.x + t.width * 0.9, clientY: t.y + 20,
        pointerId: 1, pointerType: 'mouse',
      });
      document.getElementById('main').dispatchEvent(ev);
    }""")
    page.wait_for_timeout(50)
    after = page.evaluate("() => document.getElementById('locusIdeogram').getBoundingClientRect().width")
    assert abs(after - before) < 0.5, (before, after)
    page.close()


def _go_disabled(page):
    return page.eval_on_selector("#locusGoBtn", "el => el.disabled")


def test_go_disabled_until_edit(browser):
    page = _open(browser)
    assert _go_disabled(page) is True                 # nothing changed yet
    page.fill("#locusPosInput", "1,000-2,000")         # typing stages -> enables Go
    assert _go_disabled(page) is False
    page.click("#locusGoBtn")                          # commit -> greys out again
    assert _go_disabled(page) is True
    page.close()


def test_go_range(browser):
    page = _open(browser)
    page.fill("#locusPosInput", "1,000-2,000")         # fill fires input -> dirty -> Go on
    page.click("#locusGoBtn")
    s = _state(page)
    assert (s["c"], s["s"], s["e"]) == ("chr1", 1000, 2000), s
    page.close()


def test_go_single_position_expands_100bp(browser):
    page = _open(browser)
    page.fill("#locusPosInput", "1500")
    page.click("#locusGoBtn")
    s = _state(page)
    # +/-100 each side of 1500.
    assert (s["s"], s["e"]) == (1400, 1600), s
    page.close()


def test_contig_select_stages_not_jumps(browser):
    # Picking a contig must NOT jump; it stages the change and enables Go.
    page = _open(browser)
    page.evaluate(
        "() => { const s = document.getElementById('locusContigSelect');"
        "s.value = 'chr2'; s.dispatchEvent(new Event('change', {bubbles: true})); }")
    assert _state(page)["c"] == "chr1"                 # still on chr1 (not jumped)
    assert _go_disabled(page) is False                 # Go now enabled
    page.click("#locusGoBtn")
    assert _state(page)["c"] == "chr2"                  # committed
    page.close()


def test_chrom_click_stages_pending_box(browser):
    # Clicking the chromosome overview (opt-in) stages a pending target: sets
    # __pendingLocus, fills the bar, enables Go — but does NOT jump.
    page = _open(browser)
    before = _state(page)
    r = page.evaluate(r"""() => {
        window.__GS_STATE.chromClickJump = true;
        window.__GS_STATE.gestureMovedPx = 0;
        const svg = document.getElementById('locusIdeogram');
        const r = svg.getBoundingClientRect();
        const hit = window.__GS_STATE.__ideogramHitRect;
        if (!hit) return { ok: false, reason: 'no hit rect' };
        // Click ~25% across the ideogram band.
        const sx = r.width / (hit.svgW || r.width);
        const ev = { button: 0,
            clientX: r.left + (hit.x + hit.w * 0.25) * sx,
            clientY: r.top + (hit.y + hit.h * 0.5) * (r.height / (hit.svgH || r.height)) };
        const staged = window.gsMaybeChromClickStage(ev);
        return { ok: true, staged: staged, pl: window.__GS_STATE.__pendingLocus,
                 goDisabled: document.getElementById('locusGoBtn').disabled };
    }""")
    assert r["ok"], r
    assert r["staged"] is True
    assert r["pl"] and r["pl"]["contig"] == before["c"]
    assert r["goDisabled"] is False                    # Go enabled by the stage
    assert _state(page) == before                      # view NOT moved yet
    # The staged center should sit near 25% of the contig (chr1 = 1,000,000).
    center = (r["pl"]["start"] + r["pl"]["end"]) / 2
    assert 200_000 < center < 300_000, center
    page.close()


def test_go_switches_contig(browser):
    page = _open(browser)
    page.evaluate("() => window.gsGoToLocus('chr2:100-200')")
    s = _state(page)
    assert (s["c"], s["s"], s["e"]) == ("chr2", 100, 200), s
    page.close()


def test_enter_key_submits(browser):
    page = _open(browser)
    page.evaluate("() => { document.getElementById('locusContigSelect').value='chr1'; }")
    page.fill("#locusPosInput", "5000-6000")
    page.press("#locusPosInput", "Enter")
    s = _state(page)
    assert (s["s"], s["e"]) == (5000, 6000), s
    page.close()


def _readout(page):
    return page.evaluate("() => (document.getElementById('locusReadout')||{}).textContent || ''")


def _readout_bp(txt):
    # hover/midpoint form is "chr1:1,543"
    return int(txt.split(":")[1].split("-")[0].replace(",", ""))


def test_readout_follows_mouse_x_over_tracks(browser):
    page = _open(browser)
    idle = _readout(page)
    assert ":" in idle and "-" not in idle, idle
    assert _readout_bp(idle) == 1500, idle  # midpoint of chr1:1000-2000

    def _hover_at_frac(frac, prev=None):
        page.evaluate(
            """(frac) => {
              const t = document.getElementById('tracksContainer').getBoundingClientRect();
              const ev = new PointerEvent('pointermove', {
                bubbles: true, clientX: t.x + t.width * frac, clientY: t.y + 20,
                pointerId: 1, pointerType: 'mouse',
              });
              document.getElementById('main').dispatchEvent(ev);
            }""",
            frac,
        )
        if prev is None:
            page.wait_for_function(
                "(idle) => { const t = (document.getElementById('locusReadout')||{}).textContent || '';"
                " return t !== idle && t.indexOf('-') < 0; }",
                arg=idle,
            )
        else:
            page.wait_for_function(
                "(prev) => { const t = (document.getElementById('locusReadout')||{}).textContent || '';"
                " return t !== prev && t.indexOf('-') < 0; }",
                arg=prev,
            )
        return _readout(page)

    a = _hover_at_frac(0.25)
    b = _hover_at_frac(0.75, a)
    assert _readout_bp(a) < _readout_bp(b), (a, b)
    # Both should sit inside the current view (chr1:1000-2000).
    assert 1000 <= _readout_bp(a) <= 2000, a
    assert 1000 <= _readout_bp(b) <= 2000, b

    # Leaving the pane keeps the last coordinate (does not snap back to a range).
    page.evaluate("() => document.getElementById('main').dispatchEvent("
                  "new PointerEvent('pointerleave', { bubbles: false }))")
    page.wait_for_timeout(50)
    assert _readout(page) == b, (_readout(page), b)
    page.close()


def test_readout_follows_mouse_x_over_ideogram(browser):
    page = _open(browser)
    page.evaluate(
        """() => {
          const svg = document.getElementById('locusIdeogram');
          const r = svg.getBoundingClientRect();
          const ev = new PointerEvent('pointermove', {
            bubbles: true, clientX: r.x + r.width * 0.25, clientY: r.y + r.height * 0.5,
            pointerId: 1, pointerType: 'mouse',
          });
          svg.dispatchEvent(ev);
        }""")
    page.wait_for_function(
        "() => { const t = (document.getElementById('locusReadout')||{}).textContent || '';"
        " const n = parseInt((t.split(':')[1]||'').replace(/,/g,''), 10);"
        " return n > 100000; }")
    txt = _readout(page)
    bp = _readout_bp(txt)
    # Full-contig mapping: chr1 is 1,000,000 bp, 25% ≈ 250kb — not the 1kb view.
    assert 150_000 < bp < 350_000, txt
    page.close()


def test_locus_bar_fullscreen_toggle(browser):
    page = _open(browser)
    btn = page.locator("#locusFullscreenBtn")
    assert btn.count() == 1
    assert page.get_attribute("#locusFullscreenBtn", "aria-pressed") == "false"
    page.click("#locusFullscreenBtn")
    page.wait_for_timeout(400)
    assert page.get_attribute("#locusFullscreenBtn", "aria-pressed") == "true"
    overlay = page.evaluate("""() => {
      const o = document.querySelector('[id^="genomeshader-overlay-"]');
      const m = document.querySelector('[id^="genomeshader-modal-"]');
      const t = document.querySelector('[id^="genomeshader-topbar-"]');
      if (!o || !m) return { overlay: !!o };
      const mr = m.getBoundingClientRect();
      const body = m.firstElementChild;
      const br = body ? body.getBoundingClientRect() : null;
      return {
        overlay: true,
        hasTopbar: !!t,
        bodyTop: br && br.top,
        modalTop: mr.top,
        bodyH: br && br.height,
        modalH: mr.height,
      };
    }""")
    assert overlay["overlay"], "fullscreen overlay should appear"
    assert overlay["hasTopbar"] is False, overlay
    assert overlay["bodyTop"] == overlay["modalTop"], overlay
    assert overlay["bodyH"] == overlay["modalH"], overlay
    page.click("#locusFullscreenBtn")
    page.wait_for_timeout(400)
    assert page.get_attribute("#locusFullscreenBtn", "aria-pressed") == "false"
    page.close()


def test_locus_bar_lock_disables_zoom_and_drag(browser):
    page = _open(browser)
    btn = page.locator("#locusLockBtn")
    assert btn.count() == 1
    assert page.get_attribute("#locusLockBtn", "aria-pressed") == "false"
    assert page.get_attribute("#locusLockBtn", "aria-label") == "Lock viewport"
    assert page.evaluate("() => document.getElementById('lockViewportLabel').textContent") == "Lock viewport"

    def _view():
        return page.evaluate(
            "() => ({s: window.__GS_STATE.startBp, e: window.__GS_STATE.endBp,"
            " span: window.__GS_STATE.endBp - window.__GS_STATE.startBp})")

    # Unlocked: wheel zooms.
    before = _view()
    page.mouse.move(700, 400)
    page.mouse.wheel(0, -240)
    page.wait_for_timeout(120)
    zoomed = _view()
    assert zoomed["span"] < before["span"] * 0.95, (before, zoomed)

    page.click("#locusLockBtn")
    assert page.get_attribute("#locusLockBtn", "aria-pressed") == "true"
    assert page.get_attribute("#locusLockBtn", "aria-label") == "Unlock viewport"
    assert page.evaluate("() => document.getElementById('lockViewportLabel').textContent") == "Unlock viewport"
    assert page.evaluate("() => document.getElementById('locusLockBtn').classList.contains('is-active')")
    locked = _view()
    page.mouse.move(700, 400)
    page.mouse.wheel(0, -240)
    page.wait_for_timeout(120)
    after_wheel = _view()
    assert after_wheel == locked, (locked, after_wheel)

    # Drag must not pan while locked (same freeze as Settings → Lock viewport).
    pt = page.evaluate(
        """() => { const m = document.getElementById('main').getBoundingClientRect();
           return { x: m.x + m.width * 0.55, y: m.y + m.height * 0.82 }; }""")
    page.mouse.move(pt["x"], pt["y"])
    page.mouse.down()
    page.mouse.move(pt["x"] - 200, pt["y"], steps=8)
    page.mouse.up()
    page.wait_for_timeout(120)
    after_drag = _view()
    assert after_drag == locked, (locked, after_drag)

    page.click("#locusLockBtn")
    assert page.get_attribute("#locusLockBtn", "aria-pressed") == "false"
    assert page.evaluate("() => document.getElementById('lockViewportLabel').textContent") == "Lock viewport"
    page.mouse.move(700, 400)
    page.mouse.wheel(0, -240)
    page.wait_for_timeout(120)
    unlocked = _view()
    assert unlocked["span"] < locked["span"] * 0.95, (locked, unlocked)

    # Go still jumps while locked.
    page.click("#locusLockBtn")
    page.fill("#locusPosInput", "1,000-2,000")
    page.click("#locusGoBtn")
    jumped = _state(page)
    assert (jumped["c"], jumped["s"], jumped["e"]) == ("chr1", 1000, 2000), jumped
    page.close()


def test_settings_lock_viewport_matches_padlock(browser):
    page = _open(browser)

    def _view():
        return page.evaluate(
            "() => ({s: window.__GS_STATE.startBp, e: window.__GS_STATE.endBp,"
            " span: window.__GS_STATE.endBp - window.__GS_STATE.startBp,"
            " locked: window.__GS_STATE.lockView === true})")

    layout = page.evaluate(
        """() => {
          const sections = [...document.querySelectorAll('.settings-section')]
            .map(r => r.textContent.trim());
          const row = document.getElementById('lockViewportItem');
          const chrom = document.getElementById('chromClickJumpItem');
          return {
            sections: sections,
            label: document.getElementById('lockViewportLabel').textContent,
            chromAfterLock: !!(chrom && chrom.previousElementSibling
              && chrom.previousElementSibling.id === 'lockViewportItem'),
            padlockPressed: document.getElementById('locusLockBtn')
              .getAttribute('aria-pressed'),
          };
        }""")
    assert "Interaction" in layout["sections"], layout
    assert layout["label"] == "Lock viewport", layout
    assert layout["chromAfterLock"] is True, layout
    assert layout["padlockPressed"] == "false", layout

    page.click(".command-strip-settings [data-left-tab='settings']")
    page.click("#lockViewportItem")
    assert page.evaluate("() => window.__GS_STATE.lockView") is True
    assert page.get_attribute("#locusLockBtn", "aria-pressed") == "true"
    assert page.get_attribute("#locusLockBtn", "aria-label") == "Unlock viewport"
    assert page.evaluate("() => document.getElementById('lockViewportLabel').textContent") == "Unlock viewport"

    disabled = _view()
    page.mouse.move(700, 400)
    page.mouse.wheel(0, -240)
    page.wait_for_timeout(120)
    after_wheel = _view()
    assert after_wheel["span"] == disabled["span"], (disabled, after_wheel)
    assert after_wheel["s"] == disabled["s"], (disabled, after_wheel)

    page.click("#locusLockBtn")
    assert page.evaluate("() => window.__GS_STATE.lockView") is False
    assert page.get_attribute("#locusLockBtn", "aria-pressed") == "false"
    assert page.evaluate("() => document.getElementById('lockViewportLabel').textContent") == "Lock viewport"
    page.close()


def test_connect_lock_fullscreen_icons_are_equally_spaced(browser):
    """The three right-hand toolbar icons sit at equal pitch (they used to be 32px and 40px apart)."""
    page = _open(browser)
    centers = page.evaluate(
        """() => ['locusConnectBtn', 'locusLockBtn', 'locusFullscreenBtn'].map((id) => {
             const svg = document.querySelector('#' + id + ' svg:not([style*="display: none"])');
             const btn = document.getElementById(id);
             const r = (svg && svg.getBoundingClientRect().width ? svg : btn).getBoundingClientRect();
             return r.left + r.width / 2; })"""
    )
    gaps = [centers[1] - centers[0], centers[2] - centers[1]]
    assert abs(gaps[0] - gaps[1]) < 0.75, (centers, gaps)
    # Same spacing when the toggle is in its "disconnected" (broken-link) state.
    page.evaluate("() => window.gsSetConnected(false)")
    centers2 = page.evaluate(
        """() => ['locusConnectBtn', 'locusLockBtn', 'locusFullscreenBtn'].map((id) =>
             { const r = document.getElementById(id).getBoundingClientRect(); return r.left + r.width / 2; })"""
    )
    assert abs((centers2[1] - centers2[0]) - (centers2[2] - centers2[1])) < 0.75, centers2
    icon = page.evaluate(
        """() => ({ connected: getComputedStyle(document.querySelector('#locusConnectBtn .icon-connected')).display,
                   disconnected: getComputedStyle(document.querySelector('#locusConnectBtn .icon-disconnected')).display })"""
    )
    assert icon == {"connected": "none", "disconnected": "block"}, icon
    page.close()
