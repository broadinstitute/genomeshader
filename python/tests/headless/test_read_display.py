"""Per-track read-display config lives in the Tracks sidebar gear drawer."""
import os
import sys
import tempfile

import pytest

sys.path.insert(0, os.path.dirname(__file__))
pytest.importorskip("playwright")
pytest.importorskip("anywidget")

from playwright.sync_api import sync_playwright  # noqa: E402
import harness  # noqa: E402


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as pw:
        try:
            instance = pw.chromium.launch(args=harness.CHROMIUM_ARGS)
        except Exception as exc:
            pytest.skip(f"headless chromium unavailable: {exc}")
        yield instance
        instance.close()


def _page_with_reads(browser, collapsed=False):
    page = browser.new_page(viewport={"width": 1200, "height": 900})
    page.add_init_script(
        "try { localStorage.removeItem('genomeshader.readDisplayByTrack'); } catch (e) {}"
    )
    path = os.path.join(tempfile.mkdtemp(), "read-display.html")
    open(path, "w").write(harness.build_page())
    page.goto("file://" + path, wait_until="load")
    page.wait_for_function("() => window.__GS_READY === true", timeout=20000)
    page.evaluate("() => document.querySelector('.app').classList.add('sidebar-collapsed')")
    page.evaluate(
        """async (collapsed) => {
          const S = window.__GS_STATE, start = S.startBp;
          const reads = {
            query_name: ['hp1', 'hp2', 'far'], element_type: [0, 0, 0],
            reference_start: [start + 20, start + 40, S.endBp + 500],
            reference_end: [start + 35, start + 55, S.endBp + 520],
            is_forward: [true, false, true], haplotype: [1, 2, 1],
            sample_name: ['S1', 'S1', 'S1'], read_group: ['rg1', 'rg1', 'rg2'],
            mapping_quality: [60, 20, 40], insert_size: [300, 300, 800],
            clip_length: [0, 8, 2], mean_base_quality: [35, 15, 25],
            is_paired: [true, true, true], is_primary: [true, true, true],
            is_secondary: [false, false, false], is_supplementary: [false, false, false],
            sequence: ['', '', '']
          };
          return await window.__GS_TEST_seedSmartTrack('S1', reads, {collapsed});
        }""",
        collapsed,
    )
    page.evaluate(
        """() => {
          const app = document.querySelector('.app');
          if (app) app.classList.remove('sidebar-collapsed');
          const right = document.getElementById('sidebarRight');
          if (right) {
            right.classList.remove('collapsed');
            right.style.display = '';
          }
          if (typeof state !== 'undefined') state.rightSidebarCollapsed = false;
          if (typeof renderSmartTracksSidebar === 'function') renderSmartTracksSidebar();
        }"""
    )
    page.wait_for_selector(".smart-track-item-gear", state="attached")
    return page


def _open_track_config(page):
    page.evaluate(
        """() => {
          const track = window.__GS_STATE.smartTracks[0];
          if (!track) throw new Error('no smart track');
          window.toggleTrackConfig(track.id);
        }"""
    )
    page.wait_for_selector(".rd-config-section-label", state="attached")


def test_no_canvas_read_display_card(browser):
    page = _page_with_reads(browser, collapsed=False)
    assert page.locator(".read-display-card").count() == 0
    assert page.locator(".rd-chip").count() == 0
    page.close()


def test_sidebar_panel_sections_and_dimming(browser):
    page = _page_with_reads(browser, collapsed=False)
    _open_track_config(page)
    labels = page.locator(".rd-config-section-label").all_text_contents()
    assert labels == ["Summary", "Layout", "Encoding"]

    # Turn Reads off via Visibility toggle → read fields dim.
    page.locator(".rd-toggle", has_text="Reads").evaluate("el => el.click()")
    page.wait_for_timeout(200)
    assert page.locator(".rd-config-section.is-dimmed").count() >= 1
    assert page.evaluate(
        "() => window.__GS_STATE.smartTracks[0].readDisplay.visibility.reads"
    ) is False
    page.close()


def test_both_visibility_off_hides_track(browser):
    page = _page_with_reads(browser, collapsed=False)
    _open_track_config(page)
    # Reads off first — Summary still on, track stays visible.
    page.locator(".rd-toggle.is-on", has_text="Reads").evaluate("el => el.click()")
    page.wait_for_timeout(100)
    assert page.evaluate("() => window.__GS_STATE.smartTracks[0].hidden === true") is False
    # Summary off too → hide.
    page.locator(".rd-toggle.is-on", has_text="Summary").evaluate("el => el.click()")
    page.wait_for_timeout(100)
    assert page.evaluate(
        "() => { const t=window.__GS_STATE.smartTracks[0]; "
        "return !t.readDisplay.visibility.summary && !t.readDisplay.visibility.reads "
        "&& t.hidden === true; }"
    ) is True
    # Re-enable Summary → unhide.
    page.locator(".rd-toggle", has_text="Summary").evaluate("el => el.click()")
    page.wait_for_timeout(100)
    assert page.evaluate(
        "() => { const t=window.__GS_STATE.smartTracks[0]; "
        "return t.readDisplay.visibility.summary === true && t.hidden !== true; }"
    ) is True
    page.close()


def test_default_encoding_fields_are_none(browser):
    page = _page_with_reads(browser, collapsed=False)
    cfg = page.evaluate(
        """() => {
          const d = window.__GS_STATE.smartTracks[0].readDisplay;
          const defaults = window.__GS_STATE.readDisplayDefaults;
          return {
            track: {groupBy:d.groupBy, sortBy:d.sortBy, colorBy:d.colorBy, shadeBy:d.shadeBy},
            defaults: {
              groupBy:defaults.groupBy, sortBy:defaults.sortBy,
              colorBy:defaults.colorBy, shadeBy:defaults.shadeBy,
            },
          };
        }"""
    )
    none4 = {"groupBy": None, "sortBy": None, "colorBy": None, "shadeBy": None}
    assert cfg["track"] == none4, cfg
    assert cfg["defaults"] == none4, cfg
    page.close()


