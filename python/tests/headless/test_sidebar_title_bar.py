"""Sidebar track title bar: hover reveal, visibility dot, gear badge, remove/undo."""
import os
import sys
import tempfile

import pytest

sys.path.insert(0, os.path.dirname(__file__))
pytest.importorskip("playwright")
pytest.importorskip("anywidget")

from playwright.sync_api import sync_playwright  # noqa: E402
import harness  # noqa: E402

SMART_ITEM = '.smart-track-item[data-track-id^="smart-track-"]'


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as pw:
        try:
            instance = pw.chromium.launch(args=harness.CHROMIUM_ARGS)
        except Exception as exc:
            pytest.skip(f"headless chromium unavailable: {exc}")
        yield instance
        instance.close()


def _open_sidebar_with_track(browser, collapsed=False, read_display=None):
    page = browser.new_page(viewport={"width": 1200, "height": 900})
    page.add_init_script(
        "try { localStorage.removeItem('genomeshader.readDisplayByTrack');"
        "localStorage.setItem('genomeshader.rightSidebarCollapsed','false'); } catch (e) {}"
    )
    path = os.path.join(tempfile.mkdtemp(), "title-bar.html")
    open(path, "w").write(harness.build_page())
    page.goto("file://" + path, wait_until="load")
    page.wait_for_function("() => window.__GS_READY === true", timeout=20000)
    page.evaluate(
        """async ({collapsed, readDisplay}) => {
          const S = window.__GS_STATE, start = S.startBp;
          const reads = {
            query_name: ['r0'], element_type: [0],
            reference_start: [start + 10], reference_end: [start + 40],
            is_forward: [true], haplotype: [1], sample_name: ['S1'], sequence: [''],
            mapping_quality: [40],
          };
          const opts = {collapsed};
          if (readDisplay) opts.readDisplay = readDisplay;
          await window.__GS_TEST_seedSmartTrack('S1', reads, opts);
          const app = document.querySelector('.app');
          if (app) {
            app.classList.remove('sidebar-collapsed');
            app.classList.remove('sidebar-right-collapsed');
          }
          const right = document.getElementById('sidebarRight');
          if (right) {
            right.classList.remove('collapsed');
            right.style.display = '';
          }
          if (typeof setRightSidebarCollapsed === 'function') setRightSidebarCollapsed(false);
          else if (typeof state !== 'undefined') state.rightSidebarCollapsed = false;
          if (typeof renderSmartTracksSidebar === 'function') renderSmartTracksSidebar();
        }""",
        {"collapsed": collapsed, "readDisplay": read_display},
    )
    page.wait_for_selector(SMART_ITEM, state="visible")
    return page


def test_actions_hidden_at_rest_visible_on_focus(browser):
    page = _open_sidebar_with_track(browser)
    at_rest = page.evaluate(
        """(sel) => {
          const item = document.querySelector(sel);
          const actions = item.querySelector('.smart-track-item-actions');
          const grip = item.querySelector('.smart-track-item-grip');
          return {
            actionsOpacity: parseFloat(getComputedStyle(actions).opacity),
            gripOpacity: parseFloat(getComputedStyle(grip).opacity),
            actionsPE: getComputedStyle(actions).pointerEvents,
          };
        }""",
        SMART_ITEM,
    )
    assert at_rest["actionsOpacity"] == 0.0, at_rest
    # Grips stay visible at rest (match on-canvas smart-track pills).
    assert at_rest["gripOpacity"] == pytest.approx(0.55, abs=0.05), at_rest
    assert at_rest["actionsPE"] == "none", at_rest

    page.focus(SMART_ITEM)
    # Wait for the opacity transition to settle rather than guessing a delay; real
    # Chrome's transition clock differs from the old headless shell's.
    page.wait_for_function(
        """(sel) => parseFloat(getComputedStyle(
             document.querySelector(sel).querySelector('.smart-track-item-actions')).opacity) > 0.99""",
        arg=SMART_ITEM, timeout=3000,
    )
    focused = page.evaluate(
        """(sel) => {
          const item = document.querySelector(sel);
          const actions = item.querySelector('.smart-track-item-actions');
          const grip = item.querySelector('.smart-track-item-grip');
          return {
            actionsOpacity: parseFloat(getComputedStyle(actions).opacity),
            gripOpacity: parseFloat(getComputedStyle(grip).opacity),
            actionsPE: getComputedStyle(actions).pointerEvents,
          };
        }""",
        SMART_ITEM,
    )
    assert focused["actionsOpacity"] == pytest.approx(1.0, abs=0.02), focused
    assert focused["gripOpacity"] == pytest.approx(1.0, abs=0.02), focused
    assert focused["actionsPE"] == "auto", focused
    page.close()


