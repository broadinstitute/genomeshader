"""Headless tests for software-defined data tracks (line/bar/scatter/interval).

Config ships data_tracks with inlined series so we don't need a live comm —
the harness's __GS_SEND rejects. Asserts on #tracksSvg children (SVG fallback
under swiftshader) and state.dataTracks presence.
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


def _base_config(style, features, track_id="data-synth"):
    """Minimal viewer config with one data track of the given style."""
    color = "#2b6fff"
    return {
        "region": "chr1:100000-100900",
        "genome_build": "hg38",
        "reference_data": "A" * 900,
        "genes_track": {"id": "genes", "label": "Genes", "style": "gene",
                        "series": [{"name": "genes", "features": []}]},
        "repeats_track": {"id": "repeats", "label": "RepeatMasker", "style": "interval",
                          "series": [{"name": "repeats", "features": []}]},
        "ideogram_data": [],
        "variant_tracks": [],
        "data_bounds": {"start": 100000, "end": 100900},
        "data_tracks": [{
            "id": track_id,
            "label": f"synth-{style}",
            "style": style,
            "y_scale": "linear",
            "y_min": None,
            "y_max": None,
            "color": color,
            "height": 80 if style != "interval" else 30,
            "minHeight": 40 if style != "interval" else 18,
            "callable": False,
            "series": [{
                "name": "value",
                "color": color,
                "features": features,
            }],
        }],
    }


def _gpu_counts(page):
    """Primitives the tracks canvas holds from its last paint (WebGPU instances)."""
    page.wait_for_function("() => window.__GS_TEST_gpuStats && window.__GS_TEST_gpuStats().ready")
    page.evaluate("() => window.__GS_TEST_renderAll()")
    return page.evaluate("() => window.__GS_TEST_gpuStats().tracks")


def _delta_vs_empty(browser, tmp_path, style, feats, kind):
    """`kind` primitives the data track adds over an identical page whose track
    has no features (the reference bases alone already emit rects)."""
    page, errors = _open(browser, tmp_path, _base_config(style, feats))
    _wait_ready(page)
    with_feats = _gpu_counts(page)[kind]
    assert errors == [], errors
    page.close()
    page, errors = _open(browser, tmp_path, _base_config(style, []))
    _wait_ready(page)
    without = _gpu_counts(page)[kind]
    page.close()
    return with_feats - without


def test_data_track_line_renders_polyline(browser, tmp_path):
    feats = [
        {"start": 100100, "end": 100101, "value": 1.0},
        {"start": 100300, "end": 100301, "value": 3.0},
        {"start": 100500, "end": 100501, "value": 2.0},
        {"start": 100700, "end": 100701, "value": 4.0},
    ]
    page, errors = _open(browser, tmp_path, _base_config("line", feats))
    _wait_ready(page)
    assert page.evaluate("() => !!(window.__GS_STATE && window.__GS_STATE.dataTracks && window.__GS_STATE.dataTracks.length)")
    assert page.evaluate(
        "() => window.__GS_STATE.tracks.some(t => t.id === 'data-synth')"
    )
    assert errors == [], errors
    page.close()
    # A line series is drawn as one GPU line segment between consecutive points.
    n = _delta_vs_empty(browser, tmp_path, "line", feats, "lines")
    assert n >= len(feats) - 1, f"expected >= {len(feats) - 1} line segments, got {n}"


def test_data_track_bar_renders_rects(browser, tmp_path):
    feats = [
        {"start": 100100, "end": 100150, "value": 1.0},
        {"start": 100300, "end": 100350, "value": 2.5},
        {"start": 100500, "end": 100550, "value": 0.5},
    ]
    page, errors = _open(browser, tmp_path, _base_config("bar", feats))
    _wait_ready(page)
    assert errors == [], errors
    page.close()
    n = _delta_vs_empty(browser, tmp_path, "bar", feats, "rectangles")
    assert n >= len(feats), f"expected >= {len(feats)} bar rects, got {n}"


def test_data_track_scatter_renders_circles(browser, tmp_path):
    feats = [
        {"start": 100200, "end": 100201, "value": 1.0},
        {"start": 100400, "end": 100401, "value": 2.0},
        {"start": 100600, "end": 100601, "value": 3.0},
    ]
    page, errors = _open(browser, tmp_path, _base_config("scatter", feats))
    _wait_ready(page)
    assert errors == [], errors
    page.close()
    n = _delta_vs_empty(browser, tmp_path, "scatter", feats, "rectangles")
    assert n >= len(feats), f"expected >= {len(feats)} scatter marks, got {n}"


def test_data_track_interval_renders_rects(browser, tmp_path):
    feats = [
        {"start": 100100, "end": 100250, "label": "A"},
        {"start": 100400, "end": 100600, "label": "B"},
    ]
    page, errors = _open(browser, tmp_path, _base_config("interval", feats))
    _wait_ready(page)
    assert errors == [], errors
    page.close()
    n = _delta_vs_empty(browser, tmp_path, "interval", feats, "rectangles")
    assert n >= len(feats), f"expected >= {len(feats)} interval rects, got {n}"
