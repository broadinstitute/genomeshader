"""Tests for the anywidget host (cross-environment transport).

The browser rendering can't be tested headless; these cover the Python contract:
the ESM assembles with the model-backed transport (and without the classic
comm), the widget's reads message handler round-trips through
_fetch_reads_payload, and show()/show_widget wire the inlined config into the
widget and display it.
"""
import os
import sys
from unittest.mock import Mock, patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
pytest.importorskip("genomeshader.genomeshader")
pytest.importorskip("anywidget")

import genomeshader as G
from genomeshader.widget import _build_esm, GenomeShaderWidget


def test_esm_uses_model_transport_not_classic_comm():
    esm = _build_esm()
    assert "export default" in esm and "__runViewer__" in esm
    assert "window.__GS_SEND" in esm            # model-backed transport installed
    assert "function sendCommMessage" in esm    # widget-comms.js drop-in present
    assert "model.on('msg:custom'" in esm
    # the classic-Notebook comm call (jupyter-comms.js setupComm) must be gone
    assert "comm_manager.new_comm" not in esm


def test_widget_reads_response():
    shader = Mock()
    shader._fetch_reads_payload.return_value = {
        "reads": {"sample_name": ["S1"]}, "count": 1,
        "bam_urls": ["gs://b/S1.bam"], "vcf_samples": ["S1"], "sample_id": "S1"}
    w = GenomeShaderWidget(shader, config={}, view_id="v")
    sent = []
    w.send = lambda m, *a, **k: sent.append(m)

    w._on_custom_msg(w, {"type": "fetch_reads", "request_id": "r1", "sample_id": "S1",
                         "locus": "chr1:100-200"}, [])
    assert sent[0]["type"] == "fetch_reads_response"
    assert sent[0]["request_id"] == "r1" and sent[0]["count"] == 1
    # Reads must be fetched for the CURRENTLY VIEWED window (passed from the
    # client), not the server's stale last-rendered locus.
    shader._fetch_reads_payload.assert_called_once_with(
        sample_id="S1", samples=None, locus="chr1:100-200", bam_url=None)


def test_widget_reads_error():
    shader = Mock()
    shader._fetch_reads_payload.side_effect = ValueError("No locus available")
    w = GenomeShaderWidget(shader, config={}, view_id="v")
    sent = []
    w.send = lambda m, *a, **k: sent.append(m)
    w._on_custom_msg(w, {"type": "fetch_reads", "request_id": "r2"}, [])
    assert sent[0]["type"] == "fetch_reads_error" and "locus" in sent[0]["error"]


def test_widget_ignores_unrelated_messages():
    w = GenomeShaderWidget(Mock(), config={}, view_id="v")
    sent = []
    w.send = lambda m, *a, **k: sent.append(m)
    w._on_custom_msg(w, {"type": "something_else"}, [])
    w._on_custom_msg(w, "not-a-dict", [])
    assert sent == []


def _shader(tmp_path, monkeypatch):
    monkeypatch.setenv("GENOMESHADER_LOCAL_CACHE_DIR", str(tmp_path))
    with patch("genomeshader.view.gs._init", return_value=Mock()):
        return G.GenomeShader(genome_build="PlasmoDB-61_Pfalciparum3D7",
                              gcs_session_dir="gs://test-bucket/genomeshader")


def test_show_widget_wires_inlined_config(tmp_path, monkeypatch):
    s = _shader(tmp_path, monkeypatch)

    def fake_render(locus, inline_payload=False, **k):
        assert inline_payload is True            # widget path must inline the payload
        s._last_config = {"genome_build": "X", "region": locus}
        s._last_view_id = "vid123"
        return ""
    s.render = fake_render

    fake_widget = Mock()
    order = []

    def _clear(*_a, **k):
        order.append("clear")

    def _make_widget(*_a, **k):
        order.append("widget")
        return fake_widget

    with patch("genomeshader.widget.GenomeShaderWidget", side_effect=_make_widget) as WCls, \
         patch("IPython.display.clear_output", side_effect=_clear) as clr, \
         patch("IPython.display.display") as disp:
        result = s.show_widget("Pf3D7_01_v3:1-100")

    # Widget built from the inlined config and RETURNED (the notebook displays the
    # return value once). It must NOT also be display()'d — a second mount would
    # run a second viewer that collides over shared globals. Progress output is
    # cleared immediately, and *before* the anywidget comm opens — a deferred
    # clear_output(wait=True) races show()'s timing print and destroys the model.
    _, kwargs = WCls.call_args
    assert kwargs["config"] == {"genome_build": "X", "region": "Pf3D7_01_v3:1-100"}
    assert kwargs["view_id"] == "vid123"
    clr.assert_called_once()
    assert clr.call_args.kwargs.get("wait") is not True
    assert order == ["clear", "widget"]
    assert result is fake_widget
    assert not any(c.args and c.args[0] is fake_widget for c in disp.call_args_list)


