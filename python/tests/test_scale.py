"""Scale-path tests (P1 aggregate-only payload gating)."""
from genomeshader.view import _apply_persample_scale_gate


def _variant():
    return {
        "id": "v1",
        "alleleFrequencies": {"ref": 0.5, "a1": 0.5},
        "alleleSampleCounts": {"ref": 3, "a1": 2},
        "sampleGenotypes": {"s1": "0/1", "s2": "1/1", "s3": "0/0"},
        "sampleAlleles": {"s1": ["ref", "a1"], "s2": ["a1"], "s3": ["ref"]},
    }


def test_gate_disabled_below_threshold():
    v = [_variant()]
    gated = _apply_persample_scale_gate(v, n_samples=3, persample_max=5000)
    assert gated is False
    assert "sampleGenotypes" in v[0] and "sampleAlleles" in v[0]
    assert "perSampleOmitted" not in v[0]


def test_gate_strips_per_sample_above_threshold():
    v = [_variant()]
    gated = _apply_persample_scale_gate(v, n_samples=50000, persample_max=5000)
    assert gated is True
    assert "sampleGenotypes" not in v[0]
    assert "sampleAlleles" not in v[0]
    assert v[0]["perSampleOmitted"] is True
    # aggregates preserved -> bands still render
    assert v[0]["alleleSampleCounts"] == {"ref": 3, "a1": 2}
    assert v[0]["alleleFrequencies"] == {"ref": 0.5, "a1": 0.5}


def test_gate_negative_max_disables():
    v = [_variant()]
    assert _apply_persample_scale_gate(v, n_samples=10**7, persample_max=-1) is False
    assert "sampleGenotypes" in v[0]


from genomeshader.view import _carriers_from_variant_rows


def _rows():
    # One triallelic variant, ref=A, alts C(idx1), G(idx2), 4 samples.
    return [
        {"sample_name": "s1", "genotype": "0/1", "alt_allele": "C", "alt_index": 1},
        {"sample_name": "s1", "genotype": "0/1", "alt_allele": "G", "alt_index": 2},
        {"sample_name": "s2", "genotype": "2/2", "alt_allele": "C", "alt_index": 1},
        {"sample_name": "s2", "genotype": "2/2", "alt_allele": "G", "alt_index": 2},
        {"sample_name": "s3", "genotype": "0/0", "alt_allele": "C", "alt_index": 1},
        {"sample_name": "s4", "genotype": "./.", "alt_allele": "C", "alt_index": 1},
    ]


def test_carriers_alt_allele_matches_by_index():
    # C (idx1): only s1 carries it (0/1 on the C row).
    assert _carriers_from_variant_rows(_rows(), "A", "C") == ["s1"]
    # G (idx2): only s2 (2/2).
    assert _carriers_from_variant_rows(_rows(), "A", "G") == ["s2"]


def test_carriers_ref_allele():
    # ref A: samples with a 0 in the genotype -> s1 (0/1), s3 (0/0). Not s2 (2/2).
    assert sorted(_carriers_from_variant_rows(_rows(), "A", "A")) == ["s1", "s3"]


def test_carriers_sampled_to_n_deterministic():
    rows = [{"sample_name": f"s{i}", "genotype": "0/1", "alt_allele": "C", "alt_index": 1}
            for i in range(100)]
    out = _carriers_from_variant_rows(rows, "A", "C", n=10, rng_sample=lambda l, k: l[:k])
    assert len(out) == 10 and out[0] == "s0"


def test_carriers_missing_and_dedup():
    # s4 is ./. -> never a carrier; each carrier appears once.
    out = _carriers_from_variant_rows(_rows(), "A", "C")
    assert "s4" not in out and len(out) == len(set(out))


