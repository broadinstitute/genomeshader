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