def test_chevron_syncs_with_visibility_reads(browser):
    page = _open_sidebar_with_track(browser, collapsed=False)
    chevron = f"{SMART_ITEM} .smart-track-item-collapse-btn"
    assert page.locator(chevron).inner_text() == "▾"
    page.click(chevron)
    g = page.evaluate(
        """(sel) => {
          const t = window.__GS_STATE.smartTracks[0];
          return {
            glyph: document.querySelector(sel + ' .smart-track-item-collapse-btn').textContent,
            reads: t.readDisplay.visibility.reads,
            collapsed: t.collapsed,
          };
        }""",
        SMART_ITEM,
    )
    assert g["glyph"] == "▸", g
    assert g["reads"] is False, g
    assert g["collapsed"] is True, g
    page.click(chevron)
    g2 = page.evaluate(
        """(sel) => {
          const t = window.__GS_STATE.smartTracks[0];
          return {
            glyph: document.querySelector(sel + ' .smart-track-item-collapse-btn').textContent,
            reads: t.readDisplay.visibility.reads,
          };
        }""",
        SMART_ITEM,
    )
    assert g2["glyph"] == "▾" and g2["reads"] is True, g2
    page.close()


def test_visibility_dot_toggles_hidden_only(browser):
    page = _open_sidebar_with_track(browser, collapsed=False)
    before = page.evaluate(
        """() => {
          const t = window.__GS_STATE.smartTracks[0];
          return {
            hidden: !!t.hidden,
            vis: JSON.parse(JSON.stringify(t.readDisplay.visibility)),
          };
        }"""
    )
    assert before["hidden"] is False
    page.click(f"{SMART_ITEM} .smart-track-item-vis-dot")
    after = page.evaluate(
        """(sel) => {
          const t = window.__GS_STATE.smartTracks[0];
          const item = document.querySelector(sel);
          return {
            hidden: !!t.hidden,
            vis: JSON.parse(JSON.stringify(t.readDisplay.visibility)),
            dotHidden: item.querySelector('.smart-track-item-vis-dot').classList.contains('is-hidden'),
            labelDim: item.querySelector('.smart-track-item-label').classList.contains('is-dimmed'),
          };
        }""",
        SMART_ITEM,
    )
    assert after["hidden"] is True, after
    assert after["vis"] == before["vis"], after
    assert after["dotHidden"] and after["labelDim"], after
    page.close()


def test_title_fills_when_actions_hidden(browser):
    page = _open_sidebar_with_track(browser)
    widths = page.evaluate(
        """(sel) => {
          const item = document.querySelector(sel);
          const name = item.querySelector('.smart-track-item-name');
          const header = item.querySelector('.smart-track-item-header');
          const actions = item.querySelector('.smart-track-item-actions');
          const status = item.querySelector('.smart-track-item-status');
          const nav = item.querySelector('.smart-track-item-nav');
          const nameBox = name.getBoundingClientRect();
          const headerBox = header.getBoundingClientRect();
          const statusBox = status.getBoundingClientRect();
          const navBox = nav.getBoundingClientRect();
          return {
            nameWidth: nameBox.width,
            headerWidth: headerBox.width,
            statusWidth: statusBox.width,
            betweenNavAndStatus: statusBox.left - navBox.right,
            actionsInFlow: getComputedStyle(actions).position !== 'absolute',
            actionsOpacity: parseFloat(getComputedStyle(actions).opacity),
          };
        }""",
        SMART_ITEM,
    )
    # Name should claim nearly all space between nav and status (actions overlay).
    # A narrow sidebar makes nav+status most of the header, so this is the gap
    # between those two, not a fraction of the whole row.
    assert widths["actionsInFlow"] is False, widths
    assert widths["actionsOpacity"] == 0.0, widths
    assert widths["nameWidth"] > widths["betweenNavAndStatus"] * 0.8, widths
    page.close()


