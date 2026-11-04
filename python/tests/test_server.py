"""Local HTTP API: transport-neutral dispatch + the standalone viewer server."""
import json
import math
import os
import sys
import urllib.error
import urllib.request
from unittest.mock import Mock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
pytest.importorskip("genomeshader.genomeshader")
pytest.importorskip("anywidget")

from genomeshader.dispatch import HANDLERS, dispatch
from genomeshader.server import ViewerServer, encode_json
from genomeshader.widget import build_standalone_page


@pytest.fixture
def server():
    shader = Mock()
    srv = ViewerServer(shader).start()
    yield srv, shader
    srv.stop()


def _post(srv, body, token=None, raw=None):
    data = raw if raw is not None else json.dumps(body).encode()
    req = urllib.request.Request(srv.base_url + "/api", data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    if token is not None:
        req.add_header("X-GS-Token", token)
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, r.read(), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read(), dict(e.headers)


def test_dispatch_unknown_and_fire_and_forget():
    shader = Mock()
    assert dispatch(shader, {"type": "nope"}) == (None, None)
    assert dispatch(shader, "not-a-dict") == (None, None)
    assert dispatch(shader, {"type": "debug_log", "event": "x", "fields": {"a": 1}}) == (None, None)
    shader._debug_log.assert_called_once_with("frontend.x", a=1)


def test_dispatch_covers_every_comm_type():
    expected = {
        "fetch_reads", "fetch_reads_batch", "fetch_carriers", "fetch_variants",
        "fetch_track_data", "navigate", "resolve_feature", "debug_log", "clear_cache",
        "ucsc_genomes", "ucsc_list", "ucsc_track", "comments_list", "comments_create",
        "comments_update", "comments_reply", "comments_reply_delete", "comments_read_get",
        "comments_read_set", "comments_delete",
    }
    assert set(HANDLERS) == expected


def test_api_requires_token(server):
    srv, shader = server
    status, _, _ = _post(srv, {"type": "resolve_feature", "query": "BRCA1"})
    assert status == 403
    status, _, _ = _post(srv, {"type": "resolve_feature", "query": "BRCA1"}, token="wrong")
    assert status == 403
    shader.resolve_feature.assert_not_called()


def test_api_round_trip(server):
    srv, shader = server
    shader.resolve_feature.return_value = [{"name": "BRCA1", "contig": "chr17"}]
    status, body, headers = _post(
        srv, {"type": "resolve_feature", "request_id": "r1", "query": "BRCA1"}, token=srv.token)
    assert status == 200
    msg = json.loads(body)
    assert msg == {"type": "resolve_feature_response", "request_id": "r1",
                   "matches": [{"name": "BRCA1", "contig": "chr17"}]}
    # Same-origin only: no CORS grant on the API.
    assert "Access-Control-Allow-Origin" not in headers


def test_api_reads_error_is_a_response_not_a_500(server):
    srv, shader = server
    shader._fetch_reads_payload.side_effect = ValueError("No locus available")
    shader._report_fetch_failure.return_value = "hint"
    status, body, _ = _post(srv, {"type": "fetch_reads", "request_id": "r2"}, token=srv.token)
    assert status == 200
    msg = json.loads(body)
    assert msg["type"] == "fetch_reads_error" and "locus" in msg["error"] and msg["hint"] == "hint"


def test_api_rejects_bad_requests(server):
    srv, _ = server
    assert _post(srv, {"type": "nope"}, token=srv.token)[0] == 400
    assert _post(srv, None, token=srv.token, raw=b"{not json")[0] == 400
    assert _post(srv, None, token=srv.token, raw=b"[1,2]")[0] == 400


def test_api_debug_log_is_204(server):
    srv, _ = server
    status, body, _ = _post(srv, {"type": "debug_log", "event": "e"}, token=srv.token)
    assert status == 204 and body == b""


def test_api_never_encodes_binary_reads(server):
    srv, shader = server
    shader._fetch_reads_batch_payload.return_value = [
        {"reads": {"query_name": ["a"]}, "count": 1, "sample_id": "S1"}]
    status, body, _ = _post(srv, {"type": "fetch_reads_batch", "request_id": "b",
                                  "items": [{}], "accept_binary": True}, token=srv.token)
    assert status == 200
    item = json.loads(body)["items"][0]
    assert item["reads"]["query_name"] == ["a"] and "reads_bin" not in item


def test_view_pages(server):
    srv, _ = server
    path = srv.add_page("<html>hello</html>")
    with urllib.request.urlopen(srv.base_url + path, timeout=5) as r:
        assert r.status == 200 and r.read() == b"<html>hello</html>"
        assert r.headers["Content-Type"].startswith("text/html")
    with pytest.raises(urllib.error.HTTPError) as e:
        urllib.request.urlopen(srv.base_url + "/view/guess", timeout=5)
    assert e.value.code == 404


def test_encode_json_is_strict():
    np = pytest.importorskip("numpy")
    out = json.loads(encode_json({"a": float("nan"), "b": [math.inf, 1.5],
                                  "c": np.int64(7), "d": np.float32(float("nan")),
                                  "e": np.array([1, 2])}))
    assert out == {"a": None, "b": [None, 1.5], "c": 7, "d": None, "e": [1, 2]}


def test_standalone_page_escapes_config_and_wires_transport():
    html = build_standalone_page({"label": "</script><script>alert(1)</script>"},
                                 "run-1", "TOKEN", width=800, height=600)
    assert "</script><script>alert(1)" not in html
    assert "X-GS-Token" in html and '"TOKEN"' in html
    assert "new URL('../api', window.location.href)" in html
    assert "width:800px;height:600px" in html
    assert "async function __runViewer__(rootEl)" in html
    # The viewer's own font, not the browser's default serif.
    assert "font-family:ui-sans-serif,system-ui" in html
    # The page uses the HTTP transport, never the classic Notebook comm.
    assert "comm_manager.new_comm" not in html


def test_figure_page_drops_label_pill_shadows():
    # Printed to PDF, a shadowed pill over a WebGPU canvas becomes a gray box.
    fig = build_standalone_page({}, "v", "T", figure=True)
    assert ".track-controls { box-shadow:none !important;" in fig
    assert "box-shadow:none" not in build_standalone_page({}, "v", "T")


def test_serve_returns_page_backed_by_session(tmp_path, monkeypatch):
    from unittest.mock import patch
    import genomeshader as G

    monkeypatch.setenv("GENOMESHADER_LOCAL_CACHE_DIR", str(tmp_path))
    with patch("genomeshader.view.gs._init", return_value=Mock()):
        s = G.GenomeShader(genome_build="PlasmoDB-61_Pfalciparum3D7",
                           gcs_session_dir="gs://test-bucket/genomeshader")

    def fake_render(locus, inline_payload=False):
        s._last_config = {"region": locus, "comm_available": False,
                          "viewport_variant_loading": False}
        s._last_view_id = "v1"
        return ""

    monkeypatch.setattr(s, "render", fake_render)
    url = s.serve("chr1:1-100", width=640, height=480)
    try:
        assert url.startswith("http://127.0.0.1:") and "/view/" in url
        with urllib.request.urlopen(url, timeout=5) as r:
            page = r.read().decode()
        assert '"comm_available": true' in page and '"viewport_variant_loading": true' in page
        assert s.viewer_server() is s.viewer_server()
    finally:
        s.viewer_server().stop()
