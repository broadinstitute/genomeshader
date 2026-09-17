"""Hide/collapse must drop painted track content, not just the control chrome.

Regressions this guards:
- variant-track collapse button in the overlay was unclickable (hover deadlock)
- hiding genes skipped the shared WebGPU/SVG submit, leaving gene bodies painted
- hiding one of two variant tracks left that track's Canvas2D wrapper visible
  over the shared flow WebGPU layer (nodes without alluvial, or a one-frame y-jump)
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


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as pw:
        try:
            b = pw.chromium.launch(args=harness.CHROMIUM_ARGS)
        except Exception as e:
            pytest.skip(f"headless chromium unavailable: {e}")
        yield b
        b.close()


def _open(browser, tmp_path, config):
    page = browser.new_page(viewport=VIEWPORT)
    errors = []
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    page.on("console", lambda m: errors.append(f"console.error: {m.text}")
            if m.type == "error" else None)
    page.add_init_script(
        "try{localStorage.setItem('genomeshader.orientation','horizontal');"
        "localStorage.setItem('genomeshader.theme','light');}catch(e){}"
        "window.__GS_FORCE_SVG_TRACKS=true;"
    )
    uri = harness.write_page(tmp_path, harness.build_page(config=config))
    page.goto(uri, wait_until="load")
    return page, errors


def _wait_ready(page):
    page.wait_for_function("() => window.__GS_READY === true", timeout=20000)
    page.wait_for_timeout(300)


def _allele(pos, vid, ref="A", alt="T"):
    return {
        "id": vid, "pos": pos, "position": pos,
        "refAllele": ref, "altAlleles": [alt],
        "ref": ref, "alt": alt,
        "n_ref": 80, "n_alt": 20, "n_missing": 0, "n_samples": 100,
        "genotypes": [], "samples": [],
    }


def _two_flow_config():
    return {
        "region": "chr1:100000-100900",
        "genome_build": "hg38",
        "reference_data": "A" * 900,
        "ideogram_data": [],
        "data_bounds": {"start": 100000, "end": 100900},
        "chrom_lengths": {"chr1": 248000000},
        "viewport_variant_loading": False,
        "genes_track": {
            "id": "genes",
            "label": "Genes",
            "style": "gene",
            "series": [{
                "name": "genes",
                "features": [{
                    "name": "GENEA",
                    "strand": "+",
                    "start": 100200,
                    "end": 100600,
                    "lane": 0,
                    "exons": [[100200, 100280, True], [100400, 100500, True]],
                }],
            }],
        },
        "variant_tracks": [
            {"id": "flow-0", "label": "phased", "variants_phased": True,
             "variants_data": [_allele(100300, "v1"), _allele(100500, "v2")]},
            {"id": "flow-1", "label": "TRGT", "variants_phased": False,
             "variants_data": [_allele(100350, "t1"), _allele(100550, "t2")]},
        ],
    }


def test_variant_track_collapse_button_is_hittable(browser, tmp_path):
    page, errors = _open(browser, tmp_path, _two_flow_config())
    _wait_ready(page)
    info = page.evaluate("""() => {
      const btn = document.querySelector(
        '.track-control-container[data-track-id="flow-0"] .track-collapse-btn');
      if (!btn) return { ok: false, reason: 'no button' };
      const pe = getComputedStyle(btn).pointerEvents;
      btn.click();
      return {
        pointerEvents: pe,
        collapsedAfter: !!(window.__GS_STATE.tracks.find(t => t.id === 'flow-0') || {}).collapsed,
      };
    }""")
    assert info["pointerEvents"] == "auto", (
        f"flow-track collapse button cannot receive clicks (pointer-events={info['pointerEvents']})"
    )
    assert info["collapsedAfter"], "clicking the overlay collapse button did not collapse flow-0"
    assert errors == [], errors
    page.close()


def test_hiding_genes_drops_bodies_and_still_draws_other_tracks(browser, tmp_path):
    page, errors = _open(browser, tmp_path, _two_flow_config())
    _wait_ready(page)
    before = page.evaluate("""() => ({
      names: [...document.querySelectorAll('#tracksSvg .svg-geneName')].map(n => n.textContent),
      ticks: document.querySelectorAll('#tracksSvg text.svg-small').length,
    })""")
    assert "GENEA" in before["names"]
    assert before["ticks"] > 0

    page.evaluate("""() => {
      const t = window.__GS_STATE.tracks.find(x => x.id === 'genes');
      if (t) t.hidden = true;
      window.dispatchEvent(new Event('resize'));
    }""")
    page.wait_for_timeout(150)
    after = page.evaluate("""() => ({
      names: [...document.querySelectorAll('#tracksSvg .svg-geneName')].map(n => n.textContent),
      ticks: document.querySelectorAll('#tracksSvg text.svg-small').length,
      geneControl: !!document.querySelector('.track-control-container[data-track-id="genes"]'),
    })""")
    assert after["names"] == [], f"gene labels still painted after hide: {after}"
    assert after["ticks"] > 0, "hiding genes aborted the rest of renderTracks (no axis ticks)"
    assert not after["geneControl"], "gene track control still present after hide"
    assert errors == [], errors
    page.close()


def test_hiding_one_variant_track_hides_its_flow_wrapper(browser, tmp_path):
    page, errors = _open(browser, tmp_path, _two_flow_config())
    _wait_ready(page)
    page.evaluate("""() => {
      const t = window.__GS_STATE.tracks.find(x => x.id === 'flow-0');
      if (t) t.hidden = true;
      window.dispatchEvent(new Event('resize'));
    }""")
    page.wait_for_timeout(150)
    vis = page.evaluate("""() => {
      const wrap = (id) => {
        const el = document.querySelector(`.flow-track[data-track-id="${id}"]`);
        if (!el) return { present: false };
        const cs = getComputedStyle(el);
        return { present: true, display: cs.display, height: el.getBoundingClientRect().height };
      };
      return {
        flow0: wrap('flow-0'),
        flow1: wrap('flow-1'),
        flowDisplay: getComputedStyle(document.getElementById('flow')).display,
      };
    }""")
    assert vis["flow0"]["present"], vis
    assert vis["flow0"]["display"] == "none", f"hidden flow-0 wrapper still showing: {vis}"
    assert vis["flow1"]["display"] != "none", f"remaining flow-1 wrapper was hidden too: {vis}"
    assert vis["flowDisplay"] == "block"
    assert errors == [], errors
    page.close()


def test_variant_track_background_matches_page_and_hides_with_track(browser, tmp_path):
    page, errors = _open(browser, tmp_path, _two_flow_config())
    _wait_ready(page)
    bg = page.evaluate("""() => {
      const flow = document.getElementById('flow');
      const cs = getComputedStyle(flow);
      return { bg: cs.backgroundColor, display: cs.display };
    }""")
    assert bg["display"] == "block"
    assert bg["bg"] in ("rgba(0, 0, 0, 0)", "transparent"), (
        f"variant track still has a distinct wash: {bg}"
    )

    page.evaluate("""() => {
      for (const id of ['flow-0', 'flow-1']) {
        const t = window.__GS_STATE.tracks.find(x => x.id === id);
        if (t) t.hidden = true;
      }
      window.dispatchEvent(new Event('resize'));
    }""")
    page.wait_for_timeout(150)
    hidden = page.evaluate(
        "() => getComputedStyle(document.getElementById('flow')).display")
    assert hidden == "none", f"#flow still visible after hiding all variant tracks: {hidden}"
    assert errors == [], errors
    page.close()
