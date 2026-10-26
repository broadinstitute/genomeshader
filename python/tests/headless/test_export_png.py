"""Static PNG export: the real viewer, real Chrome, reads over the local API."""
from __future__ import annotations

import io
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(__file__))
pytest.importorskip("playwright")
PIL = pytest.importorskip("PIL")
from PIL import Image  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402
import harness  # noqa: E402

from genomeshader.export import export_locus_figure  # noqa: E402
from genomeshader.server import ViewerServer  # noqa: E402

import reads_mock  # noqa: E402
from test_http_transport import FakeSession  # noqa: E402


READ_SETS = {
    "labels": [{"name": "hap1set", "count": 2, "color": "#1f77b4"},
               {"name": "hap2set", "count": 2, "color": "#d62728"}],
    "by_url": {reads_mock.HAP1_001: "hap1set", reads_mock.HAP1_002: "hap1set",
               reads_mock.HAP2_001: "hap2set", reads_mock.HAP2_002: "hap2set"},
}


class ExportSession(FakeSession):
    def render(self, locus, inline_payload=False):
        self._last_config = dict(reads_mock.CFG, region=locus, read_sets=READ_SETS)
        self._last_view_id = "export"
        return ""

    def viewer_server(self):
        if "_srv" not in self.__dict__:
            self._srv = ViewerServer(self).start()
        return self._srv


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as pw:
        try:
            b = pw.chromium.launch(args=harness.CHROMIUM_ARGS)
        except Exception as e:  # pragma: no cover
            pytest.skip(f"headless chromium unavailable: {e}")
        yield b
        b.close()


@pytest.fixture
def session():
    s = ExportSession()
    yield s
    if "_srv" in s.__dict__:
        s._srv.stop()


def _export(session, browser, tmp_path, name, samples=("SYN001", "SYN002")):
    return export_locus_figure(session, "chr14:32147950-32151950", tmp_path / name,
                            samples=list(samples), width=1200, height=800,
                            seed="BI_164_2__chr14_32149950", browser=browser)


def test_export_writes_a_painted_png(session, browser, tmp_path):
    out = _export(session, browser, tmp_path, "locus.png")
    img = Image.open(out["path"]).convert("RGB")
    assert img.size == (2400, 1600)  # 1200x800 CSS px at the default device_scale=2
    colors = img.getcolors(maxcolors=1 << 20) or []
    assert len(colors) > 20, "image is (nearly) blank"
    # One track per BAM, in sample order, each with its reads.
    assert [t["sample"] for t in out["tracks"]] == ["SYN001", "SYN001", "SYN002", "SYN002"]
    assert all(t["reads"] > 0 for t in out["tracks"])
    assert out["page_errors"] == []
    requested = {it["sample_id"] for batch in session.batches for it in batch}
    assert requested == {"SYN001", "SYN002"}


def test_export_is_deterministic(session, browser, tmp_path):
    a = _export(session, browser, tmp_path, "a.png")
    b = _export(session, browser, tmp_path, "b.png")
    from PIL import ImageChops
    assert a["tracks"] == b["tracks"]
    # Same picture; the compositor occasionally rounds a blended pixel by one
    # level between runs, so allow that rather than demanding identical bytes.
    diff = ImageChops.difference(Image.open(a["path"]).convert("RGB"),
                                 Image.open(b["path"]).convert("RGB"))
    assert max(hi for _, hi in diff.getextrema()) <= 2


def test_export_without_samples_still_renders(session, browser, tmp_path):
    out = _export(session, browser, tmp_path, "empty.png", samples=())
    assert out["tracks"] == [] and os.path.getsize(out["path"]) > 0
    assert out["errors"] == [] and out["warnings"] == []


def test_pdf_export(session, browser, tmp_path):
    out = export_locus_figure(session, "chr14:32147950-32151950", tmp_path / "locus.pdf",
                              samples=["SYN001"], width=1200, height=None, browser=browser)
    data = open(out["path"], "rb").read()
    assert data.startswith(b"%PDF") and len(data) > 10_000
    # Headless Chrome prints vector PDF; headed (lavapipe CI) wraps a screenshot.
    assert out["format"] in ("pdf", "pdf-raster") and out["errors"] == []


def test_rejects_unknown_suffix(session, browser, tmp_path):
    with pytest.raises(ValueError):
        export_locus_figure(session, "chr14:1-100", tmp_path / "x.svg", browser=browser)


def test_read_set_keeps_one_bam_per_sample(session, browser, tmp_path):
    out = export_locus_figure(session, "chr14:32147950-32151950", tmp_path / "rs.png",
                           samples=["SYN001", "SYN002"], width=1200, height=800,
                           read_set="hap1set", browser=browser)
    assert [(t["sample"], t["bam"]) for t in out["tracks"]] == [
        ("SYN001", reads_mock.HAP1_001), ("SYN002", reads_mock.HAP1_002)]
    assert out["errors"] == []


def test_fixed_height_reports_clipping_and_none_fits(session, browser, tmp_path):
    clipped = export_locus_figure(session, "chr14:32147950-32151950", tmp_path / "short.png",
                               samples=["SYN001", "SYN002"], width=1200, height=450,
                               browser=browser)
    assert clipped["warnings"] and "cut off" in clipped["warnings"][0]
    assert Image.open(clipped["path"]).size == (2400, 900)
    fit = export_locus_figure(session, "chr14:32147950-32151950", tmp_path / "fit.png",
                           samples=["SYN001", "SYN002"], width=1200, height=None,
                           browser=browser)
    assert fit["warnings"] == []
    w, h = Image.open(fit["path"]).size
    assert w == 2400 and h > 900


def test_failed_fetch_is_reported_not_painted(session, browser, tmp_path):
    session.fail_samples = {"SYN002"}
    out = _export(session, browser, tmp_path, "fail.png")
    assert any("Failed to load reads" in e and "SYN002" in e for e in out["errors"])
    assert "no read track for SYN002" in out["errors"]
    assert [t["sample"] for t in out["tracks"]] == ["SYN001", "SYN001"]
