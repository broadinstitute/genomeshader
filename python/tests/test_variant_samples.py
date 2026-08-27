"""Tests for variant sample subsetting + bidirectional sample reconciliation.

Uses the committed bgzipped+indexed fixture tests/fixtures/tiny.vcf.gz (samples
S1, S2; variants at chr1:100/200/300/400). Exercises the native _vcf_sample_names
/ _extract_variants entry points and the GenomeShader-level reconciliation with
the session mocked.
"""
import os
import sys
import warnings
from unittest.mock import Mock, patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
pytest.importorskip("genomeshader.genomeshader")

import genomeshader.genomeshader as gs
from genomeshader.view import GenomeShader

FIXTURE = os.path.abspath(os.path.join(
    os.path.dirname(__file__), "..", "..", "tests", "fixtures", "tiny.vcf.gz"))


# --------------------------------------------------------------------------- #
# native entry points                                                         #
# --------------------------------------------------------------------------- #

def test_vcf_sample_names():
    assert gs._vcf_sample_names(FIXTURE) == ["S1", "S2"]


def test_extract_variants_sample_subset():
    full = gs._extract_variants(FIXTURE, "chr1", 1, 1000)          # both samples
    one = gs._extract_variants(FIXTURE, "chr1", 1, 1000, None, ["S1"])
    assert full.height == 8 and one.height == 4
    assert set(one["sample_name"].to_list()) == {"S1"}


# --------------------------------------------------------------------------- #
# GenomeShader reconciliation (session mocked)                                #
# --------------------------------------------------------------------------- #

@pytest.fixture
def shader(monkeypatch, tmp_path):
    monkeypatch.setenv("GENOMESHADER_LOCAL_CACHE_DIR", str(tmp_path))
    with patch("genomeshader.view.gs._init", return_value=Mock()):
        yield GenomeShader(genome_build="PlasmoDB-61_Pfalciparum3D7",
                           gcs_session_dir="gs://test-bucket/genomeshader")


def test_attach_variants_subset_passed_and_universe(shader):
    shader.attach_variants("t", FIXTURE, samples=["S1"])
    # subset forwarded to the native session as the 3rd positional arg
    _, _, subset = shader._session.attach_variants.call_args.args
    assert subset == ["S1"]
    assert shader._vcf_sample_universe == {"S1"}


def test_attach_variants_all_samples_universe(shader):
    shader.attach_variants("t", FIXTURE)
    assert shader._vcf_sample_universe == {"S1", "S2"}


def test_requested_sample_absent_warns(shader):
    with pytest.warns(UserWarning, match="GHOST"):
        shader.attach_variants("t", FIXTURE, samples=["S1", "GHOST"])
    _, _, subset = shader._session.attach_variants.call_args.args
    assert subset == ["S1"]                       # GHOST dropped


def test_reconcile_reads_warns_on_excluded_sample(shader):
    shader._vcf_sample_universe = {"S1"}
    shader._session.get_bam_sample_names.return_value = ["S1", "S2"]
    with pytest.warns(UserWarning, match="S2"):
        shader._reconcile_read_samples()


def test_reconcile_noop_without_variants(shader):
    # No variant universe yet -> nothing to reconcile, no warning, no error.
    shader._session.get_bam_sample_names.return_value = ["S1", "S2"]
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        shader._reconcile_read_samples()
