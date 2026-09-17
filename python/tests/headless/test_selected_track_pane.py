"""Tracks-list gear opens an inline config drawer under that row.

Guards:
- every track row has a gear
- clicking it opens type / visibility / collapse controls under the row
- clicking again closes the drawer
- opening another row closes the previous one
- collapsing from the drawer updates layout state
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
    page = browser.new_page(viewport={"width": 1200, "height": 900})
    page.add_init_script(
        "try{localStorage.setItem('genomeshader.theme','light');"
        "localStorage.setItem('genomeshader.rightSidebarCollapsed','false');}catch(e){}"
    )
    f = os.path.join(tempfile.mkdtemp(), "h.html")
    open(f, "w").write(harness.build_page())
    page.goto("file://" + f, wait_until="load")
    page.wait_for_function("() => window.__GS_READY === true", timeout=20000)
    page.wait_for_timeout(200)
    return page


def test_gear_toggles_inline_config(browser):
    page = _open(browser)
    info = page.evaluate("""() => {
      const gears = document.querySelectorAll('.smart-track-item-gear');
      const genes = document.querySelector('.smart-track-item[data-track-id="genes"]');
      const gear = genes && genes.querySelector('.smart-track-item-gear');
      return {
        gearCount: gears.length,
        rowCount: document.querySelectorAll('.smart-track-item').length,
        openBefore: !!document.querySelector('.smart-track-item-config'),
        hasGenesGear: !!gear,
        noSeparateTab: !document.getElementById('tab-track'),
      };
    }""")
    assert info["noSeparateTab"] is True, info
    assert info["hasGenesGear"] is True, info
    assert info["gearCount"] >= 1, info
    assert info["gearCount"] == info["rowCount"], info
    assert info["openBefore"] is False, info

    opened = page.evaluate("""() => {
      const gear = document.querySelector('.smart-track-item[data-track-id="genes"] .smart-track-item-gear');
      gear.click();
      const genes = document.querySelector('.smart-track-item[data-track-id="genes"]');
      const panel = genes && genes.querySelector('.smart-track-item-config');
      return {
        open: !!panel,
        configOpenClass: !!(genes && genes.classList.contains('config-open')),
        gearActive: !!(genes && genes.querySelector('.smart-track-item-gear').classList.contains('active')),
        type: (panel && panel.querySelector('.track-config-type') || {}).textContent,
        visible: !!(panel && panel.querySelector('.track-config-visible') || {}).checked,
        collapsed: !!(panel && panel.querySelector('.track-config-collapsed') || {}).checked,
        expandedId: window.__GS_STATE.expandedTrackConfigId,
      };
    }""")
    assert opened["open"] is True, opened
    assert opened["configOpenClass"] is True, opened
    assert opened["gearActive"] is True, opened
    assert opened["type"] == "Genes", opened
    assert opened["visible"] is True, opened
    assert opened["collapsed"] is False, opened
    assert opened["expandedId"] == "genes", opened

    afterCollapse = page.evaluate("""() => {
      const genes = document.querySelector('.smart-track-item[data-track-id="genes"]');
      const cb = genes.querySelector('.track-config-collapsed');
      cb.checked = true;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
      const t = window.__GS_STATE.tracks.find(x => x.id === 'genes');
      const stillOpen = !!document.querySelector(
        '.smart-track-item[data-track-id="genes"] .smart-track-item-config');
      return { collapsed: !!(t && t.collapsed), stillOpen };
    }""")
    assert afterCollapse["collapsed"] is True, afterCollapse
    assert afterCollapse["stillOpen"] is True, afterCollapse

    swapped = page.evaluate("""() => {
      document.querySelector('.smart-track-item[data-track-id="reference"] .smart-track-item-gear').click();
      return {
        expandedId: window.__GS_STATE.expandedTrackConfigId,
        genesOpen: !!document.querySelector(
          '.smart-track-item[data-track-id="genes"] .smart-track-item-config'),
        refOpen: !!document.querySelector(
          '.smart-track-item[data-track-id="reference"] .smart-track-item-config'),
        refType: ((document.querySelector(
          '.smart-track-item[data-track-id="reference"] .track-config-type') || {}).textContent),
      };
    }""")
    assert swapped["expandedId"] == "reference", swapped
    assert swapped["genesOpen"] is False, swapped
    assert swapped["refOpen"] is True, swapped
    assert swapped["refType"] == "Reference", swapped

    closed = page.evaluate("""() => {
      document.querySelector('.smart-track-item[data-track-id="reference"] .smart-track-item-gear').click();
      return {
        expandedId: window.__GS_STATE.expandedTrackConfigId,
        anyOpen: !!document.querySelector('.smart-track-item-config'),
      };
    }""")
    assert closed["expandedId"] is None, closed
    assert closed["anyOpen"] is False, closed
    page.close()


def test_read_track_config_is_type_aware(browser):
    page = _open(browser)
    smart = page.evaluate("""async () => {
      const S = window.__GS_STATE;
      const reads = {query_name:['r0'], element_type:[0],
        reference_start:[S.startBp+10], reference_end:[S.endBp-10],
        is_forward:[true], haplotype:[1], sample_name:['NA12878'], sequence:['']};
      const seeded = await window.__GS_TEST_seedSmartTrack('NA12878', reads, {collapsed:false});
      window.toggleTrackConfig(seeded.trackId);
      const item = document.querySelector('.smart-track-item[data-track-id="' + seeded.trackId + '"]');
      const panel = item && item.querySelector('.smart-track-item-config');
      const label = panel && panel.querySelector('.track-config-collapsed');
      return {
        trackId: seeded.trackId,
        type: (panel && panel.querySelector('.track-config-type') || {}).textContent,
        collapseLabel: (label && label.parentElement || {}).textContent,
        gear: !!(item && item.querySelector('.smart-track-item-gear')),
      };
    }""")
    assert smart["gear"] is True, smart
    assert smart["type"] == "Reads", smart
    assert "summary" in (smart["collapseLabel"] or "").lower(), smart
    page.close()


def test_read_track_show_as_pairs_control(browser):
    page = _open(browser)
    out = page.evaluate("""async () => {
      const S = window.__GS_STATE;
      const s = S.startBp;
      const reads = {
        query_name: ['pe','pe','inner'],
        element_type: [0,0,0],
        reference_start: [s+10, s+200, s+80],
        reference_end: [s+30, s+220, s+100],
        is_forward: [true, false, true],
        haplotype: [0,0,0],
        sample_name: ['NA12878','NA12878','NA12878'],
        sequence: ['','',''],
        is_paired: [true, true, false],
        is_primary: [true, true, true],
      };
      const seeded = await window.__GS_TEST_seedSmartTrack('NA12878', reads, {collapsed:false});
      window.toggleTrackConfig(seeded.trackId);
      const item = document.querySelector('.smart-track-item[data-track-id="' + seeded.trackId + '"]');
      const panel = item && item.querySelector('.smart-track-item-config');
      const cb = panel && panel.querySelector('.track-config-show-pairs');
      const genesGear = document.querySelector('.smart-track-item[data-track-id="genes"] .smart-track-item-gear');
      genesGear.click();
      const genesPanel = document.querySelector(
        '.smart-track-item[data-track-id="genes"] .smart-track-item-config');
      const genesHasPairs = !!(genesPanel && genesPanel.querySelector('.track-config-show-pairs'));
      window.toggleTrackConfig(seeded.trackId);
      const item2 = document.querySelector('.smart-track-item[data-track-id="' + seeded.trackId + '"]');
      const cb2 = item2 && item2.querySelector('.track-config-show-pairs');
      const beforeRows = seeded.rowCount;
      cb2.checked = true;
      cb2.dispatchEvent(new Event('change', { bubbles: true }));
      const t = window.__GS_STATE.smartTracks.find(x => x.id === seeded.trackId);
      const pe = (t.readsLayout.reads || []).filter(r => r.name === 'pe');
      const inner = (t.readsLayout.reads || []).find(r => r.name === 'inner');
      return {
        hasCb: !!cb,
        genesHasPairs,
        checkedDefault: !!(cb && cb.checked),
        showPairs: !!(t && t.showPairs),
        beforeRows,
        afterRows: t.readsLayout.rowCount,
        readCount: t.readsLayout.reads.length,
        sameRow: pe.length === 2 && pe[0].row === pe[1].row,
        innerPushed: !!(inner && pe[0] && inner.row !== pe[0].row),
        stillTwoObjects: pe.length === 2 && !!pe[0].mate && !!pe[1].mate,
      };
    }""")
    assert out["hasCb"] is True, out
    assert out["genesHasPairs"] is False, out
    assert out["checkedDefault"] is False, out
    assert out["showPairs"] is True, out
    assert out["beforeRows"] == 1, out
    assert out["afterRows"] == 2, out
    assert out["readCount"] == 3, out
    assert out["sameRow"] is True, out
    assert out["innerPushed"] is True, out
    assert out["stillTwoObjects"] is True, out
    page.close()


def _gear_config_info(page):
    return page.evaluate("""() => {
      const item = document.querySelector('.smart-track-item[data-track-id="genes"]');
      const gear = item && item.querySelector('.smart-track-item-gear');
      const panel = item && item.querySelector('.smart-track-item-config');
      const pr = panel && panel.getBoundingClientRect();
      const gr = gear && gear.getBoundingClientRect();
      return {
        overlay: !!document.querySelector('[id^="genomeshader-overlay-"]'),
        expandedId: window.__GS_STATE.expandedTrackConfigId,
        open: !!panel,
        panelH: pr ? pr.height : 0,
        gearW: gr ? gr.width : 0,
        gearH: gr ? gr.height : 0,
        gearActive: !!(gear && gear.classList.contains('active')),
      };
    }""")


def test_gear_toggles_config_in_fullscreen(browser):
    """Real pointer clicks must open and close the drawer after the viewer
    moves into the fullscreen overlay (JS .click() would miss a swallowed
    pointerdown/click)."""
    page = _open(browser)
    page.click("#locusFullscreenBtn")
    page.wait_for_timeout(400)
    assert page.get_attribute("#locusFullscreenBtn", "aria-pressed") == "true"
    assert _gear_config_info(page)["overlay"] is True

    gear = page.locator('.smart-track-item[data-track-id="genes"] .smart-track-item-gear')
    assert gear.count() == 1
    gear.click()
    opened = _gear_config_info(page)
    assert opened["open"] is True, opened
    assert opened["expandedId"] == "genes", opened
    assert opened["panelH"] > 8, opened
    assert opened["gearActive"] is True, opened

    gear.click()
    closed = _gear_config_info(page)
    assert closed["open"] is False, closed
    assert closed["expandedId"] is None, closed
    assert closed["gearActive"] is False, closed

    page.click("#locusFullscreenBtn")
    page.wait_for_timeout(400)
    assert page.get_attribute("#locusFullscreenBtn", "aria-pressed") == "false"
    page.close()