def test_read_paint_no_strand_dim_when_shade_off(browser):
    page = _page_with_reads(browser, collapsed=False)
    alphas = page.evaluate(
        """() => {
          const t = window.__GS_STATE.smartTracks[0];
          t.readDisplay.colorBy = 'sample';
          t.readDisplay.shadeBy = null;
          const fwd = window.__GS_readPaintStyle({isForward:true, haplotype:1, sample:'S1'}, t);
          const rev = window.__GS_readPaintStyle({isForward:false, haplotype:1, sample:'S1'}, t);
          return {
            fwd: fwd.alpha,
            rev: rev.alpha,
            sameColor: JSON.stringify(fwd.color) === JSON.stringify(rev.color),
            bothFillOnly: fwd.alpha <= 0.5 && rev.alpha <= 0.5,
          };
        }"""
    )
    assert alphas["fwd"] == alphas["rev"], alphas
    assert alphas["sameColor"] is True, alphas
    assert alphas["bothFillOnly"] is True, alphas
    page.close()


def test_mapq_group_anchor_legend(browser):
    page = _page_with_reads(browser, collapsed=False)
    _open_track_config(page)

    # MAPQ range defaults and filters.
    vals = page.locator(".rd-mapq-input").evaluate_all("els => els.map(e => e.value)")
    assert vals == ["1", "254"]

    # Group by → Haplotype, Sort by → Dist. to anchor, Color by → Haplotype.
    page.evaluate(
        """() => {
          const t = window.__GS_STATE.smartTracks[0];
          t.readDisplay.groupBy = 'haplotype';
          t.readDisplay.sortBy = 'distanceToAnchor';
          t.readDisplay.colorBy = 'haplotype';
          t.readDisplay.sortAnchor = {mode:'auto', position:{contig:'chr1', pos:12345}};
          if (typeof window.__GS_layoutSmartTrackReads === 'function') {
            window.__GS_layoutSmartTrackReads(t);
          }
          if (typeof window.__GS_saveReadDisplayForTrack === 'function') {
            window.__GS_saveReadDisplayForTrack(t);
          }
          window.toggleTrackConfig(null);
          window.toggleTrackConfig(t.id);
        }"""
    )
    page.wait_for_selector(".rd-anchor-line", state="attached")

    cfg = page.evaluate(
        "() => { const t=window.__GS_STATE.smartTracks[0]; return "
        "{groupBy:t.readDisplay.groupBy, sortBy:t.readDisplay.sortBy, colorBy:t.readDisplay.colorBy}; }"
    )
    assert cfg == {
        "groupBy": "haplotype",
        "sortBy": "distanceToAnchor",
        "colorBy": "haplotype",
    }

    # Pin freezes anchor across sync.
    page.evaluate(
        "() => { const t=window.__GS_STATE.smartTracks[0]; "
        "t.readDisplay.sortAnchor={mode:'auto', position:{contig:'chr1', pos:12345}}; "
        "window.__GS_toggleReadDisplayAnchorPin(t.id); }"
    )
    pinned = page.evaluate(
        "() => window.__GS_STATE.smartTracks[0].readDisplay.sortAnchor"
    )
    assert pinned["mode"] == "pinned"
    assert pinned["position"]["pos"] == 12345
    page.evaluate("() => window.__GS_syncReadDisplayAnchors({contig:'chr1', pos:99999})")
    still = page.evaluate(
        "() => window.__GS_STATE.smartTracks[0].readDisplay.sortAnchor"
    )
    assert still["mode"] == "pinned"
    assert still["position"]["pos"] == 12345

    # Legend matches shared colors.
    legend = page.locator(".rd-legend > span").all_text_contents()
    assert "HP1" in legend and "HP2" in legend
    page.close()


def test_grouped_layout_and_mapq_filter(browser):
    page = _page_with_reads(browser, collapsed=False)
    result = page.evaluate(
        """() => {
          const raw = window.__GS_STATE.smartTracks[0].readsData;
          const def = window.__GS_processReadsData(raw);
          const grouped = window.__GS_processReadsData(raw, {display:{
            summaryField:'haplotypeConsensus',
            visibility:{summary:true, reads:true},
            alignments:{paired:true, supplementary:true, secondary:false},
            mapqRange:{min:1, max:254},
            groupBy:'haplotype', sortBy:'clipLength', colorBy:'haplotype',
            shadeBy:null, sortAnchor:{mode:'auto', position:null}
          }});
          const filtered = window.__GS_processReadsData(raw, {display:{
            summaryField:'haplotypeConsensus',
            visibility:{summary:true, reads:true},
            alignments:{paired:true, supplementary:true, secondary:false},
            mapqRange:{min:50, max:254},
            groupBy:null, sortBy:'position', colorBy:'haplotype',
            shadeBy:null, sortAnchor:{mode:'auto', position:null}
          }});
          return {
            starts: def.reads.map(r => r.start),
            gap: grouped.groupGapPx,
            groups: grouped.groups.map(g => g.key),
            filteredCount: filtered.reads.length,
          };
        }"""
    )
    assert result["starts"] == sorted(result["starts"])
    assert result["gap"] == 8
    assert result["groups"] == ["HP1", "HP2"]
    assert result["filteredCount"] == 1  # only MAPQ 60 survives min=50
    page.close()
