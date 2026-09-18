"""Coverage scale + user track groups (shared settings)."""
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


def _page(browser):
    page = browser.new_page(viewport={"width": 1200, "height": 900})
    page.add_init_script(
        "try {"
        " localStorage.removeItem('genomeshader.readDisplayByTrack');"
        " localStorage.removeItem('genomeshader.trackGroups');"
        " localStorage.removeItem('genomeshader.trackGroupByTrack');"
        "} catch (e) {}"
    )
    path = os.path.join(tempfile.mkdtemp(), "track-groups.html")
    open(path, "w").write(harness.build_page())
    page.goto("file://" + path, wait_until="load")
    page.wait_for_function("() => window.__GS_READY === true", timeout=20000)
    page.evaluate("() => document.querySelector('.app').classList.add('sidebar-collapsed')")
    return page


def _seed_two_tracks(page):
    page.evaluate(
        """async () => {
          const S = window.__GS_STATE, start = S.startBp;
          const mk = (name, hap) => ({
            query_name: [name], element_type: [0],
            reference_start: [start + 10], reference_end: [start + 40],
            is_forward: [true], haplotype: [hap],
            sample_name: [name], read_group: ['rg'],
            mapping_quality: [60], insert_size: [300],
            clip_length: [0], mean_base_quality: [30],
            is_paired: [true], is_primary: [true],
            is_secondary: [false], is_supplementary: [false],
            sequence: ['']
          });
          await window.__GS_TEST_seedSmartTrack('A', mk('a', 1), {collapsed: true});
          await window.__GS_TEST_seedSmartTrack('B', mk('b', 2), {collapsed: true});
          const app = document.querySelector('.app');
          if (app) app.classList.remove('sidebar-collapsed');
          const right = document.getElementById('sidebarRight');
          if (right) { right.classList.remove('collapsed'); right.style.display = ''; }
          if (typeof state !== 'undefined') state.rightSidebarCollapsed = false;
          if (typeof renderSmartTracksSidebar === 'function') renderSmartTracksSidebar();
        }"""
    )
    page.wait_for_selector(".smart-track-item-gear", state="attached")


def test_coverage_scale_row_and_modes(browser):
    page = _page(browser)
    _seed_two_tracks(page)
    page.evaluate(
        """() => {
          const t = window.__GS_STATE.smartTracks[0];
          t.readDisplay.summaryField = 'coverage';
          t.readDisplay.coverageScale = {mode:'track', fixedMin:0, fixedMax:30};
          window.toggleTrackConfig(t.id);
        }"""
    )
    page.wait_for_selector(".rd-config-section-label", state="attached")
    labels = page.evaluate(
        "() => [...document.querySelectorAll('.rd-config-label')].map(e => e.textContent)"
    )
    assert "Scale" in labels
    toggles = page.evaluate(
        "() => [...document.querySelectorAll('.rd-toggle')].map(e => e.textContent)"
    )
    assert "Track" in toggles and "View" in toggles and "Fixed" in toggles

    page.evaluate(
        """() => {
          const btn = [...document.querySelectorAll('.rd-toggle')].find(e => e.textContent === 'Fixed');
          btn.click();
        }"""
    )
    page.wait_for_timeout(100)
    mode = page.evaluate(
        "() => window.__GS_STATE.smartTracks[0].readDisplay.coverageScale.mode"
    )
    assert mode == "fixed"
    page.evaluate(
        """() => {
          const inputs = document.querySelectorAll('.rd-scale-range .rd-mapq-input');
          inputs[1].value = '42';
          inputs[1].dispatchEvent(new Event('change', {bubbles:true}));
        }"""
    )
    page.wait_for_timeout(100)
    mx = page.evaluate(
        "() => window.__GS_STATE.smartTracks[0].readDisplay.coverageScale.fixedMax"
    )
    assert mx == 42
    page.close()


def test_create_group_rail_chip_and_dissolve(browser):
    page = _page(browser)
    _seed_two_tracks(page)
    result = page.evaluate(
        """() => {
          const ids = window.__GS_STATE.smartTracks.map(t => t.id);
          const g = window.__GS_createTrackGroup(ids, {name:'hp1/hp2'});
          if (typeof renderSmartTracksSidebar === 'function') renderSmartTracksSidebar();
          return {
            groupId: g && g.id,
            members: g && g.memberTrackIds.length,
            sources: window.__GS_STATE.smartTracks.map(t => t.readDisplay.coverageScaleSource),
            rails: document.querySelectorAll('.smart-track-item.tg-grouped').length,
            chips: document.querySelectorAll('.tg-chip').length,
            railBtns: document.querySelectorAll('.tg-rail-btn').length,
          };
        }"""
    )
    assert result["members"] == 2
    assert result["rails"] == 2
    assert result["railBtns"] == 2
    assert result["chips"] == 0
    assert result["sources"] == ["group", "group"]

    page.evaluate(
        """() => {
          const g = window.__GS_STATE.trackGroups[0];
          window.__GS_dissolveTrackGroup(g.id);
          renderSmartTracksSidebar();
        }"""
    )
    after = page.evaluate(
        """() => ({
          groups: window.__GS_STATE.trackGroups.length,
          rails: document.querySelectorAll('.smart-track-item.tg-grouped').length,
          sources: window.__GS_STATE.smartTracks.map(t => t.readDisplay.coverageScaleSource),
          groupIds: window.__GS_STATE.smartTracks.map(t => t.groupId),
        })"""
    )
    assert after["groups"] == 0
    assert after["rails"] == 0
    assert after["sources"] == ["track", "track"]
    assert after["groupIds"] == [None, None]
    page.close()


