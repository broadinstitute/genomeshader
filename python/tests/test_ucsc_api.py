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
from genomeshader.view import _ucsc_groups_for_tracks


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


def test_ucsc_groups_fallback_labels_and_order():
    groups = _ucsc_groups_for_tracks([
        {"group": "varRep"},
        {"group": "genes"},
        {"group": ""},
        {"group": "hprc"},
    ])
    ids = [g["id"] for g in groups]
    assert ids == ["genes", "varRep", "hprc", ""]
    by_id = {g["id"]: g["label"] for g in groups}
    assert by_id["genes"] == "Genes and Gene Predictions"
    assert by_id["varRep"] == "Variation"
    assert by_id[""] == "Other"


def test_ucsc_groups_prefer_fetched_grp_rows():
    groups = _ucsc_groups_for_tracks(
        [{"group": "genes"}, {"group": "mystery"}],
        fetched=[
            {"id": "genes", "label": "Custom Genes Name", "priority": 1},
            {"id": "unused", "label": "Not Present", "priority": 0},
        ],
    )
    by_id = {g["id"]: g["label"] for g in groups}
    assert by_id["genes"] == "Custom Genes Name"
    assert "unused" not in by_id
    assert by_id["mystery"] == "mystery"


def test_list_ucsc_tracks_keeps_group_and_drops_signal(tmp_path, monkeypatch):
    s = _shader(tmp_path, monkeypatch, genome="hg38")

    class Resp:
        status_code = 200

        def json(self):
            return {"hg38": {
                "wgEncodeGencodeV50": {
                    "shortLabel": "All GENCODE V50",
                    "longLabel": "GENCODE V50 comprehensive",
                    "type": "genePred",
                    "group": "genes",
                },
                "noyvertSv": {
                    "shortLabel": "1KG Boehringer ONT SVs",
                    "type": "bigBed 9 +",
                    "group": "varRep",
                },
                "phyloP100way": {
                    "shortLabel": "Cons 100 Vert",
                    "type": "bigWig",
                    "group": "compGeno",
                },
            }}

    with patch.object(s, "_http_get_json", return_value=Resp()), \
         patch.object(s, "_fetch_ucsc_grp", return_value=[
             {"id": "genes", "label": "Genes and Gene Predictions", "priority": 3},
             {"id": "varRep", "label": "Variation", "priority": 3.55},
         ]):
        payload = s.list_ucsc_tracks("hg38")
    assert payload is not None
    tracks = payload["tracks"]
    assert [t["track"] for t in tracks] == ["noyvertSv", "wgEncodeGencodeV50"]
    gencode = tracks[1]
    assert gencode["group"] == "genes"
    assert gencode["longLabel"] == "GENCODE V50 comprehensive"
    assert [g["id"] for g in payload["groups"]] == ["genes", "varRep"]
