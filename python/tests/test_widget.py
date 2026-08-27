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
    with patch("genomeshader.widget.GenomeShaderWidget", return_value=fake_widget) as WCls:
        out = s.show_widget("Pf3D7_01_v3:1-100")

    # Returns the widget (Jupyter displays it as the cell's last expression).
    assert out is fake_widget
    _, kwargs = WCls.call_args
    assert kwargs["config"] == {"genome_build": "X", "region": "Pf3D7_01_v3:1-100"}
    assert kwargs["view_id"] == "vid123"


def test_show_delegates_to_widget(tmp_path, monkeypatch):
    s = _shader(tmp_path, monkeypatch)
    s.show_widget = Mock(return_value="W")
    assert s.show("Pf3D7_01_v3:1-100") == "W"
    s.show_widget.assert_called_once_with("Pf3D7_01_v3:1-100")


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
