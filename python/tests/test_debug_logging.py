"""Debug logging + data-fetch failure reporting (view.py).

debug is off by default (no file, no-op logging). When on, events land as JSON
lines in a per-session log file, and a fetch failure is both logged and printed
to stderr (under the cell) with a remediation hint chosen from the error text.
Bound to a stub so no compiled extension / GCS session is needed.
"""
import types
from unittest.mock import Mock, patch

import pytest

from genomeshader.view import GenomeShader


def test_real_construction_with_debug_does_not_crash(tmp_path, monkeypatch):
    """debug=True must not crash __init__. _setup_debug_logging runs at the top
    of __init__, before genome_build/gcs_session_dir are assigned, so it must
    read them defensively (regression: AttributeError on genome_build)."""
    monkeypatch.chdir(tmp_path)
    with patch("genomeshader.view.gs._init", return_value=Mock()):
        s = GenomeShader(genome_build="hg38",
                         gcs_session_dir="gs://test-bucket/genomeshader", debug=True)
    assert s._debug is True
    # logs live in a dedicated (gitignored) subdir, not the cwd/repo root
    assert s._debug_log_path and list(tmp_path.glob("genomeshader_logs/genomeshader_debug_*.log"))
    assert "genomeshader_logs" in s._debug_log_path


def test_real_construction_without_debug_writes_no_file(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    with patch("genomeshader.view.gs._init", return_value=Mock()):
        s = GenomeShader(genome_build="hg38", gcs_session_dir="gs://test-bucket/genomeshader")
    assert s._debug is False
    assert s._debug_log_path is None
    assert list(tmp_path.glob("genomeshader_debug_*.log")) == []


def _stub(debug):
    o = types.SimpleNamespace()
    o._debug = debug
    o._debug_logger = None
    o._debug_log_path = None
    o.genome_build = "hg38"
    o.gcs_session_dir = "gs://bucket/gs"
    for m in ("_setup_debug_logging", "_debug_log", "_report_fetch_failure"):
        setattr(o, m, types.MethodType(getattr(GenomeShader, m), o))
    o._fetch_failure_hint = GenomeShader._fetch_failure_hint
    o._setup_debug_logging()
    return o


def test_off_by_default_writes_nothing(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    o = _stub(debug=False)
    o._debug_log("fetch_variants", n=1)
    o._report_fetch_failure("variants", RuntimeError("boom"), locus="chr1:1-2")
    assert o._debug_log_path is None
    assert list(tmp_path.glob("genomeshader_debug_*.log")) == []


def test_on_writes_events_and_failure(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    o = _stub(debug=True)
    o._debug_log("fetch_variants", locus="chr1:1-100", n_variants=42, ms=13.3)
    hint = o._report_fetch_failure("variants", RuntimeError("Request timeout"), locus="chr1:1-100")

    body = open(o._debug_log_path).read()
    assert "session_start" in body
    assert '"n_variants": 42' in body
    assert "fetch_failure" in body
    assert "timeout" in hint.lower()
    # printed under the cell (stderr)
    err = capsys.readouterr().err
    assert "GenomeShader ERROR: failed to load variants for chr1:1-100" in err
    assert hint in err


@pytest.mark.parametrize("msg,needle", [
    ("Request timed out after 30s", "timeout"),
    ("permission denied (403)", "auth"),
    ("file not found", "index"),
    ("comm transport not ready", "connection"),
    ("something weird", "debug"),
])
def test_hint_matches_error(msg, needle):
    assert needle in GenomeShader._fetch_failure_hint("variants", msg).lower()
