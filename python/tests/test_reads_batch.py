"""Kernel-side `fetch_reads_batch`: many (sample, BAM, locus) chunks in one call.

The unit of work is one (locus, single BAM) so every chunk has its own cache key. Bound to
a stub Rust session (no compiled extension needed for the logic under test).
"""
from unittest.mock import Mock, patch

import polars as pl

import genomeshader.view as G
from genomeshader.widget import GenomeShaderWidget

HAP1 = "gs://b/S1.hap1.bam"
HAP2 = "gs://b/S1.hap2.bam"


def _shader(tmp_path, monkeypatch, with_batch=True):
    monkeypatch.setenv("GENOMESHADER_LOCAL_CACHE_DIR", str(tmp_path))
    with patch("genomeshader.view.gs._init", return_value=Mock()):
        s = G.GenomeShader(genome_build="PlasmoDB-61_Pfalciparum3D7",
                           gcs_session_dir="gs://test-bucket/genomeshader")
    s.set_sample_mapping({"S1": [HAP1, HAP2]})
    s.reference = Mock(return_value="")

    def frame(bam, locus):
        return pl.DataFrame({
            "query_name": [f"r:{bam[-8:]}:{locus}"], "element_type": [0],
            "reference_start": [7], "reference_end": [90], "is_paired": [False],
            "bam_path": [bam], "sample_name": ["S1"], "haplotype": [0],
        })

    if with_batch:
        def batch(requests):
            return [(frame(bams[0], locus), None) if not bams[0].endswith("bad.bam")
                    else (None, "boom") for (locus, bams, _r, _rs) in requests]
        s._session.fetch_reads_batch = Mock(side_effect=batch)
    else:
        s._session.fetch_reads_batch = None      # older extension: fall back per unit
        s._session.fetch_reads_for_locus = Mock(
            side_effect=lambda locus, bams, r, rs: frame(bams[0], locus))
    return s


def test_one_rust_call_for_all_misses_and_per_chunk_demux(tmp_path, monkeypatch):
    s = _shader(tmp_path, monkeypatch)
    items = [
        {"sample_id": "S1", "bam_url": HAP1, "locus": "Pf3D7_01_v3:1-100"},
        {"sample_id": "S1", "bam_url": HAP2, "locus": "Pf3D7_01_v3:1-100"},
        {"sample_id": "S1", "bam_url": HAP1, "locus": "Pf3D7_01_v3:101-200"},
    ]
    out = s._fetch_reads_batch_payload(items)
    s._session.fetch_reads_batch.assert_called_once()
    reqs = s._session.fetch_reads_batch.call_args[0][0]
    assert [(r[0], r[1]) for r in reqs] == [
        ("Pf3D7_01_v3:1-100", [HAP1]), ("Pf3D7_01_v3:1-100", [HAP2]), ("Pf3D7_01_v3:101-200", [HAP1])]
    assert [o["bam_urls"] for o in out] == [[HAP1], [HAP2], [HAP1]]
    assert out[0]["reads"]["bam_path"] == [HAP1] and out[1]["reads"]["bam_path"] == [HAP2]
    assert all(o["count"] == 1 for o in out)


def test_a_chunk_is_never_fetched_twice(tmp_path, monkeypatch):
    s = _shader(tmp_path, monkeypatch)
    item = [{"sample_id": "S1", "bam_url": HAP1, "locus": "Pf3D7_01_v3:1-100"}]
    a = s._fetch_reads_batch_payload(item)
    b = s._fetch_reads_batch_payload(item)
    assert a[0]["reads"] == b[0]["reads"]
    s._session.fetch_reads_batch.assert_called_once()            # 2nd call: served from disk cache
    # A DIFFERENT chunk of the same BAM is a miss; the cached one is not re-requested.
    s._fetch_reads_batch_payload(item + [{"sample_id": "S1", "bam_url": HAP1,
                                          "locus": "Pf3D7_01_v3:101-200"}])
    reqs = s._session.fetch_reads_batch.call_args[0][0]
    assert [r[0] for r in reqs] == ["Pf3D7_01_v3:101-200"]


def test_duplicate_units_in_one_batch_are_fetched_once(tmp_path, monkeypatch):
    s = _shader(tmp_path, monkeypatch)
    item = {"sample_id": "S1", "bam_url": HAP1, "locus": "Pf3D7_01_v3:1-100"}
    out = s._fetch_reads_batch_payload([item, dict(item)])
    assert len(s._session.fetch_reads_batch.call_args[0][0]) == 1
    assert out[0]["reads"] == out[1]["reads"]