def test_carriers_first_k_short_circuits():
    # 1000 carriers; the first-K path (rng_sample=None) must return exactly the
    # first n WITHOUT scanning the rest — and never touch rows past the nth carrier.
    rows = [{"sample_name": f"s{i}", "genotype": "0/1", "alt_allele": "C", "alt_index": 1}
            for i in range(1000)]
    scanned = []
    class _Row(dict):
        def get(self, k, d=None):
            if k == "sample_name":
                scanned.append(dict.get(self, k))
            return dict.get(self, k, d)
    rows = [_Row(r) for r in rows]
    out = _carriers_from_variant_rows(rows, "A", "C", n=5)  # no rng_sample -> first-K
    assert out == [f"s{i}" for i in range(5)]
    # short-circuit: stopped right after the 5th carrier, didn't scan all 1000.
    assert len(scanned) == 5, f"scanned {len(scanned)} rows (should stop at 5)"


from genomeshader.view import _build_variants_data_from_aggregates, _apply_persample_scale_gate


def test_aggregate_builder_shape_and_counts():
    # Two variants; v1 triallelic (C support 5, G support 8 -> G sorts to a1),
    # v2 biallelic. Aggregate rows are one per (variant, alt).
    rows = [
        {"position": 100, "ref_allele": "A", "alt_allele": "C", "alt_index": 1,
         "variant_id": 0, "vcf_id": None, "filter_status": "PASS", "info_fields": ".",
         "n_ref": 10, "n_alt": 5, "n_missing": 1, "n_samples": 20},
        {"position": 100, "ref_allele": "A", "alt_allele": "G", "alt_index": 2,
         "variant_id": 1, "vcf_id": None, "filter_status": "PASS", "info_fields": ".",
         "n_ref": 10, "n_alt": 8, "n_missing": 1, "n_samples": 20},
        {"position": 250, "ref_allele": "T", "alt_allele": "TA", "alt_index": 1,
         "variant_id": 2, "vcf_id": "rs9", "filter_status": "PASS", "info_fields": "DP=99",
         "n_ref": 3, "n_alt": 2, "n_missing": 0, "n_samples": 5},
    ]
    vd = _build_variants_data_from_aggregates(rows)
    assert len(vd) == 2
    v1 = vd[0]
    # per-sample omitted, aggregates present
    assert v1["perSampleOmitted"] is True
    assert "sampleGenotypes" not in v1 and "sampleAlleles" not in v1
    # empty group counts when no group_counts column
    assert v1.get("alleleSampleCountsByGroup") == {}
    # G (support 8) sorts before C (support 5) -> altAlleles [G, C]
    assert v1["altAlleles"] == ["G", "C"]
    assert v1["alleleSampleCounts"] == {".": 1, "ref": 10, "a1": 8, "a2": 5}
    # frequencies sum to 1 and match counts/total (total = 1+10+8+5 = 24)
    assert abs(v1["alleleFrequencies"]["a1"] - 8 / 24) < 1e-9
    assert abs(sum(v1["alleleFrequencies"].values()) - 1.0) < 1e-9
    # v2 insertion classification + vcfId
    v2 = vd[1]
    assert v2["vcfId"] == "rs9" and v2["isInsertion"] is True
    assert v2["alleleSampleCounts"] == {".": 0, "ref": 3, "a1": 2}


def test_aggregate_builder_preserves_group_counts():
    rows = [
        {"position": 100, "ref_allele": "A", "alt_allele": "G", "alt_index": 1,
         "variant_id": 0, "vcf_id": None, "filter_status": "PASS", "info_fields": ".",
         "n_ref": 3, "n_alt": 2, "n_missing": 0, "n_samples": 5,
         "group_counts": (
             '{"pop":{"AFR":{"ref":2,"alt":1,"missing":0},'
             '"EUR":{"ref":1,"alt":1,"missing":0}}}'
         )},
    ]
    v = _build_variants_data_from_aggregates(rows)[0]
    assert v["alleleSampleCountsByGroup"]["pop"]["AFR"]["a1"] == 1
    assert v["alleleSampleCountsByGroup"]["pop"]["EUR"]["ref"] == 1
    # Survives the scale gate
    gated = [dict(v)]
    gated[0]["sampleGenotypes"] = {"x": "0/1"}
    assert _apply_persample_scale_gate(gated, 99999, 5000) is True
    assert gated[0]["alleleSampleCountsByGroup"]["pop"]["AFR"]["a1"] == 1