def test_show_widget_closes_previous_widget(tmp_path, monkeypatch):
    s = _shader(tmp_path, monkeypatch)

    def fake_render(locus, inline_payload=False, **k):
        s._last_config = {"region": locus}
        s._last_view_id = "v"
        return ""
    s.render = fake_render
    first, second = Mock(), Mock()
    s._active_widget = first
    with patch("genomeshader.widget.GenomeShaderWidget", return_value=second), \
         patch("IPython.display.clear_output"), \
         patch("IPython.display.display"):
        result = s.show_widget("chr20:1-100")
    first.close.assert_called_once()
    assert result is second
    assert s._active_widget is second


def test_show_delegates_to_widget(tmp_path, monkeypatch):
    s = _shader(tmp_path, monkeypatch)
    s.show_widget = Mock(return_value="W")
    assert s.show("Pf3D7_01_v3:1-100") == "W"
    s.show_widget.assert_called_once_with("Pf3D7_01_v3:1-100")


def test_esm_includes_comments_ui():
    esm = _build_esm()
    assert "__GS_renderCommentPins" in esm      # locus-track pins hook
    assert "comments_create" in esm             # comm bridge from the UI


def test_esm_viewer_height_is_tall():
    # Notebook viewer gets plenty of vertical room (regressed to 600 once).
    esm = _build_esm()
    assert "height:1200px" in esm


def _body_html():
    from genomeshader.widget import _html_dir
    return (_html_dir() / "body.html").read_text(encoding="utf-8")


def test_no_right_panel_settings_button():
    # Settings live in the left panel; the right command strip must not carry a
    # Settings button (it switched to a nonexistent tab).
    body = _body_html()
    assert 'data-tab="settings"' not in body       # right strip uses data-tab=...
    assert 'data-left-tab="settings"' in body       # left panel settings tab stays


def test_strategy_order_best_evidence_first():
    # Read-selection strategy: Best evidence is the default (first), Random last.
    body = _body_html()
    assert body.index('value="best_evidence"') < body.index('value="random"')
    assert "strategy: 'best_evidence'" in _build_esm()   # JS state default (raw in ESM)


def test_comment_store_crud(tmp_path, monkeypatch):
    # Point the session dir at a local folder so the store uses its os fallback.
    s = _shader(tmp_path, monkeypatch)
    s.gcs_session_dir = str(tmp_path / "session")
    monkeypatch.setenv("GENOMESHADER_USER", "alice@lab")

    c = s.create_comment(
        {"type": "variant", "ref": "chr1:100", "locus": {"contig": "chr1", "pos": 100},
         "sample": "HG002"}, "Looks like a **real** het.")
    assert c["author"] == "alice@lab"
    assert c["anchor"]["sample"] == "HG002"
    assert c["created"] == c["updated"] and len(c["history"]) == 1

    c2 = s.update_comment(c["id"], body="Confirmed het.")
    assert c2["body"] == "Confirmed het." and c2["updated"] >= c2["created"]
    assert len(c2["history"]) == 2

    assert [x["id"] for x in s.list_comments()] == [c["id"]]
    assert s.delete_comment(c["id"]) is True
    assert s.list_comments() == []


def test_comment_replies(tmp_path, monkeypatch):
    s = _shader(tmp_path, monkeypatch)
    s.gcs_session_dir = str(tmp_path / "session")
    monkeypatch.setenv("GENOMESHADER_USER", "alice@lab")
    c = s.create_comment({"type": "region", "ref": "chr1:1-9",
                          "locus": {"contig": "chr1", "pos": 5}}, "thread start")

    r = s.reply_comment(c["id"], "a reply", author="bob@lab")
    assert len(r["replies"]) == 1
    assert r["replies"][0]["author"] == "bob@lab" and r["replies"][0]["body"] == "a reply"
    assert r["updated"] >= r["created"]           # activity bumped
    assert r["replies"][0]["id"] != c["id"]

    r2 = s.reply_comment(c["id"], "second", author="alice@lab")
    assert [x["author"] for x in r2["replies"]] == ["bob@lab", "alice@lab"]
    # persisted
    assert s.list_comments()[0]["replies"][1]["body"] == "second"
    # unknown id -> None
    assert s.reply_comment("nope", "x") is None

    # delete one reply
    rid = r2["replies"][0]["id"]
    r3 = s.delete_reply(c["id"], rid)
    assert [x["body"] for x in r3["replies"]] == ["second"]
    assert s.list_comments()[0]["replies"] == r3["replies"]
    # deleting a missing reply is a no-op (returns the comment unchanged)
    assert len(s.delete_reply(c["id"], "gone")["replies"]) == 1