def test_unpinned_item_merges_all_bams_of_the_sample(tmp_path, monkeypatch):
    s = _shader(tmp_path, monkeypatch)
    out = s._fetch_reads_batch_payload([{"sample_id": "S1", "bam_url": None, "locus": "Pf3D7_01_v3:1-100"}])
    assert sorted(out[0]["bam_urls"]) == sorted([HAP1, HAP2])     # resolution order is not guaranteed
    assert sorted(out[0]["reads"]["bam_path"]) == sorted([HAP1, HAP2])


def test_bad_items_fail_alone(tmp_path, monkeypatch):
    s = _shader(tmp_path, monkeypatch)
    out = s._fetch_reads_batch_payload([
        {"sample_id": "S1", "bam_url": "gs://b/S1.bad.bam", "locus": "Pf3D7_01_v3:1-100"},   # not this sample's BAM
        {"sample_id": "S1", "bam_url": HAP1, "locus": "Pf3D7_01_v3:1-100"},
        {"sample_id": None, "bam_url": HAP1, "locus": "Pf3D7_01_v3:1-100"},                  # malformed
        {"sample_id": "NOBODY", "bam_url": None, "locus": "Pf3D7_01_v3:1-100"},              # VCF-only sample
    ])
    assert out[0]["bam_urls"] == [] and out[0]["reads"] == {}          # UI drops the empty track quietly
    assert out[1]["bam_urls"] == [HAP1] and out[1]["count"] == 1
    assert "error" in out[2]
    assert out[3]["bam_urls"] == []


def test_rust_error_for_one_unit_is_isolated(tmp_path, monkeypatch):
    s = _shader(tmp_path, monkeypatch)
    s.set_sample_mapping({"S1": [HAP1, "gs://b/S1.bad.bam"]})
    out = s._fetch_reads_batch_payload([
        {"sample_id": "S1", "bam_url": HAP1, "locus": "Pf3D7_01_v3:1-100"},
        {"sample_id": "S1", "bam_url": "gs://b/S1.bad.bam", "locus": "Pf3D7_01_v3:1-100"},
    ])
    assert out[0]["count"] == 1
    assert "boom" in out[1]["error"]


def test_falls_back_to_per_unit_calls_on_older_extension(tmp_path, monkeypatch):
    s = _shader(tmp_path, monkeypatch, with_batch=False)
    out = s._fetch_reads_batch_payload([
        {"sample_id": "S1", "bam_url": HAP1, "locus": "Pf3D7_01_v3:1-100"},
        {"sample_id": "S1", "bam_url": HAP2, "locus": "Pf3D7_01_v3:1-100"},
    ])
    assert s._session.fetch_reads_for_locus.call_count == 2
    assert [o["bam_urls"] for o in out] == [[HAP1], [HAP2]]


def test_reference_is_fetched_once_per_locus_not_per_bam(tmp_path, monkeypatch):
    s = _shader(tmp_path, monkeypatch)
    s._fetch_reads_batch_payload([
        {"sample_id": "S1", "bam_url": HAP1, "locus": "Pf3D7_01_v3:1-100"},
        {"sample_id": "S1", "bam_url": HAP2, "locus": "Pf3D7_01_v3:1-100"},
    ])
    assert s.reference.call_count == 1


def test_widget_routes_fetch_reads_batch(tmp_path, monkeypatch):
    s = _shader(tmp_path, monkeypatch)
    w = GenomeShaderWidget(s, config={}, view_id="v")
    sent = []
    w.send = lambda m, *a, **k: sent.append(m)
    w._on_custom_msg(w, {"type": "fetch_reads_batch", "request_id": "r1", "items": [
        {"sample_id": "S1", "bam_url": HAP1, "locus": "Pf3D7_01_v3:1-100"}]}, [])
    assert sent[0]["type"] == "fetch_reads_batch_response" and sent[0]["request_id"] == "r1"
    assert sent[0]["items"][0]["bam_urls"] == [HAP1]
    # whole-batch failure surfaces as a batch error, not a crash
    s._fetch_reads_batch_payload = Mock(side_effect=RuntimeError("kaput"))
    w._on_custom_msg(w, {"type": "fetch_reads_batch", "request_id": "r2", "items": []}, [])
    assert sent[-1]["type"] == "fetch_reads_batch_error" and "kaput" in sent[-1]["error"]
