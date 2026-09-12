"""Tests for sample metadata + grouping helpers."""
import warnings

import polars as pl
import pytest

from genomeshader import sample_metadata as sm
from genomeshader.view import (
    _apply_persample_scale_gate,
    _build_variants_data_from_aggregates,
)


def test_coerce_column_dict_and_row_map():
    df = sm.coerce_sample_metadata_table(
        {"sample": ["S1", "S2"], "pop": ["AFR", "EUR"]}
    )
    assert set(df["sample"].to_list()) == {"S1", "S2"}
    by_sample = {r["sample"]: r["pop"] for r in df.iter_rows(named=True)}
    assert by_sample == {"S1": "AFR", "S2": "EUR"}

    df2 = sm.coerce_sample_metadata_table(
        {"S1": {"pop": "AFR", "sex": "F"}, "S2": {"pop": "EUR", "sex": "M"}}
    )
    assert "pop" in df2.columns and "sex" in df2.columns
    assert set(df2["sample"].to_list()) == {"S1", "S2"}


def test_coerce_requires_sample_col():
    with pytest.raises(ValueError, match="sample column"):
        sm.coerce_sample_metadata_table({"pop": ["AFR"]})


def test_grouping_eligible_cardinality():
    df = pl.DataFrame({
        "sample": [f"s{i}" for i in range(40)],
        "pop": (["AFR", "EUR"] * 20),
        "uid": [f"u{i}" for i in range(40)],  # high cardinality (>32)
        "const": ["x"] * 40,  # too low
    })
    eligible = sm.grouping_eligible_columns(df)
    assert eligible == ["pop"]


def test_build_config_summary_colors_and_by_id():
    df = pl.DataFrame({
        "sample": ["S1", "S2", "S3"],
        "pop": ["AFR", "EUR", "AFR"],
    })
    summary = sm.build_config_summary(
        df, read_samples=["S1", "S2"], vcf_universe={"S1", "S2", "S3", "S4"}
    )
    assert summary is not None
    assert len(summary["columns"]) == 1
    col = summary["columns"][0]
    assert col["name"] == "pop"
    values = {v["value"]: v for v in col["values"]}
    assert values["AFR"]["count"] == 2
    assert values["EUR"]["count"] == 1
    # Missing VCF sample counted as unlabeled
    assert values[sm.UNLABELED]["count"] == 1
    assert "color" in values["AFR"]
    assert summary["by_id"]["S1"]["pop"] == "AFR"
    assert "S3" not in summary["by_id"]  # not in read_samples


def test_tally_allele_counts_by_group():
    sample_alleles = {
        "S1": {"ref", "a1"},
        "S2": {"ref"},
        "S3": {"a1"},
    }
    lookups = {"pop": {"S1": "AFR", "S2": "EUR", "S3": "AFR"}}
    out = sm.tally_allele_counts_by_group(
        sample_alleles, [".", "ref", "a1"], lookups
    )
    assert out["pop"]["AFR"]["a1"] == 2
    assert out["pop"]["AFR"]["ref"] == 1
    assert out["pop"]["EUR"]["ref"] == 1
    assert out["pop"]["EUR"]["a1"] == 0


def test_group_counts_survive_scale_gate():
    v = [{
        "alleleFrequencies": {"ref": 0.5, "a1": 0.5},
        "alleleSampleCounts": {"ref": 2, "a1": 2},
        "alleleSampleCountsByGroup": {
            "pop": {"AFR": {"ref": 1, "a1": 2}, "EUR": {"ref": 1, "a1": 0}}
        },
        "sampleGenotypes": {"s1": "0/1"},
        "sampleAlleles": {"s1": ["ref", "a1"]},
    }]
    assert _apply_persample_scale_gate(v, n_samples=50000, persample_max=5000) is True
    assert "sampleGenotypes" not in v[0]
    assert v[0]["alleleSampleCountsByGroup"]["pop"]["AFR"]["a1"] == 2


def test_aggregate_builder_pivots_group_counts():
    rows = [
        {
            "position": 100,
            "ref_allele": "A",
            "alt_allele": "G",
            "n_ref": 2,
            "n_alt": 1,
            "n_missing": 0,
            "vcf_id": None,
            "variant_id": 0,
            "filter_status": "PASS",
            "info_fields": ".",
            "group_counts": (
                '{"pop":{"AFR":{"ref":1,"alt":1,"missing":0},'
                '"EUR":{"ref":1,"alt":0,"missing":0}}}'
            ),
        }
    ]
    out = _build_variants_data_from_aggregates(rows)
    assert len(out) == 1
    by_group = out[0]["alleleSampleCountsByGroup"]["pop"]
    assert by_group["AFR"] == {".": 0, "ref": 1, "a1": 1}
    assert by_group["EUR"] == {".": 0, "ref": 1, "a1": 0}


def test_attach_metadata_on_shader(tmp_path, monkeypatch):
    pytest.importorskip("genomeshader.genomeshader")
    from unittest.mock import Mock, patch
    import genomeshader as G

    monkeypatch.setenv("GENOMESHADER_LOCAL_CACHE_DIR", str(tmp_path))
    with patch("genomeshader.view.gs._init", return_value=Mock()):
        s = G.GenomeShader(
            genome_build="hg38",
            gcs_session_dir="gs://test-bucket/genomeshader",
        )
    s._vcf_sample_universe = {"S1", "S2"}
    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter("always")
        s.attach_metadata("1kg", {
            "sample": ["S1", "S2", "S99"],
            "pop": ["AFR", "EUR", "AFR"],
        })
        assert any("not in the attached VCF" in str(x.message) for x in w)

    got = s.get_metadata("1kg")
    assert got is not None and len(got) == 3
    assert s.get_metadata() is not None  # sole table
    cfg = s._sample_metadata_config()
    assert cfg["label"] == "1kg"
    assert cfg["columns"][0]["name"] == "pop"
    assert s._sample_metadata_group_lookups()["pop"]["S1"] == "AFR"


def test_attach_metadata_multiple_labels(tmp_path, monkeypatch):
    pytest.importorskip("genomeshader.genomeshader")
    from unittest.mock import Mock, patch
    import genomeshader as G

    monkeypatch.setenv("GENOMESHADER_LOCAL_CACHE_DIR", str(tmp_path))
    with patch("genomeshader.view.gs._init", return_value=Mock()):
        s = G.GenomeShader(
            genome_build="hg38",
            gcs_session_dir="gs://test-bucket/genomeshader",
        )
    s.attach_metadata("pop", {"sample": ["S1", "S2"], "super_pop": ["AFR", "EUR"]})
    s.attach_metadata("pheno", {"sample": ["S1", "S2"], "case": ["case", "control"]})
    with pytest.raises(ValueError, match="multiple tables"):
        s.get_metadata()
    assert s.get_metadata("pop") is not None
    cfg = s._sample_metadata_config()
    names = {c["name"] for c in cfg["columns"]}
    assert "pop__super_pop" in names
    assert "pheno__case" in names
