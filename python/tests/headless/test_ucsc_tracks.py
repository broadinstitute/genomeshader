"""UCSC Tracks pane: grouped catalog, version families, pinned enabled tracks."""
import os
import sys
import tempfile

import pytest

sys.path.insert(0, os.path.dirname(__file__))
pytest.importorskip("playwright")
pytest.importorskip("anywidget")

from playwright.sync_api import sync_playwright  # noqa: E402
import harness  # noqa: E402

_TRACKS = [
    {"track": "wgEncodeGencodeV50", "label": "All GENCODE V50", "type": "genepred",
     "group": "genes", "longLabel": "GENCODE V50"},
    {"track": "wgEncodeGencodeV22", "label": "All GENCODE V22", "type": "genepred",
     "group": "genes", "longLabel": "GENCODE V22"},
    {"track": "noyvertSv", "label": "1KG Boehringer ONT SVs", "type": "bigbed 9 +",
     "group": "varRep", "longLabel": "1KG SVs"},
    {"track": "rmsk", "label": "RepeatMasker", "type": "bed",
     "group": "rep", "longLabel": "Repeating Elements"},
]
_GROUPS = [
    {"id": "genes", "label": "Genes and Gene Predictions", "priority": 3},
    {"id": "varRep", "label": "Variation", "priority": 3.55},
    {"id": "rep", "label": "Repeats", "priority": 8},
]


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as pw:
        try:
            b = pw.chromium.launch(args=harness.CHROMIUM_ARGS)
        except Exception as e:
            pytest.skip(f"headless chromium unavailable: {e}")
        yield b
        b.close()


def _open(page):
    page.add_init_script("try{localStorage.setItem('genomeshader.theme','light');}catch(e){}")
    f = os.path.join(tempfile.mkdtemp(), "h.html")
    open(f, "w").write(harness.build_page())
    page.goto("file://" + f, wait_until="load")
    page.wait_for_function("() => window.__GS_READY === true", timeout=20000)
    page.evaluate(
        """(a) => window.__GS_TEST_ucscSetListing(a.genome, a.tracks, a.groups)""",
        {"genome": "hg38", "tracks": _TRACKS, "groups": _GROUPS},
    )


def test_ucsc_tracks_grouped_with_version_family(browser):
    page = browser.new_page(viewport={"width": 1200, "height": 900})
    _open(page)
    g = page.evaluate(
        """() => {
             const groups = [...document.querySelectorAll('.ucsc-track-group')].map(el => ({
               label: el.querySelector('summary span')?.textContent,
               count: el.querySelector('.ucsc-track-group-count')?.textContent,
               open: el.open,
               rows: [...el.querySelectorAll('.ucsc-track-group-body > .ucsc-track-row span')].map(s => s.textContent),
               more: el.querySelector('.ucsc-track-family-more')?.textContent || null,
             }));
             return {
               groups,
               family: window.__GS_TEST_ucscVersionFamily('All GENCODE V50'),
               snp: window.__GS_TEST_ucscVersionFamily('All SNPs(141)'),
             };
        }""")
    labels = [x["label"] for x in g["groups"]]
    assert labels == ["Genes and Gene Predictions", "Variation", "Repeats"], g
    assert all(x["open"] is False for x in g["groups"]), g
    genes = g["groups"][0]
    assert genes["count"] == "2", genes
    assert genes["rows"] == ["All GENCODE V50"], genes
    assert genes["more"] == "1 older version", genes
    assert g["family"] == {"prefix": "All GENCODE", "version": 50}, g
    assert g["snp"] == {"prefix": "All SNPs", "version": 141}, g
    page.close()


def test_ucsc_filter_opens_matches_and_pin_moves_enabled(browser):
    page = browser.new_page(viewport={"width": 1200, "height": 900})
    _open(page)
    page.evaluate(
        """() => {
             const input = document.querySelector('.ucsc-track-filter');
             input.value = 'gencode';
             input.dispatchEvent(new Event('input', { bubbles: true }));
        }""")
    filtered = page.evaluate(
        """() => {
             const groups = [...document.querySelectorAll('.ucsc-track-group')];
             return {
               labels: groups.map(el => el.querySelector('summary span')?.textContent),
               open: groups.map(el => el.open),
               rows: [...document.querySelectorAll('.ucsc-track-row span')].map(s => s.textContent),
             };
        }""")
    assert filtered["labels"] == ["Genes and Gene Predictions"], filtered
    assert filtered["open"] == [True], filtered
    assert "All GENCODE V50" in filtered["rows"] and "All GENCODE V22" in filtered["rows"], filtered

    page.evaluate(
        """() => {
             const input = document.querySelector('.ucsc-track-filter');
             input.value = '';
             input.dispatchEvent(new Event('input', { bubbles: true }));
             const row = [...document.querySelectorAll('.ucsc-track-row')]
               .find(el => el.textContent.includes('RepeatMasker'));
             row.querySelector('input[type=checkbox]').click();
        }""")
    pinned = page.evaluate(
        """() => {
             const pin = document.querySelector('.ucsc-track-enabled');
             const groups = [...document.querySelectorAll('.ucsc-track-group')].map(el =>
               el.querySelector('summary span')?.textContent);
             return {
               pinRows: pin ? [...pin.querySelectorAll('.ucsc-track-row span')].map(s => s.textContent) : [],
               groups,
             };
        }""")
    assert pinned["pinRows"] == ["RepeatMasker"], pinned
    assert "Repeats" not in pinned["groups"], pinned
    assert "Genes and Gene Predictions" in pinned["groups"], pinned
    page.close()
