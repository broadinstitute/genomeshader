"""attach_assemblies: haploid → unphased BAM, diploid → phased BAM.

A haploid assembly is one BAM/CRAM aligned to the reference; a diploid
assembly is two. They reuse the read pileup: haplotype 0 (grey / unphased)
vs haplotypes 1 and 2 (HP:i:1 / HP:i:2 coloring), regardless of HP tags
or @RG SM in the files. The first argument is a dataset label, like
attach_reads.
"""
from unittest.mock import Mock, patch

import warnings

import pytest

pytest.importorskip("genomeshader.genomeshader")

import genomeshader as G
from genomeshader.view import GenomeShader


@pytest.fixture
def shader(tmp_path, monkeypatch):
    monkeypatch.setenv("GENOMESHADER_LOCAL_CACHE_DIR", str(tmp_path))
    monkeypatch.setenv("GENOMESHADER_NO_READS_CACHE", "1")
    with patch("genomeshader.view.gs._init", return_value=Mock()):
        yield G.GenomeShader(
            genome_build="PlasmoDB-61_Pfalciparum3D7",
            gcs_session_dir="gs://test-bucket/genomeshader",
        )


def test_haploid_looks_like_unphased_bam(shader):
    shader.attach_assemblies("hifiasm_haploid", "gs://b/SYN_HAP.bam")
    assert shader._assemblies["SYN_HAP"]["ploidy"] == 1
    assert shader._assemblies["SYN_HAP"]["label"] == "hifiasm_haploid"
    assert shader._sample_mapping["SYN_HAP"] == ["gs://b/SYN_HAP.bam"]
    assert shader._assembly_haplotype_for("gs://b/SYN_HAP.bam") == 0
    assert shader._assembly_sample_for("gs://b/SYN_HAP.bam") == "SYN_HAP"
    shader._session.attach_reads.assert_called_once_with(
        ["gs://b/SYN_HAP.bam"], "hifiasm_haploid")
    assert "SYN_HAP" in shader._samples_with_reads()


def test_diploid_looks_like_phased_bam(shader):
    shader.attach_assemblies(
        "hifiasm_diploid",
        ("gs://b/SYN_DIP.hap1.bam", "gs://b/SYN_DIP.hap2.bam"),
    )
    assert shader._assemblies["SYN_DIP"]["ploidy"] == 2
    assert shader._sample_mapping["SYN_DIP"] == [
        "gs://b/SYN_DIP.hap1.bam", "gs://b/SYN_DIP.hap2.bam"]
    assert shader._assembly_haplotype_for("gs://b/SYN_DIP.hap1.bam") == 1
    assert shader._assembly_haplotype_for("gs://b/SYN_DIP.hap2.bam") == 2
    assert set(shader.get_bam_samples_for_vcf_samples(["SYN_DIP"])) == {
        "gs://b/SYN_DIP.hap1.bam", "gs://b/SYN_DIP.hap2.bam"}


def test_attach_reads_same_label_appends(shader):
    shader.attach_reads("pacbio", "gs://b/SYN001.bam")
    shader.attach_reads("pacbio", "gs://b/SYN002.bam")
    assert shader._read_set_labels == ["pacbio"]
    shader._session.attach_reads.assert_any_call(["gs://b/SYN001.bam"], "pacbio")
    shader._session.attach_reads.assert_any_call(["gs://b/SYN002.bam"], "pacbio")
    assert shader._session.attach_reads.call_count == 2


def test_same_label_appends_more_samples(shader):
    shader.attach_assemblies(
        "hifiasm_diploid",
        ("gs://b/SYN001.hap1.bam", "gs://b/SYN001.hap2.bam"),
    )
    shader.attach_assemblies(
        "hifiasm_diploid",
        ("gs://b/SYN002.hap1.bam", "gs://b/SYN002.hap2.bam"),
    )
    assert shader._read_set_labels == ["hifiasm_diploid"]
    assert set(shader._assemblies) == {"SYN001", "SYN002"}
    assert shader._read_set_by_url["gs://b/SYN001.hap1.bam"] == "hifiasm_diploid"
    assert shader._read_set_by_url["gs://b/SYN002.hap2.bam"] == "hifiasm_diploid"


