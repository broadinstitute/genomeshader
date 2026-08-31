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

    w._on_custom_msg(w, {"type": "fetch_reads", "request_id": "r1", "sample_id": "S1"}, [])
    assert sent[0]["type"] == "fetch_reads_response"
    assert sent[0]["request_id"] == "r1" and sent[0]["count"] == 1
    shader._fetch_reads_payload.assert_called_once_with(sample_id="S1", samples=None)


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
    with patch("genomeshader.widget.GenomeShaderWidget", return_value=fake_widget) as WCls, \
         patch("IPython.display.clear_output") as clr, \
         patch("IPython.display.display") as disp:
        result = s.show_widget("Pf3D7_01_v3:1-100")

    # Widget built from the inlined config and RETURNED (the notebook displays the
    # return value once). It must NOT also be display()'d — a second mount would
    # run a second viewer that collides over shared globals. clear_output(wait=True)
    # un-buries the progress bar/stdout.
    _, kwargs = WCls.call_args
    assert kwargs["config"] == {"genome_build": "X", "region": "Pf3D7_01_v3:1-100"}
    assert kwargs["view_id"] == "vid123"
    clr.assert_called_once()
    assert result is fake_widget
    assert not any(c.args and c.args[0] is fake_widget for c in disp.call_args_list)


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
    s._session.fetch_reads_for_locus = Mock(
        return_value=pl.DataFrame({"sample_name": ["S1"], "reference_start": [7]}))

    w = GenomeShaderWidget(s, config={}, view_id="v")
    sent = []
    w.send = lambda m, *a, **k: sent.append(m)
    w._on_custom_msg(w, {"type": "fetch_reads", "request_id": "r", "sample_id": "S1"}, [])

    assert sent[0]["type"] == "fetch_reads_response"
    assert sent[0]["bam_urls"] == ["gs://b/S1.bam"] and sent[0]["count"] == 1
    s._session.fetch_reads_for_locus.assert_called_once_with("Pf3D7_01_v3:1-100", ["gs://b/S1.bam"])
