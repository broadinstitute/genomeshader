"""Requester Pays / billing-project wiring (view.py).

AoU (and some Terra) buckets require a user project on every request. On a
Verily Workbench VM that is `$GOOGLE_PROJECT` — the same value passed to
`gsutil -u $GOOGLE_PROJECT`. These tests cover resolution, env publish, and
the gcloud/gsutil argv shape without talking to GCS.
"""
import os
import sys
from unittest.mock import Mock, patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
pytest.importorskip("genomeshader.genomeshader")

from genomeshader.view import GenomeShader


_BILLING_ENVS = (
    "GENOMESHADER_GCS_BILLING_PROJECT",
    "GCS_REQUESTER_PAYS_PROJECT",
    "CLOUDSDK_BILLING_PROJECT",
    "GOOGLE_PROJECT",
    "GOOGLE_CLOUD_PROJECT",
    "GCLOUD_PROJECT",
    "CLOUDSDK_CORE_PROJECT",
)


def _clear_billing_env(monkeypatch):
    for key in _BILLING_ENVS:
        monkeypatch.delenv(key, raising=False)


def test_resolve_prefers_explicit_over_google_project():
    env = {"GOOGLE_PROJECT": "workbench", "GCS_REQUESTER_PAYS_PROJECT": "htslib"}
    assert GenomeShader._resolve_gcs_billing_project("explicit", environ=env) == "explicit"
    assert GenomeShader._resolve_gcs_billing_project(environ=env) == "htslib"


def test_resolve_uses_google_project_like_workbench():
    env = {"GOOGLE_PROJECT": "workbench-proj"}
    assert GenomeShader._resolve_gcs_billing_project(environ=env) == "workbench-proj"


def test_resolve_skips_blank():
    env = {"GCS_REQUESTER_PAYS_PROJECT": "  ", "GOOGLE_CLOUD_PROJECT": "gcp"}
    assert GenomeShader._resolve_gcs_billing_project(environ=env) == "gcp"
    assert GenomeShader._resolve_gcs_billing_project(environ={}) is None


def test_gcloud_cmd_is_gsutil_u_equivalent():
    cmd = GenomeShader._gcloud_storage_cmd(
        "cp", "gs://b/a", "dst", billing_project="my-proj", quiet=True
    )
    assert cmd[0] == "gcloud"
    assert "--quiet" in cmd
    assert "--billing-project=my-proj" in cmd
    assert cmd[cmd.index("storage") + 1:] == ["cp", "gs://b/a", "dst"]


def test_gsutil_cmd_matches_workbench_u_flag():
    cmd = GenomeShader._gsutil_cmd("cp", "gs://b/a", "dst", billing_project="my-proj")
    assert cmd[:5] == ["gsutil", "-u", "my-proj", "cp", "gs://b/a"]
    quiet = GenomeShader._gsutil_cmd("cp", "src", "dst", billing_project="p", quiet=True)
    assert quiet[:4] == ["gsutil", "-u", "p", "-q"]


def test_gsutil_cmd_none_omits_u_even_if_env_set():
    cmd = GenomeShader._gsutil_cmd("ls", "gs://b/a", billing_project=None)
    assert cmd == ["gsutil", "ls", "gs://b/a"]
    gcloud = GenomeShader._gcloud_storage_cmd("ls", "gs://b/a", billing_project=None)
    assert all(not a.startswith("--billing-project") for a in gcloud)


def test_constructor_publishes_google_project(tmp_path, monkeypatch):
    _clear_billing_env(monkeypatch)
    monkeypatch.setenv("GENOMESHADER_NO_CRED_REFRESH", "1")
    monkeypatch.setenv("GOOGLE_PROJECT", "workbench-123")
    monkeypatch.setenv("GENOMESHADER_LOCAL_CACHE_DIR", str(tmp_path))
    # So the constructor's os.environ writes are restored after this test.
    monkeypatch.setenv("GCS_REQUESTER_PAYS_PROJECT", "")
    monkeypatch.setenv("CLOUDSDK_BILLING_PROJECT", "")
    with patch("genomeshader.view.gs._init", return_value=Mock()):
        s = GenomeShader(
            genome_build="hg38",
            gcs_session_dir="gs://test-bucket/genomeshader",
        )
    assert s._gcs_billing_project == "workbench-123"
    assert os.environ["GCS_REQUESTER_PAYS_PROJECT"] == "workbench-123"
    assert os.environ["CLOUDSDK_BILLING_PROJECT"] == "workbench-123"


def test_constructor_explicit_billing_project_wins(tmp_path, monkeypatch):
    _clear_billing_env(monkeypatch)
    monkeypatch.setenv("GENOMESHADER_NO_CRED_REFRESH", "1")
    monkeypatch.setenv("GOOGLE_PROJECT", "workbench-123")
    monkeypatch.setenv("GENOMESHADER_LOCAL_CACHE_DIR", str(tmp_path))
    monkeypatch.setenv("GCS_REQUESTER_PAYS_PROJECT", "")
    monkeypatch.setenv("CLOUDSDK_BILLING_PROJECT", "")
    with patch("genomeshader.view.gs._init", return_value=Mock()):
        s = GenomeShader(
            genome_build="hg38",
            gcs_session_dir="gs://test-bucket/genomeshader",
            gcs_billing_project="explicit-proj",
        )
    assert s._gcs_billing_project == "explicit-proj"
    assert os.environ["GCS_REQUESTER_PAYS_PROJECT"] == "explicit-proj"