def test_list_of_pairs_attaches_several_samples(shader):
    shader.attach_assemblies("hifiasm_diploid", [
        ("gs://b/SYN001.hap1.bam", "gs://b/SYN001.hap2.bam"),
        ("gs://b/SYN002.hap1.bam", "gs://b/SYN002.hap2.bam"),
    ])
    assert set(shader._assemblies) == {"SYN001", "SYN002"}
    assert shader._assemblies["SYN001"]["ploidy"] == 2
    assert shader._assemblies["SYN002"]["ploidy"] == 2


def test_diploid_merges_onto_existing_sample_reads(shader):
    """Assemblies are extra evidence: do not replace PacBio/Illumina URLs."""
    attached = []
    shader._session.attach_reads.side_effect = (
        lambda urls, cohort=None: attached.extend(urls)
    )
    shader._session.get_attached_reads.side_effect = lambda: list(attached)
    shader.attach_reads("pacbio", "gs://b/SYN001.bam")
    shader.attach_assemblies(
        "hifiasm_diploid",
        ("gs://b/SYN001.hap1.bam", "gs://b/SYN001.hap2.bam"),
    )
    assert "SYN001" not in shader._sample_mapping
    urls = set(shader.get_bam_samples_for_vcf_samples(["SYN001"]))
    assert urls == {
        "gs://b/SYN001.bam",
        "gs://b/SYN001.hap1.bam",
        "gs://b/SYN001.hap2.bam",
    }
    snap = shader._read_bam_index_snapshot()["SYN001"]
    assert set(snap) == urls
    assert shader._read_set_by_url["gs://b/SYN001.hap1.bam"] == "hifiasm_diploid"
    assert shader._read_set_by_url["gs://b/SYN001.bam"] == "pacbio"


def test_list_form_and_explicit_sample_name(shader):
    shader.attach_assemblies(
        "hprc", ("gs://b/mat.bam", "gs://b/pat.bam"), sample="SYN_EXPLICIT")
    assert shader._assemblies["SYN_EXPLICIT"]["ploidy"] == 2
    assert shader._assemblies["SYN_EXPLICIT"]["label"] == "hprc"
    shader._session.attach_reads.assert_any_call(["gs://b/mat.bam"], "hprc")
    shader._session.attach_reads.assert_any_call(["gs://b/pat.bam"], "hprc")
    assert shader._session.attach_reads.call_count == 2


@pytest.mark.parametrize("hap1,hap2,expected", [
    ("gs://b/SYN_DIP.hap1.bam", "gs://b/SYN_DIP.hap2.bam", "SYN_DIP"),
    ("gs://b/SYN007_h1.cram", "gs://b/SYN007_h2.cram", "SYN007"),
    ("gs://b/S1.maternal.bam", "gs://b/S1.paternal.bam", "S1"),
    ("gs://b/SYN008.mat.bam", "gs://b/SYN008.pat.bam", "SYN008"),
])
def test_sample_name_inferred_from_hap_suffixes(hap1, hap2, expected):
    assert GenomeShader._infer_assembly_sample_name([hap1, hap2], None) == expected


def test_divergent_stems_require_sample():
    with pytest.raises(ValueError, match="Pass sample="):
        GenomeShader._infer_assembly_sample_name(
            ["gs://b/A.hap1.bam", "gs://b/B.hap2.bam"], None)


def test_rejects_wrong_arity_and_non_bam(shader):
    with pytest.raises(TypeError):
        shader.attach_assemblies()
    with pytest.raises(ValueError, match="non-empty"):
        shader.attach_assemblies("  ", "a.bam")
    with pytest.raises(ValueError, match="flat list"):
        shader.attach_assemblies("hifiasm", ["a.bam", "b.bam", "c.bam"])
    with pytest.raises(ValueError, match="not a .bam"):
        shader.attach_assemblies("hifiasm_haploid", "gs://b/SYN_HAP.fa")
    with pytest.raises(ValueError, match="two distinct"):
        shader.attach_assemblies("hifiasm_diploid", ("gs://b/x.bam", "gs://b/x.bam"))
    with pytest.raises(ValueError, match="sample="):
        shader.attach_assemblies(
            "hifiasm",
            [("gs://b/A.hap1.bam", "gs://b/A.hap2.bam"),
             ("gs://b/B.hap1.bam", "gs://b/B.hap2.bam")],
            sample="NOPE",
        )