def test_aggregate_builder_id_stable_across_windows():
    # The same variant (no VCF ID) read in two overlapping overscan windows gets
    # a different per-call load-order variant_id, but its display id must be
    # stable (position-based) so the frontend dedups the overlap instead of
    # rendering the variant twice ("squished"). Regression for viewport scroll.
    def row(vid):
        return [{"position": 200, "ref_allele": "C", "alt_allele": "T", "alt_index": 1,
                 "variant_id": vid, "vcf_id": None, "filter_status": "PASS",
                 "info_fields": ".", "n_ref": 9, "n_alt": 4, "n_missing": 0,
                 "n_samples": 13}]
    id_a = _build_variants_data_from_aggregates(row(3))[0]["id"]
    id_b = _build_variants_data_from_aggregates(row(9))[0]["id"]
    assert id_a == id_b == "200"


def test_aggregate_builder_zero_total_uniform():
    rows = [{"position": 5, "ref_allele": "A", "alt_allele": "C", "alt_index": 1,
             "variant_id": 0, "vcf_id": None, "filter_status": "PASS", "info_fields": ".",
             "n_ref": 0, "n_alt": 0, "n_missing": 0, "n_samples": 0}]
    vd = _build_variants_data_from_aggregates(rows)
    freqs = vd[0]["alleleFrequencies"]
    assert abs(sum(freqs.values()) - 1.0) < 1e-9


def test_build_variant_payload_from_aggregates(tmp_path, monkeypatch):
    import polars as pl
    from genomeshader.view import GenomeShader
    s = GenomeShader.__new__(GenomeShader)  # bypass __init__ (no session needed)
    s._variant_datasets = [("pf7", ["s%d" % i for i in range(200000)])]
    agg = pl.DataFrame({
        "chromosome": ["chr1", "chr1"],
        "position": [100, 100],
        "ref_allele": ["A", "A"],
        "alt_allele": ["C", "G"],
        "alt_index": [1, 2],
        "variant_id": [0, 1],
        "vcf_id": [None, None],
        "filter_status": ["PASS", "PASS"],
        "info_fields": [".", "."],
        "n_ref": [10, 10],
        "n_alt": [5, 8],
        "n_missing": [1, 1],
        "n_samples": [200000, 200000],
        "variant_track_id": [0, 0],
    })
    tracks, ins = s._build_variant_payload_from_aggregates(agg)
    assert len(tracks) == 1 and tracks[0]["id"] == "flow-0" and tracks[0]["label"] == "pf7"
    assert tracks[0]["variants_phased"] is False
    vd = tracks[0]["variants_data"]
    assert len(vd) == 1 and vd[0]["perSampleOmitted"] is True
    assert vd[0]["altAlleles"] == ["G", "C"]  # resorted by support


def test_variant_sample_count():
    from genomeshader.view import GenomeShader
    s = GenomeShader.__new__(GenomeShader)
    s._variant_datasets = [("a", ["x", "y"]), ("b", ["x", "y", "z"])]
    assert s._variant_sample_count() == 3


from genomeshader.view import _contig_name_candidates


def test_contig_name_candidates():
    assert _contig_name_candidates("chr1")[:2] == ["chr1", "1"]
    assert _contig_name_candidates("1")[:2] == ["1", "chr1"]
    # PlasmoDB-style contig: chr toggle still offered, no crash
    assert _contig_name_candidates("Pf3D7_01_v3")[:2] == ["Pf3D7_01_v3", "chrPf3D7_01_v3"]
    # mito aliases included + deduped
    cands = _contig_name_candidates("chrM")
    assert "chrMT" in cands and len(cands) == len(set(cands))


