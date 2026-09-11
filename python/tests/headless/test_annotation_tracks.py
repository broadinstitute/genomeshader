"""Headless coverage for Phase 2 genes/repeats shared-track migration."""
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


def _annotation_config():
    return {
        "region": "chr1:100000-100900",
        "genome_build": "hg38",
        "reference_data": "A" * 900,
        "ideogram_data": [],
        "variant_tracks": [],
        "data_bounds": {"start": 100000, "end": 100900},
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
        "repeats_track": {
            "id": "repeats",
            "label": "RepeatMasker",
            "style": "interval",
            "series": [{
                "name": "repeats",
                "features": [
                    {"start": 100150, "end": 100250, "cls": "LINE"},
                    {"start": 100500, "end": 100650, "cls": "SINE"},
                ],
            }],
        },
    }


def test_genes_and_repeats_render_via_shared_envelope(browser, tmp_path):
    page, errors = _open(browser, tmp_path, _annotation_config())
    _wait_ready(page)

    state = page.evaluate("""() => ({
      hasGenes: (window.__GS_STATE.tracks||[]).some(t => t.id === 'genes'),
      hasRepeats: (window.__GS_STATE.tracks||[]).some(t => t.id === 'repeats'),
      nGenes: window.gsAnnotationFeatures ? window.gsAnnotationFeatures('genes').length : -1,
      nRepeats: window.gsAnnotationFeatures ? window.gsAnnotationFeatures('repeats').length : -1,
      geneNames: (() => {
        const r = document.querySelector('[id^="genomeshader-root-"]');
        const s = r && r.querySelector('#tracksSvg');
        return s ? [...s.querySelectorAll('.svg-geneName')].map(n => n.textContent) : [];
      })(),
      nRects: (() => {
        const r = document.querySelector('[id^="genomeshader-root-"]');
        const s = r && r.querySelector('#tracksSvg');
        return s ? s.querySelectorAll('rect').length : -1;
      })(),
    })""")
    assert state["hasGenes"] and state["hasRepeats"]
    assert state["nGenes"] == 1 and state["nRepeats"] == 2
    assert "GENEA" in state["geneNames"]
    assert state["nRects"] >= 2, f"expected exon/repeat rects, got {state['nRects']}"
    assert errors == [], errors
    page.close()