def test_fetch_forces_haploid_haplotype_zero(shader):
    import polars as pl
    shader.attach_assemblies("hifiasm_haploid", "gs://b/SYN_HAP.bam")
    shader._last_locus = "chr1:1-100"
    shader.reference = Mock(return_value="")
    # Assembly BAM happens to carry HP:i:1 — still render as unphased.
    shader._session.fetch_reads_for_locus = Mock(return_value=pl.DataFrame({
        "bam_path": ["gs://b/SYN_HAP.bam", "gs://b/SYN_HAP.bam"],
        "haplotype": [1, 1],
        "sample_name": ["unknown", "unknown"],
        "query_name": ["ctg1", "ctg1"],
        "element_type": [0, 1],
    }))
    payload = shader._fetch_reads_payload(sample_id="SYN_HAP")
    assert payload["reads"]["haplotype"] == [0, 0]
    assert payload["reads"]["sample_name"] == ["SYN_HAP", "SYN_HAP"]
    assert payload["bam_urls"] == ["gs://b/SYN_HAP.bam"]


def test_fetch_assigns_diploid_haplotypes(shader):
    import polars as pl
    hap1, hap2 = "gs://b/SYN_DIP.hap1.bam", "gs://b/SYN_DIP.hap2.bam"
    shader.attach_assemblies("hifiasm_diploid", (hap1, hap2))
    shader._last_locus = "chr1:1-100"
    shader.reference = Mock(return_value="")
    shader._session.fetch_reads_for_locus = Mock(return_value=pl.DataFrame({
        "bam_path": [hap1, hap1, hap2, hap2],
        "haplotype": [0, 0, 0, 0],
        "sample_name": ["sm1", "sm1", "sm2", "sm2"],
        "query_name": ["h1", "h1", "h2", "h2"],
        "element_type": [0, 1, 0, 1],
    }))
    payload = shader._fetch_reads_payload(sample_id="SYN_DIP")
    assert payload["reads"]["haplotype"] == [1, 1, 2, 2]
    assert payload["reads"]["sample_name"] == ["SYN_DIP"] * 4
    assert set(payload["bam_urls"]) == {hap1, hap2}


def test_file_uri_matches_local_path_override(shader, tmp_path):
    bam = tmp_path / "asm.bam"
    bam.write_bytes(b"")
    shader.attach_assemblies("hifiasm_haploid", str(bam), sample="ASM")
    file_uri = bam.resolve().as_uri()
    assert shader._assembly_haplotype_for(file_uri) == 0
    overridden = shader._apply_assembly_read_overrides({
        "bam_path": [file_uri],
        "haplotype": [2],
        "sample_name": ["unknown"],
    })
    assert overridden["haplotype"] == [0]
    assert overridden["sample_name"] == ["ASM"]


def test_non_assembly_reads_are_not_rewritten(shader):
    shader.attach_assemblies("hifiasm_haploid", "gs://b/SYN_HAP.bam")
    raw = {
        "bam_path": ["gs://b/other.bam"],
        "haplotype": [1],
        "sample_name": ["S1"],
    }
    assert shader._apply_assembly_read_overrides(raw) == raw


def test_reconcile_skips_assembly_unknown_sm(shader):
    shader._vcf_sample_universe = {"S1"}
    shader.attach_assemblies("hifiasm_haploid", "gs://b/SYN_HAP.bam")
    shader._session.get_bam_sample_names.return_value = ["unknown", "S1"]
    # Must not warn: "unknown" is the assembly BAM's missing @RG SM.
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        shader._reconcile_read_samples()
    assert caught == []