def test_debug_log_resources_emits_snapshot(tmp_path):
    """Debug mode logs a 'resources' event with memory/thread/cache fields."""
    import logging, types, json as _json
    from genomeshader.view import GenomeShader

    logf = tmp_path / "dbg.log"
    logger = logging.getLogger("gs_res_test")
    logger.setLevel(logging.INFO)
    logger.handlers[:] = [logging.FileHandler(str(logf))]
    logger.propagate = False

    ns = types.SimpleNamespace(
        _debug_logger=logger,
        _agg_region_cache=[1, 2, 3],
        _genes_cache={}, _repeats_cache={}, _reference_cache={},
    )
    ns._debug_log = GenomeShader._debug_log.__get__(ns)
    GenomeShader._debug_log_resources.__get__(ns)("unit-test")
    for h in logger.handlers:
        h.flush()

    text = logf.read_text()
    assert "resources" in text, text
    line = [l for l in text.splitlines() if l.startswith("resources ") or " resources " in l][-1]
    payload = _json.loads(line[line.index("{"):])
    assert payload.get("where") == "unit-test"
    assert payload.get("agg_cache_n") == 3
    # at least one memory metric present (platform-dependent)
    assert ("rss_mb" in payload) or ("max_rss_mb" in payload)
    assert "threads" in payload


def test_attach_variants_debug_logging(tmp_path):
    """attach_variants emits rich structured debug events (so a failing attach
    isn't an empty log). Exercise the no-files path (no live Rust session needed)
    and assert the start/resolved/no-files events land."""
    import logging, types, json as _json
    from genomeshader.view import GenomeShader

    logf = tmp_path / "attach.log"
    logger = logging.getLogger("gs_attach_test")
    logger.setLevel(logging.INFO)
    logger.handlers[:] = [logging.FileHandler(str(logf))]
    logger.propagate = False

    ns = types.SimpleNamespace(_debug_logger=logger, _vcf_sample_universe=set(),
                               _variant_datasets=[], _agg_region_cache=[],
                               _genes_cache={}, _repeats_cache={}, _reference_cache={})
    ns._debug_log = GenomeShader._debug_log.__get__(ns)
    ns._debug_log_resources = GenomeShader._debug_log_resources.__get__(ns)
    # empty variant_files -> resolves to nothing, returns after logging (no session)
    GenomeShader.attach_variants.__get__(ns)("TRK", [])
    for h in logger.handlers:
        h.flush()

    events = [l.split(" ", 1)[0] for l in logf.read_text().splitlines()]
    assert "attach_variants_start" in events, events
    assert "attach_variants_resolved" in events, events
    assert "attach_variants_no_files" in events, events
    # the start line carries the track name
    start = [l for l in logf.read_text().splitlines() if l.startswith("attach_variants_start")][0]
    payload = _json.loads(start[start.index("{"):])
    assert payload.get("track_name") == "TRK"


def test_vcf_sample_names_isolated_surfaces_errors_not_crash():
    """Header reads run in a child process so a native crash can't kill the
    kernel. A bad path must come back as a catchable RuntimeError (parent
    survives), not take the process down."""
    import pytest
    from genomeshader.view import _vcf_sample_names_isolated
    with pytest.raises(RuntimeError):
        _vcf_sample_names_isolated("/tmp/gs_nonexistent_hdr_xyz.vcf.gz", None, timeout=60)


def test_dbg_time_logs_start_done_and_error(tmp_path):
    """_dbg_time logs <event>_start + <event>_done (with ms) on success, and
    <event>_start + <event>_error (with traceback) on failure. No-op when off is
    covered elsewhere; here debug is ON."""
    import logging, types
    from genomeshader.view import GenomeShader
    logf = tmp_path / "t.log"
    lg = logging.getLogger("gs_dbgtime_test"); lg.setLevel(logging.INFO)
    lg.handlers[:] = [logging.FileHandler(str(logf))]; lg.propagate = False
    ns = types.SimpleNamespace(_debug_logger=lg)
    ns._dbg_on = GenomeShader._dbg_on.__get__(ns)
    ns._debug_log = GenomeShader._debug_log.__get__(ns)
    ns._dbg_time = GenomeShader._dbg_time.__get__(ns)

    with ns._dbg_time("op", locus="chr1:1-2"):
        pass
    try:
        with ns._dbg_time("bad"):
            raise ValueError("boom")
    except ValueError:
        pass
    for h in lg.handlers:
        h.flush()
    events = [l.split(" ", 1)[0] for l in logf.read_text().splitlines()]
    assert "op_start" in events and "op_done" in events, events
    assert "bad_start" in events and "bad_error" in events, events