def test_widget_comments_reply_comm(tmp_path, monkeypatch):
    s = _shader(tmp_path, monkeypatch)
    s.gcs_session_dir = str(tmp_path / "session")
    w = GenomeShaderWidget(s, config={}, view_id="v")
    sent = []
    w.send = lambda m, *a, **k: sent.append(m)
    w._on_custom_msg(w, {"type": "comments_create", "request_id": "c1",
                         "anchor": {"type": "region", "locus": {"contig": "chr1", "pos": 5}},
                         "body": "note"}, [])
    cid = sent[-1]["comment"]["id"]
    w._on_custom_msg(w, {"type": "comments_reply", "request_id": "c2",
                         "id": cid, "body": "reply!", "author": "bob@lab"}, [])
    assert sent[-1]["action"] == "reply"
    assert sent[-1]["comment"]["replies"][0]["body"] == "reply!"


def test_credential_refresh_publishes_token(tmp_path, monkeypatch):
    s = _shader(tmp_path, monkeypatch)
    monkeypatch.delenv("GCS_OAUTH_TOKEN", raising=False)
    monkeypatch.delenv("CLOUDSDK_AUTH_ACCESS_TOKEN", raising=False)
    # Force the CLI fallback path with a known token (no real ADC in tests).
    monkeypatch.setattr(type(s), "_mint_token_subprocess", lambda self: "TOK123")

    delay, ok = s._refresh_gcs_token_once()
    assert ok is True
    assert os.environ["GCS_OAUTH_TOKEN"] == "TOK123"
    assert os.environ["CLOUDSDK_AUTH_ACCESS_TOKEN"] == "TOK123"
    assert 60 <= delay <= 3600

    # No token available -> failure, back off, don't crash.
    monkeypatch.setattr(type(s), "_mint_token_subprocess", lambda self: None)
    s._cred_refresh_last_error = None
    delay2, ok2 = s._refresh_gcs_token_once()
    assert ok2 is False and delay2 == 300


def test_credential_refresh_thread_lifecycle(tmp_path, monkeypatch):
    s = _shader(tmp_path, monkeypatch)
    monkeypatch.setattr(type(s), "_mint_token_subprocess", lambda self: "TOK")
    # long interval so the loop refreshes once then parks on the stop event
    t = s.start_credential_refresh(interval_seconds=3600, verbose=False)
    assert t.is_alive()
    assert s.start_credential_refresh() is t          # idempotent
    s.stop_credential_refresh()
    assert s._cred_refresh_stop.is_set()


def test_comment_read_state_blob(tmp_path, monkeypatch):
    s = _shader(tmp_path, monkeypatch)
    s.gcs_session_dir = str(tmp_path / "session")
    monkeypatch.setenv("GENOMESHADER_USER", "alice@lab")
    assert s.get_comment_read_state() == {}                       # empty by default
    assert s.set_comment_read_state({"c1": "2026-01-01T00:00:00+00:00"}) is True
    assert s.get_comment_read_state() == {"c1": "2026-01-01T00:00:00+00:00"}
    # per-user: bob has his own, independent blob
    monkeypatch.setenv("GENOMESHADER_USER", "bob@lab")
    assert s.get_comment_read_state() == {}
    # read-state file must NOT pollute the comment listing
    s.create_comment({"type": "region", "locus": {"contig": "chr1", "pos": 5}}, "x")
    assert all("read" not in (c.get("body", "") or "") for c in s.list_comments())
    assert len(s.list_comments()) == 1


