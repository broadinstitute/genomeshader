"""The standalone page talks to the session over the local HTTP API.

Unlike the other headless tests, nothing here mocks `__GS_SEND` in the page: the
viewer is served by a real ViewerServer and every request goes page -> POST /api
-> dispatch -> a Python session double -> back to the page.
"""
from __future__ import annotations

import os
import sys
import threading
from unittest.mock import Mock

import pytest

sys.path.insert(0, os.path.dirname(__file__))
pytest.importorskip("playwright")
from playwright.sync_api import sync_playwright  # noqa: E402
import harness  # noqa: E402,F401  (puts the source tree on sys.path)

from genomeshader.server import ViewerServer  # noqa: E402
from genomeshader.widget import build_standalone_page  # noqa: E402

import reads_mock  # noqa: E402

CHR14_CONTIG = (31988132, 32254546)


class FakeSession:
    """Answers reads like a BAM holding one whole-locus contig per haplotype;
    every other session method is a Mock."""

    def __init__(self):
        self.batches = []
        self.fail_samples = set()
        self._lock = threading.Lock()
        self._mock = Mock()

    def __getattr__(self, name):
        return getattr(self._mock, name)

    def _fetch_reads_batch_payload(self, items):
        with self._lock:
            self.batches.append(items)
        out = []
        for it in items:
            contig, _, span = (it.get("locus") or "").partition(":")
            s, _, e = span.partition("-")
            s, e = int(s or 0), int(e or 0)
            bam = it.get("bam_url") or ""
            sample = it.get("sample_id")
            if sample in self.fail_samples:
                out.append({"error": f"simulated fetch failure for {sample}"})
                continue
            q, rs, re_ = [], [], []
            if contig == "chr14" and CHR14_CONTIG[1] >= s and CHR14_CONTIG[0] <= e:
                q.append(f"{sample}#{1 if '.hap1.' in bam else 2}#chr14")
                rs.append(CHR14_CONTIG[0])
                re_.append(CHR14_CONTIG[1])
            n = len(q)
            out.append({
                "reads": {
                    "query_name": q, "element_type": [0] * n, "reference_start": rs,
                    "reference_end": re_, "is_forward": [True] * n, "haplotype": [0] * n,
                    "sample_name": [sample] * n, "sequence": [""] * n, "sa_tag": [""] * n,
                    "mate_contig": [""] * n, "mate_pos": [0] * n, "has_md": [True] * n,
                },
                "count": n, "bam_urls": [bam] if bam else [], "sample_id": sample,
            })
        return out

    def resolve_feature(self, query):
        return [{"name": query, "contig": "chr14", "start": 32147950, "end": 32151950}]


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
def served():
    session = FakeSession()
    srv = ViewerServer(session).start()
    html = build_standalone_page(reads_mock.CFG, "gswidget", srv.token, width=1400, height=900)
    url = srv.base_url + srv.add_page(html)
    yield session, srv, url
    srv.stop()


def _open(browser, url):
    page = browser.new_page(viewport={"width": 1400, "height": 900})
    page.add_init_script(
        "try{localStorage.removeItem('genomeshader.lockView');"
        "localStorage.removeItem('genomeshader.panZoom');"
        "localStorage.setItem('genomeshader.orientation','horizontal');}catch(e){}"
    )
    page.goto(url, wait_until="load")
    page.wait_for_function("() => window.__GS_READY === true || !!window.__GS_ERR", timeout=30000)
    assert page.evaluate("() => window.__GS_ERR") is None
    return page


def test_send_round_trips_through_the_session(browser, served):
    session, _, url = served
    page = _open(browser, url)
    resp = page.evaluate("() => window.__GS_SEND('resolve_feature', {query: 'NOVA1'})")
    assert resp["type"] == "resolve_feature_response"
    assert resp["matches"][0]["name"] == "NOVA1"
    page.close()


def test_reads_load_over_http(browser, served):
    session, _, url = served
    page = _open(browser, url)
    page.evaluate("() => __GS_TEST_spawnSample('SYN001', 'best_evidence')")
    page.wait_for_function(
        """() => { const d = window.__GS_TEST_readsRaceDump();
          return d.fetchActive === 0 && (d.queuedKeys || []).length === 0
            && (d.readLoadsInFlight || 0) === 0 && !d.schedulerPending; }""",
        timeout=30000,
    )
    items = [it for batch in session.batches for it in batch]
    assert items, "viewer never asked the session for reads"
    assert {it["sample_id"] for it in items} == {"SYN001"}
    assert all(it["locus"].startswith("chr14:") for it in items)
    # JSON-only transport: the page must not ask for binary columns.
    assert not any(it.get("accept_binary") for it in items)
    page.close()


def test_api_rejects_requests_from_other_origins(browser, served):
    """A page on another origin cannot call the API even if it knows the URL."""
    _, srv, _ = served
    page = browser.new_page()
    page.goto("about:blank")
    status = page.evaluate(
        """(api) => fetch(api, {method: 'POST', headers: {'Content-Type': 'application/json'},
                 body: JSON.stringify({type: 'resolve_feature', query: 'x'})})
              .then(r => r.status, e => 'blocked')""",
        srv.base_url + "/api",
    )
    assert status in (403, "blocked")
    page.close()