def test_chain_toggle_and_shared_settings(browser):
    page = _page(browser)
    _seed_two_tracks(page)
    page.evaluate(
        """() => {
          const ids = window.__GS_STATE.smartTracks.map(t => t.id);
          window.__GS_createTrackGroup(ids, {name:'pair'});
          const lead = window.__GS_STATE.smartTracks[0];
          lead.readDisplay.summaryField = 'coverage';
          lead.readDisplay.coverageScale = {mode:'fixed', fixedMin:0, fixedMax:30};
          const other = window.__GS_STATE.smartTracks[1];
          other.readDisplay.summaryField = 'coverage';
          window.toggleTrackConfig(other.id);
        }"""
    )
    page.wait_for_selector(".tg-drawer-banner", state="attached")
    assert page.evaluate(
        """() => {
          const b = document.querySelector('.tg-drawer-banner');
          const t = (b && b.textContent || '').replace(/\\s+/g, ' ').trim();
          const otherLabel = window.__GS_STATE.smartTracks[1].label;
          return {
            hasApply: !!b.querySelector('.tg-apply-to-group input'),
            applyOn: !!(b.querySelector('.tg-apply-to-group input') || {}).checked,
            showsGroup: t.includes('pair'),
            noTrackLabel: !t.includes(otherLabel),
          };
        }"""
    ) == {"hasApply": True, "applyOn": True, "showsGroup": True, "noTrackLabel": True}
    assert page.evaluate("() => document.querySelectorAll('.tg-chain.is-linked').length") >= 1
    assert page.evaluate("() => document.querySelectorAll('.rd-scale-control.is-dimmed').length") >= 1

    page.evaluate("() => document.querySelector('.tg-chain.is-linked').click()")
    page.wait_for_timeout(100)
    src = page.evaluate(
        "() => window.__GS_STATE.smartTracks[1].readDisplay.coverageScaleSource"
    )
    assert src == "track"
    assert page.evaluate("() => document.querySelectorAll('.tg-chain.is-broken').length") >= 1
    page.close()


def test_auto_dissolve_when_one_member_left(browser):
    page = _page(browser)
    _seed_two_tracks(page)
    page.evaluate(
        """() => {
          const ids = window.__GS_STATE.smartTracks.map(t => t.id);
          window.__GS_createTrackGroup(ids);
          window.__GS_removeTrackFromGroup(ids[0]);
        }"""
    )
    out = page.evaluate(
        """() => ({
          groups: window.__GS_STATE.trackGroups.length,
          groupIds: window.__GS_STATE.smartTracks.map(t => t.groupId),
          sources: window.__GS_STATE.smartTracks.map(t => t.readDisplay.coverageScaleSource),
        })"""
    )
    assert out["groups"] == 0
    assert out["groupIds"] == [None, None]
    assert out["sources"] == ["track", "track"]
    page.close()


def test_link_drag_api_and_already_in_group(browser):
    page = _page(browser)
    _seed_two_tracks(page)
    page.evaluate(
        """async () => {
          const S = window.__GS_STATE, start = S.startBp;
          const reads = {
            query_name: ['c'], element_type: [0],
            reference_start: [start + 10], reference_end: [start + 20],
            is_forward: [true], haplotype: [0],
            sample_name: ['C'], read_group: ['rg'],
            mapping_quality: [40], insert_size: [200],
            clip_length: [0], mean_base_quality: [25],
            is_paired: [true], is_primary: [true],
            is_secondary: [false], is_supplementary: [false],
            sequence: ['']
          };
          await window.__GS_TEST_seedSmartTrack('C', reads, {collapsed: true});
        }"""
    )
    out = page.evaluate(
        """() => {
          const [a, b, c] = window.__GS_STATE.smartTracks.map(t => t.id);
          // Neither grouped → create.
          const r0 = window.__GS_linkTracksByDrag(a, b);
          // Drag ungrouped c onto grouped a → add to group.
          const r1 = window.__GS_linkTracksByDrag(c, a);
          // Fabricate a second group membership conflict:
          window.__GS_STATE.trackGroups.slice().forEach(g => window.__GS_dissolveTrackGroup(g.id));
          window.__GS_createTrackGroup([a, b], {name:'X'});
          const fake = {id:'tg-fake', name:'Y', color:'#f00', memberTrackIds:[c]};
          window.__GS_STATE.trackGroups.push(fake);
          window.__GS_STATE.smartTracks.find(t => t.id === c).groupId = fake.id;
          const r2 = window.__GS_linkTracksByDrag(a, c);
          return {
            created: r0.ok,
            added: r1.ok,
            blocked: r2,
            memberCounts: window.__GS_STATE.trackGroups.map(g => g.memberTrackIds.length),
          };
        }"""
    )
    assert out["created"] is True
    assert out["added"] is True
    assert out["blocked"]["ok"] is False
    assert out["blocked"]["reason"] == "already_in_group"
    page.close()