def test_widget_comments_read_comm(tmp_path, monkeypatch):
    s = _shader(tmp_path, monkeypatch)
    s.gcs_session_dir = str(tmp_path / "session")
    w = GenomeShaderWidget(s, config={}, view_id="v")
    sent = []
    w.send = lambda m, *a, **k: sent.append(m)
    w._on_custom_msg(w, {"type": "comments_read_set", "request_id": "r1",
                         "seen": {"c1": "2026-05-01T00:00:00+00:00"}}, [])
    assert sent[-1]["type"] == "comments_read_saved" and sent[-1]["ok"] is True
    w._on_custom_msg(w, {"type": "comments_read_get", "request_id": "r2"}, [])
    assert sent[-1]["type"] == "comments_read_state"
    assert sent[-1]["seen"] == {"c1": "2026-05-01T00:00:00+00:00"}


def test_widget_comments_comm_roundtrip(tmp_path, monkeypatch):
    s = _shader(tmp_path, monkeypatch)
    s.gcs_session_dir = str(tmp_path / "session")
    w = GenomeShaderWidget(s, config={}, view_id="v")
    sent = []
    w.send = lambda m, *a, **k: sent.append(m)

    w._on_custom_msg(w, {"type": "comments_create", "request_id": "c1",
                         "anchor": {"type": "region", "ref": "chr1:1-9",
                                    "locus": {"contig": "chr1", "pos": 5}},
                         "body": "note"}, [])
    assert sent[-1]["type"] == "comments_changed" and sent[-1]["action"] == "create"
    cid = sent[-1]["comment"]["id"]

    w._on_custom_msg(w, {"type": "comments_list", "request_id": "c2"}, [])
    assert sent[-1]["type"] == "comments_response"
    assert [c["id"] for c in sent[-1]["comments"]] == [cid]

    w._on_custom_msg(w, {"type": "comments_delete", "request_id": "c3", "id": cid}, [])
    assert sent[-1]["action"] == "delete" and sent[-1]["ok"] is True


def test_widget_comment_author_and_anchor_passthrough(tmp_path, monkeypatch):
    # The dialog supplies an explicit author + a chosen anchor type (e.g. sample);
    # both must be stored on the comment.
    s = _shader(tmp_path, monkeypatch)
    s.gcs_session_dir = str(tmp_path / "session")
    w = GenomeShaderWidget(s, config={}, view_id="v")
    sent = []
    w.send = lambda m, *a, **k: sent.append(m)
    w._on_custom_msg(w, {"type": "comments_create", "request_id": "a1",
                         "anchor": {"type": "sample", "ref": "HG002", "sample": "HG002",
                                    "locus": {"contig": "chr1", "pos": 5}},
                         "body": "note", "author": "Dr. Real <dr@lab>"}, [])
    c = sent[-1]["comment"]
    assert c["author"] == "Dr. Real <dr@lab>"
    assert c["anchor"]["type"] == "sample" and c["anchor"]["sample"] == "HG002"


def test_reads_payload_disk_cache(tmp_path, monkeypatch):
    # Second fetch of the same (locus, bam set) is served from local disk — the
    # Rust fetch runs exactly once.
    import polars as pl
    s = _shader(tmp_path, monkeypatch)
    s._last_locus = "Pf3D7_01_v3:1-100"
    s.set_sample_mapping({"S1": ["gs://b/S1.bam"]})
    s.reference = Mock(return_value="")  # no staged ref in test => ref_seq passed as None
    s._session.fetch_reads_for_locus = Mock(
        return_value=pl.DataFrame({"sample_name": ["S1"], "reference_start": [7]}))

    p1 = s._fetch_reads_payload(sample_id="S1")
    p2 = s._fetch_reads_payload(sample_id="S1")
    assert p1["reads"] == p2["reads"] and p1["count"] == p2["count"] == 1
    s._session.fetch_reads_for_locus.assert_called_once()  # 2nd call hit the cache

    # Bypass flag forces a re-fetch.
    monkeypatch.setenv("GENOMESHADER_NO_READS_CACHE", "1")
    s._fetch_reads_payload(sample_id="S1")
    assert s._session.fetch_reads_for_locus.call_count == 2


def test_widget_reads_through_real_payload(tmp_path, monkeypatch):
    # widget message -> real GenomeShader._fetch_reads_payload -> mocked BAM fetch
    import polars as pl
    s = _shader(tmp_path, monkeypatch)
    s._last_locus = "Pf3D7_01_v3:1-100"
    s.set_sample_mapping({"S1": ["gs://b/S1.bam"]})
    s.reference = Mock(return_value="")  # no staged ref => ref_seq None, ref_start = locus start
    s._session.fetch_reads_for_locus = Mock(
        return_value=pl.DataFrame({"sample_name": ["S1"], "reference_start": [7]}))

    w = GenomeShaderWidget(s, config={}, view_id="v")
    sent = []
    w.send = lambda m, *a, **k: sent.append(m)
    w._on_custom_msg(w, {"type": "fetch_reads", "request_id": "r", "sample_id": "S1"}, [])

    assert sent[0]["type"] == "fetch_reads_response"
    assert sent[0]["bam_urls"] == ["gs://b/S1.bam"] and sent[0]["count"] == 1
    s._session.fetch_reads_for_locus.assert_called_once_with(
        "Pf3D7_01_v3:1-100", ["gs://b/S1.bam"], None, 1)


