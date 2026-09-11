"""Unit tests for software-defined tracks (attach_data / fetch_track_data_payload)."""
import os
import sys
from unittest.mock import Mock, patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
pytest.importorskip("genomeshader.genomeshader")
pytest.importorskip("polars")

import polars as pl

import genomeshader as G
from genomeshader import data_tracks as dt


def _shader(tmp_path, monkeypatch):
    monkeypatch.setenv("GENOMESHADER_LOCAL_CACHE_DIR", str(tmp_path))
    with patch("genomeshader.view.gs._init", return_value=Mock()):
        return G.GenomeShader(
            genome_build="PlasmoDB-61_Pfalciparum3D7",
            gcs_session_dir="gs://test-bucket/genomeshader",
        )


def test_coerce_dict_and_polars():
    d = {"chrom": ["chr1", "chr1"], "start": [10, 20], "value": [1.0, 2.0]}
    df = dt.coerce_to_dataframe(d)
    assert isinstance(df, pl.DataFrame) and df.height == 2
    assert dt.coerce_to_dataframe(df) is df


def test_coerce_pandas_optional():
    pd = pytest.importorskip("pandas")
    pdf = pd.DataFrame({"chrom": ["chr1"], "start": [5], "value": [0.5]})
    df = dt.coerce_to_dataframe(pdf)
    assert isinstance(df, pl.DataFrame) and df.height == 1


def test_missing_columns_error():
    with pytest.raises(ValueError, match="missing required column"):
        dt.build_track_spec("t", {"foo": [1], "bar": [2]}, style="line")


def test_column_overrides_and_default_end():
    spec = dt.build_track_spec(
        "peaks",
        {"chr": ["chr1", "chr1"], "pos": [100, 200], "score": [1.5, 2.5]},
        style="scatter",
        chrom_col="chr",
        start_col="pos",
        value_col="score",
    )
    assert isinstance(spec.data, pl.DataFrame)
    assert "end" in spec.data.columns
    assert spec.data["end"].to_list() == [101, 201]
    assert spec.value_cols == ["value"]  # renamed from score


def test_interval_without_value_col():
    spec = dt.build_track_spec(
        "ann",
        {"chrom": ["chr1"], "start": [10], "end": [50], "name": ["A"]},
        style="interval",
        value_col=None,
        label_col="name",
    )
    assert spec.value_cols == []
    assert spec.track_height == 30
    payload = dt.build_payload(spec, "chr1", 1, 100)
    assert payload["style"] == "interval"
    assert payload["series"][0]["features"][0]["label"] == "A"
    assert "value" not in payload["series"][0]["features"][0]


def test_attach_data_and_fetch_overlap(tmp_path, monkeypatch):
    s = _shader(tmp_path, monkeypatch)
    s.attach_data(
        "gwas",
        {
            "chrom": ["chr1", "chr1", "chr2"],
            "start": [100, 500, 100],
            "end": [101, 501, 101],
            "value": [1.0, 9.0, 3.0],
        },
        style="scatter",
    )
    payload = s.fetch_track_data_payload("data-gwas", "chr1", 90, 150)
    feats = payload["series"][0]["features"]
    assert len(feats) == 1 and feats[0]["start"] == 100
    # Memoization
    again = s.fetch_track_data_payload("data-gwas", "chr1", 90, 150)
    assert again["series"][0]["features"] == feats


def test_chr_alias_filter(tmp_path, monkeypatch):
    s = _shader(tmp_path, monkeypatch)
    s.attach_data(
        "m",
        {"chrom": ["1"], "start": [50], "end": [60], "value": [1.0]},
        style="bar",
    )
    payload = s.fetch_track_data_payload("m", "chr1", 1, 100)
    assert len(payload["series"][0]["features"]) == 1


def test_closure_invocation_and_error(tmp_path, monkeypatch):
    s = _shader(tmp_path, monkeypatch)
    calls = []

    def fetch(contig, start, end):
        calls.append((contig, start, end))
        return {
            "chrom": [contig, contig],
            "start": [start + 1, start + 5],
            "end": [start + 2, start + 6],
            "value": [0.1, 0.2],
        }

    s.attach_data("dyn", fetch, style="line")
    assert s._data_tracks["dyn"].is_callable
    payload = s.fetch_track_data_payload("dyn", "chr1", 1000, 2000)
    assert calls == [("chr1", 1000, 2000)]
    assert len(payload["series"][0]["features"]) == 2

    def boom(contig, start, end):
        raise RuntimeError("slow fail")

    s.attach_data("bad", boom, style="line")
    with pytest.raises(RuntimeError, match="slow fail"):
        s.fetch_track_data_payload("bad", "chr1", 1, 10)


def test_binning_mean_min_max_at_max_points(tmp_path, monkeypatch):
    s = _shader(tmp_path, monkeypatch)
    n = 100
    starts = list(range(1, n + 1))
    values = [float(i) for i in starts]
    s.attach_data(
        "dense",
        {"chrom": ["chr1"] * n, "start": starts, "value": values},
        style="line",
        downsample="mean",
    )
    payload = s.fetch_track_data_payload("dense", "chr1", 1, n, max_points=10)
    feats = payload["series"][0]["features"]
    assert len(feats) <= 10
    assert len(feats) >= 1

    s.attach_data(
        "dense_max",
        {"chrom": ["chr1"] * n, "start": starts, "value": values},
        style="line",
        downsample="max",
    )
    pmax = s.fetch_track_data_payload("dense_max", "chr1", 1, n, max_points=10)
    s.attach_data(
        "dense_min",
        {"chrom": ["chr1"] * n, "start": starts, "value": values},
        style="line",
        downsample="min",
    )
    pmin = s.fetch_track_data_payload("dense_min", "chr1", 1, n, max_points=10)
    # Across the whole window, max-downsample bins should be >= min-downsample bins
    max_vals = [f["value"] for f in pmax["series"][0]["features"]]
    min_vals = [f["value"] for f in pmin["series"][0]["features"]]
    assert max(max_vals) >= max(min_vals)
    assert min(min_vals) <= min(max_vals)


def test_multi_value_cols_overlay(tmp_path, monkeypatch):
    s = _shader(tmp_path, monkeypatch)
    s.attach_data(
        "multi",
        {
            "chrom": ["chr1", "chr1"],
            "start": [10, 20],
            "end": [11, 21],
            "a": [1.0, 2.0],
            "b": [3.0, 4.0],
        },
        style="line",
        value_col=["a", "b"],
    )
    payload = s.fetch_track_data_payload("multi", "chr1", 1, 100)
    assert len(payload["series"]) == 2
    assert payload["series"][0]["name"] == "a"
    assert payload["series"][1]["name"] == "b"
    assert payload["series"][0]["color"] != payload["series"][1]["color"]


def test_bad_style_rejected(tmp_path, monkeypatch):
    s = _shader(tmp_path, monkeypatch)
    with pytest.raises(ValueError, match="style"):
        s.attach_data("x", {"chrom": ["chr1"], "start": [1], "value": [1]}, style="heatmap")


def test_config_entries_include_series_for_static(tmp_path, monkeypatch):
    s = _shader(tmp_path, monkeypatch)
    s.attach_data(
        "g",
        {"chrom": ["chr1"], "start": [10], "value": [1.0]},
        style="bar",
    )
    entries = s._data_tracks_config_entries("chr1", 1, 100)
    assert len(entries) == 1
    assert entries[0]["id"] == "data-g"
    assert entries[0]["series"] and entries[0]["series"][0]["features"]