def test_none_labels_and_reverse_buttons(browser):
    page = _open_sidebar_with_track(browser, collapsed=False)
    page.evaluate(
        """() => {
          const track = window.__GS_STATE.smartTracks[0];
          window.toggleTrackConfig(track.id);
        }"""
    )
    page.wait_for_selector(".rd-config-section-label", state="attached")
    info = page.evaluate(
        """() => {
          const fields = window.__GS_READ_DISPLAY_FIELDS;
          const shadeRow = Array.from(document.querySelectorAll('.rd-config-row'))
            .find(r => r.querySelector('.rd-config-label')?.textContent === 'Shade by');
          const shadeVal = shadeRow && shadeRow.querySelector('.rd-dropdown-value');
          const sortRev = Array.from(document.querySelectorAll('.rd-config-row'))
            .find(r => r.querySelector('.rd-config-label')?.textContent === 'Sort by')
            ?.querySelector('.rd-reverse-btn');
          return {
            groupNone: fields.groupBy[0],
            sortNone: fields.sortBy[0],
            colorNone: fields.colorBy[0],
            shadeNone: fields.shadeBy[0],
            reverseCount: document.querySelectorAll('.rd-reverse-btn').length,
            shadeLabel: shadeVal ? shadeVal.textContent : null,
            sortRevOn: sortRev ? sortRev.classList.contains('is-on') : null,
            sortRevDisabled: sortRev ? sortRev.disabled : null,
          };
        }"""
    )
    assert info["groupNone"] == [None, "None"], info
    assert info["sortNone"] == [None, "None"], info
    assert info["colorNone"] == [None, "None"], info
    assert info["shadeNone"] == [None, "None"], info
    assert info["shadeLabel"] == "None", info
    assert info["reverseCount"] == 4, info
    # Defaults are None → reverse controls start disabled until a field is chosen.
    assert info["sortRevDisabled"] is True, info

    page.evaluate(
        """() => {
          const t = window.__GS_STATE.smartTracks[0];
          t.readDisplay.sortBy = 'position';
          window.toggleTrackConfig(t.id); // close
          window.toggleTrackConfig(t.id); // reopen with updated state
        }"""
    )
    page.wait_for_selector(".rd-reverse-btn:not(:disabled)", state="attached")
    page.evaluate(
        """() => {
          const row = Array.from(document.querySelectorAll('.rd-config-row'))
            .find(r => r.querySelector('.rd-config-label')?.textContent === 'Sort by');
          row.querySelector('.rd-reverse-btn').click();
        }"""
    )
    after = page.evaluate(
        "() => window.__GS_STATE.smartTracks[0].readDisplay.reverse.sortBy"
    )
    assert after is True
    page.close()