def test_staged_reference_forwarded_to_fetch(tmp_path, monkeypatch):
    # When a reference is staged for the locus, it's fetched (0-based start-1) and
    # forwarded to the Rust extractor so it can call SNPs without MD tags.
    import polars as pl
    s = _shader(tmp_path, monkeypatch)
    s._last_locus = "Pf3D7_01_v3:100-200"
    s.set_sample_mapping({"S1": ["gs://b/S1.bam"]})
    s.reference = Mock(return_value="ACGTACGT")
    s._session.fetch_reads_for_locus = Mock(
        return_value=pl.DataFrame({"sample_name": ["S1"], "reference_start": [100]}))

    s._fetch_reads_payload(sample_id="S1")
    # reference() called 0-based: start-1 .. end
    s.reference.assert_called_once_with("Pf3D7_01_v3", 99, 200)
    # ref_seq forwarded verbatim; ref_start is the 1-based locus start (100).
    s._session.fetch_reads_for_locus.assert_called_once_with(
        "Pf3D7_01_v3:100-200", ["gs://b/S1.bam"], "ACGTACGT", 100)


def test_reads_payload_filters_to_requested_bam_url(tmp_path, monkeypatch):
    # Multi-BAM samples fetch one file at a time when bam_url is set (one track
    # per BAM on the frontend).
    import polars as pl
    s = _shader(tmp_path, monkeypatch)
    s._last_locus = "Pf3D7_01_v3:1-100"
    s.set_sample_mapping({"S1": ["gs://b/S1_long.bam", "gs://b/S1_short.bam"]})
    s.reference = Mock(return_value="")
    s._session.fetch_reads_for_locus = Mock(
        return_value=pl.DataFrame({"sample_name": ["S1"], "reference_start": [7]}))

    p = s._fetch_reads_payload(sample_id="S1", bam_url="gs://b/S1_long.bam")
    assert p["bam_urls"] == ["gs://b/S1_long.bam"] and p["count"] == 1
    s._session.fetch_reads_for_locus.assert_called_once_with(
        "Pf3D7_01_v3:1-100", ["gs://b/S1_long.bam"], None, 1)


def test_reads_payload_skips_sample_without_bam(tmp_path, monkeypatch):
    # VCF-only samples must not raise — Load draws only from attached BAMs.
    s = _shader(tmp_path, monkeypatch)
    s._last_locus = "chr20:32005000-32006800"
    s._session.get_attached_reads = Mock(return_value=["gs://b/HG001.bam"])
    s._session.fetch_reads_for_locus = Mock()
    p = s._fetch_reads_payload(sample_id="HG005")
    assert p["count"] == 0 and p["bam_urls"] == [] and p["sample_id"] == "HG005"
    s._session.fetch_reads_for_locus.assert_not_called()


def test_fetch_carriers_comm_handler(tmp_path, monkeypatch):
    # fetch_carriers message -> GenomeShader.fetch_carriers -> carriers response.
    from unittest.mock import Mock
    s = _shader(tmp_path, monkeypatch)
    s.fetch_carriers = Mock(return_value=["FP1", "FP2", "FP3"])
    w = GenomeShaderWidget(s, config={}, view_id="v")
    sent = []
    w.send = lambda m, *a, **k: sent.append(m)
    w._on_custom_msg(w, {
        "type": "fetch_carriers", "request_id": "r1",
        "contig": "Pf3D7_01_v3", "pos": 100315, "ref": "G", "allele": "A",
        "track_id": 0, "strategy": "random", "n": 50,
    }, [])
    assert sent and sent[0]["type"] == "fetch_carriers_response"
    assert sent[0]["carriers"] == ["FP1", "FP2", "FP3"]
    s.fetch_carriers.assert_called_once_with(
        contig="Pf3D7_01_v3", pos=100315, ref="G", allele="A",
        track_id=0, strategy="random", n=50)


