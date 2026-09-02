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