def test_remove_arm_confirm_undo_restores_config(browser):
    page = _open_sidebar_with_track(browser)
    page.evaluate(
        """() => {
          const t = window.__GS_STATE.smartTracks[0];
          t.readDisplay.groupBy = 'strand';
          t.readDisplay.mapqRange = { min: 10, max: 50 };
          if (typeof renderSmartTracksSidebar === 'function') renderSmartTracksSidebar();
        }"""
    )
    track_id = page.evaluate("() => window.__GS_STATE.smartTracks[0].id")

    page.focus(SMART_ITEM)
    page.wait_for_timeout(150)
    page.click(f"{SMART_ITEM} .smart-track-item-btn.remove")
    assert page.evaluate(
        "() => !!document.querySelector('.smart-track-item[data-remove=\"armed\"]')"
    )

    page.click(f"{SMART_ITEM} .smart-track-item-remove-confirm")
    toast = page.evaluate(
        """(id) => {
          const row = document.querySelector('.smart-track-item-undo');
          return row ? {
            text: row.querySelector('.smart-track-item-undo-label').textContent,
            smart: window.__GS_STATE.smartTracks.length,
            stillPresent: window.__GS_STATE.tracks.some(t => t.id === id),
          } : null;
        }""",
        track_id,
    )
    assert toast and "removed" in toast["text"], toast
    assert toast["smart"] == 0 and toast["stillPresent"] is False, toast

    page.click(".smart-track-item-undo-btn")
    restored = page.evaluate(
        """(id) => {
          const t = window.__GS_STATE.smartTracks.find(x => x.id === id)
            || window.__GS_STATE.smartTracks[0];
          return t ? {
            id: t.id,
            groupBy: t.readDisplay.groupBy,
            mapq: [t.readDisplay.mapqRange.min, t.readDisplay.mapqRange.max],
            toastGone: !document.querySelector('.smart-track-item-undo'),
          } : null;
        }""",
        track_id,
    )
    assert restored == {
        "id": track_id,
        "groupBy": "strand",
        "mapq": [10, 50],
        "toastGone": True,
    }, restored
    page.close()


def test_remove_timeout_finalizes(browser):
    page = _open_sidebar_with_track(browser)
    track_id = page.evaluate("() => window.__GS_STATE.smartTracks[0].id")
    page.evaluate(
        """(id) => {
          window.__GS_confirmRemoveSmartTrack(id);
        }""",
        track_id,
    )
    assert page.evaluate("() => !!document.querySelector('.smart-track-item-undo')")
    page.evaluate("() => window.__GS_clearPendingUndo(true)")
    gone = page.evaluate(
        """(id) => ({
          toast: !!document.querySelector('.smart-track-item-undo'),
          smart: window.__GS_STATE.smartTracks.length,
          stillPresent: window.__GS_STATE.tracks.some(t => t.id === id),
        })""",
        track_id,
    )
    assert gone == {"toast": False, "smart": 0, "stillPresent": False}, gone
    page.close()


def test_alt_arrow_reorders(browser):
    page = _open_sidebar_with_track(browser)
    page.evaluate(
        """async () => {
          const S = window.__GS_STATE, start = S.startBp;
          const reads = {
            query_name: ['r1'], element_type: [0],
            reference_start: [start + 10], reference_end: [start + 40],
            is_forward: [true], haplotype: [1], sample_name: ['S2'], sequence: [''],
          };
          await window.__GS_TEST_seedSmartTrack('S2', reads, {collapsed: false});
          // Place the two smart tracks adjacent at the top of the list for a
          // deterministic Alt+Arrow swap.
          const smart = window.__GS_STATE.tracks.filter(t => String(t.id).indexOf('smart-track-') === 0);
          const rest = window.__GS_STATE.tracks.filter(t => String(t.id).indexOf('smart-track-') !== 0);
          window.__GS_STATE.tracks = smart.concat(rest);
          if (typeof renderSmartTracksSidebar === 'function') renderSmartTracksSidebar();
        }"""
    )
    ids = page.evaluate(
        """() => window.__GS_STATE.tracks
             .filter(t => String(t.id).indexOf('smart-track-') === 0)
             .map(t => t.id)"""
    )
    assert len(ids) >= 2
    before = page.evaluate("() => window.__GS_STATE.tracks.map(t => t.id)")
    page.focus(f'.smart-track-item[data-track-id="{ids[0]}"]')
    page.keyboard.press("Alt+ArrowDown")
    after = page.evaluate("() => window.__GS_STATE.tracks.map(t => t.id)")
    assert after.index(ids[0]) == before.index(ids[0]) + 1
    assert after[before.index(ids[0])] == ids[1]
    page.close()