def test_fetch_carriers_handler_surfaces_error(tmp_path, monkeypatch):
    from unittest.mock import Mock
    s = _shader(tmp_path, monkeypatch)
    s.fetch_carriers = Mock(side_effect=RuntimeError("boom"))
    w = GenomeShaderWidget(s, config={}, view_id="v")
    sent = []
    w.send = lambda m, *a, **k: sent.append(m)
    w._on_custom_msg(w, {"type": "fetch_carriers", "request_id": "r2",
                         "contig": "c", "pos": 1, "ref": "A", "allele": "T"}, [])
    assert sent[0]["type"] == "fetch_carriers_error" and sent[0]["carriers"] == []


def test_fetch_variants_comm_handler(tmp_path, monkeypatch):
    from unittest.mock import Mock
    s = _shader(tmp_path, monkeypatch)
    s.fetch_variants_payload = Mock(return_value={
        "variant_tracks": [{"id": "flow-0", "variants_data": []}],
        "insertion_variants_lookup": [], "region": {"contig": "c", "start": 1, "end": 9},
        "aggregate": True})
    w = GenomeShaderWidget(s, config={}, view_id="v")
    sent = []
    w.send = lambda m, *a, **k: sent.append(m)
    w._on_custom_msg(w, {"type": "fetch_variants", "request_id": "r",
                         "contig": "c", "start": 1, "end": 9}, [])
    assert sent[0]["type"] == "fetch_variants_response"
    assert sent[0]["aggregate"] is True and sent[0]["region"]["end"] == 9
    s.fetch_variants_payload.assert_called_once_with("c", 1, 9)


def test_fetch_track_data_comm_handler_offloads(tmp_path, monkeypatch):
    """fetch_track_data is submitted to a thread pool (not run on the comm thread)."""
    import threading
    import time
    from unittest.mock import Mock
    import genomeshader.widget as W

    s = _shader(tmp_path, monkeypatch)
    saw_worker = threading.Event()
    main_ident = threading.get_ident()

    def _payload(track_id, contig, start, end, max_points=2000):
        if threading.get_ident() != main_ident:
            saw_worker.set()
        return {
            "track_id": track_id,
            "style": "line",
            "y_scale": "linear",
            "y_min": None,
            "y_max": None,
            "series": [{"name": "value", "color": "#2b6fff", "features": []}],
        }

    s.fetch_track_data_payload = Mock(side_effect=_payload)
    s._report_fetch_failure = Mock(return_value="hint")
    w = GenomeShaderWidget(s, config={}, view_id="v")
    sent = []
    w.send = lambda m, *a, **k: sent.append(m)

    # Force send path to be direct (no tornado) so the test can observe messages.
    monkeypatch.setattr(W, "_send_on_ioloop", lambda widget, msg: widget.send(msg))

    w._on_custom_msg(w, {
        "type": "fetch_track_data", "request_id": "td1",
        "track_id": "data-gwas", "contig": "chr1", "start": 1, "end": 100,
        "max_points": 500,
    }, [])
    # Handler returned without blocking — wait briefly for the worker.
    deadline = time.time() + 2.0
    while time.time() < deadline and not sent:
        time.sleep(0.02)
    assert sent, "expected fetch_track_data_response from worker"
    assert sent[0]["type"] == "fetch_track_data_response"
    assert sent[0]["request_id"] == "td1"
    assert sent[0]["track_id"] == "data-gwas"
    assert saw_worker.is_set(), "fetch should run off the comm thread"
    s.fetch_track_data_payload.assert_called_once()


def test_fetch_track_data_comm_handler_error(tmp_path, monkeypatch):
    import time
    from unittest.mock import Mock
    import genomeshader.widget as W

    s = _shader(tmp_path, monkeypatch)
    s.fetch_track_data_payload = Mock(side_effect=RuntimeError("boom"))
    s._report_fetch_failure = Mock(return_value="try again")
    w = GenomeShaderWidget(s, config={}, view_id="v")
    sent = []
    w.send = lambda m, *a, **k: sent.append(m)
    monkeypatch.setattr(W, "_send_on_ioloop", lambda widget, msg: widget.send(msg))

    w._on_custom_msg(w, {
        "type": "fetch_track_data", "request_id": "td2",
        "track_id": "data-x", "contig": "chr1", "start": 1, "end": 9,
    }, [])
    deadline = time.time() + 2.0
    while time.time() < deadline and not sent:
        time.sleep(0.02)
    assert sent[0]["type"] == "fetch_track_data_error"
    assert "boom" in sent[0]["error"]
    assert sent[0]["hint"] == "try again"
