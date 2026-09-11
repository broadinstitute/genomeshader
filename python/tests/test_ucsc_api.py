"""Default UCSC annotation fetches (cytoband / genes / RepeatMasker).

hg38 should hit the UCSC API on cache miss without an env var. Staged local
genomes (PlasmoDB chrom_sizes) stay offline. allow_ucsc_api=False / env=0
force the old opt-in-off behavior.
"""
import os
import sys
from unittest.mock import Mock, patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
pytest.importorskip("genomeshader.genomeshader")

from genomeshader.view import GenomeShader, init as gs_init


def _shader(tmp_path, monkeypatch, **kwargs):
    monkeypatch.setenv("GENOMESHADER_LOCAL_CACHE_DIR", str(tmp_path))
    monkeypatch.delenv("GENOMESHADER_ALLOW_UCSC_API", raising=False)
    with patch("genomeshader.view.gs._init", return_value=Mock()):
        s = GenomeShader(
            genome_build=kwargs.pop("genome_build", "hg38"),
            gcs_session_dir="gs://test-bucket/genomeshader",
            **kwargs,
        )
    s._gcs_read_json = lambda *a, **k: None
    s._gcs_write_json = lambda *a, **k: True
    return s


def test_hg38_enables_ucsc_without_env(tmp_path, monkeypatch):
    s = _shader(tmp_path, monkeypatch, genome="hg38")
    assert s._ucsc_api_enabled() is True


def test_omitted_genome_does_not_hit_ucsc(tmp_path, monkeypatch):
    s = _shader(tmp_path, monkeypatch, genome_build=None)
    assert s.genome_build is None
    assert s._ucsc_api_enabled() is False
    with patch.object(s, "_http_get_json", side_effect=AssertionError("UCSC API")):
        assert s.genes("chr20", 1, 100) == []


def test_init_genome_kwarg(tmp_path, monkeypatch):
    monkeypatch.setenv("GENOMESHADER_LOCAL_CACHE_DIR", str(tmp_path))
    monkeypatch.delenv("GENOMESHADER_ALLOW_UCSC_API", raising=False)
    with patch("genomeshader.view.gs._init", return_value=Mock()):
        s = gs_init("gs://test-bucket/genomeshader", genome="hg38")
    assert s.genome_build == "hg38"
    assert s._ucsc_api_enabled() is True


def test_stage_genome_uses_fasta_not_ucsc(tmp_path, monkeypatch):
    fa = tmp_path / "Pf3D7.fasta"
    fa.write_text(">chr1\nACGTACGT\n")
    s = _shader(tmp_path, monkeypatch, genome_build=None)
    s.stage_genome(str(fa), verbose=False)
    assert s.genome_build == "Pf3D7"
    assert s._genome_from_fasta is True
    assert s._ucsc_api_enabled() is False
    assert s.reference("chr1", 0, 4) == "ACGT"


def test_constructor_false_disables_ucsc(tmp_path, monkeypatch):
    s = _shader(tmp_path, monkeypatch, allow_ucsc_api=False)
    assert s._ucsc_api_enabled() is False
    assert s.genes("chr20", 1, 100) == []
    assert s.repeats("chr20", 1, 100) == []
    assert s.ideogram("chr20") == []
    assert s.reference("chr20", 1, 10) == ""


def test_env_zero_disables_ucsc(tmp_path, monkeypatch):
    monkeypatch.setenv("GENOMESHADER_ALLOW_UCSC_API", "0")
    monkeypatch.setenv("GENOMESHADER_LOCAL_CACHE_DIR", str(tmp_path))
    with patch("genomeshader.view.gs._init", return_value=Mock()):
        s = GenomeShader(genome_build="hg38",
                         gcs_session_dir="gs://test-bucket/genomeshader")
    assert s._ucsc_api_enabled() is False


def test_constructor_overrides_env(tmp_path, monkeypatch):
    monkeypatch.setenv("GENOMESHADER_ALLOW_UCSC_API", "0")
    s = _shader(tmp_path, monkeypatch, allow_ucsc_api=True)
    assert s._ucsc_api_enabled() is True


def test_staged_chrom_sizes_skip_ucsc(tmp_path, monkeypatch):
    s = _shader(tmp_path, monkeypatch, genome_build="PlasmoDB-61_Pfalciparum3D7")
    s._chrom_sizes_memo = {"Pf3D7_01_v3": 100}
    assert s._ucsc_api_enabled() is False
    # Cache miss must not call UCSC.
    with patch.object(s, "_http_get_json", side_effect=AssertionError("UCSC API")):
        assert s.genes("Pf3D7_01_v3", 1, 50) == []


def test_init_passes_allow_ucsc_api(tmp_path, monkeypatch):
    monkeypatch.setenv("GENOMESHADER_LOCAL_CACHE_DIR", str(tmp_path))
    monkeypatch.delenv("GENOMESHADER_ALLOW_UCSC_API", raising=False)
    with patch("genomeshader.view.gs._init", return_value=Mock()):
        s = gs_init("gs://test-bucket/genomeshader", allow_ucsc_api=False)
    assert s.genome_build is None
    assert s._ucsc_api_enabled() is False
