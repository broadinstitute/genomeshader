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

from genomeshader.export import export_locus_png  # noqa: E402
from genomeshader.server import ViewerServer  # noqa: E402

import reads_mock  # noqa: E402
from test_http_transport import FakeSession  # noqa: E402


class ExportSession(FakeSession):
    def render(self, locus, inline_payload=False):
        self._last_config = dict(reads_mock.CFG, region=locus)
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
    return export_locus_png(session, "chr14:32147950-32151950", tmp_path / name,
                            samples=list(samples), width=1200, height=800,
                            seed="BI_164_2__chr14_32149950", browser=browser)


def test_export_writes_a_painted_png(session, browser, tmp_path):
    out = _export(session, browser, tmp_path, "locus.png")
    img = Image.open(out["path"]).convert("RGB")
    assert img.size == (1200, 800)
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
    pa = Image.open(a["path"]).convert("RGB").tobytes()
    pb = Image.open(b["path"]).convert("RGB").tobytes()
    assert pa == pb


def test_export_without_samples_still_renders(session, browser, tmp_path):
    out = _export(session, browser, tmp_path, "empty.png", samples=())
    assert out["tracks"] == [] and os.path.getsize(out["path"]) > 0
