"""Region-jump must not block on the (slow) variant decode.

A jump to a new region timed out because navigate_payload fetched variants
inline — a cold cohort-scale remote VCF decode takes seconds-to-minutes. The fix
returns reference/genes fast (with_variants=False) and defers variants to the
frontend viewport loader. These tests pin the decoupling without needing a live
VCF: a spy fetch_variants_payload proves it isn't called on the fast path.
"""
import os
import sys
import types

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "python"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from genomeshader.view import GenomeShader


def _nav_stub():
    stub = types.SimpleNamespace()
    calls = {"variants": 0}
    stub._debug_log = lambda *a, **k: None
    stub._dbg_on = lambda: False

    class _T:
        def __enter__(self): return self
        def __exit__(self, *a): return False
    stub._dbg_time = lambda *a, **k: _T()

    stub.reference = lambda c, s, e: "ACGT" * 10
    stub.ideogram = lambda c: [{"band": 1}]
    stub.genes = lambda c, s, e: [{"name": "G1", "start": s, "end": e}]
    stub.repeats = lambda c, s, e: []

    def _fv(c, s, e):
        calls["variants"] += 1
        return {"variant_tracks": [{"variants_data": [1, 2, 3]}],
                "insertion_variants_lookup": []}
    stub.fetch_variants_payload = _fv
    stub.navigate_payload = types.MethodType(GenomeShader.navigate_payload, stub)
    return stub, calls


def test_navigate_defers_variants_for_fast_jump():
    stub, calls = _nav_stub()
    p = stub.navigate_payload("c1", 100, 1000, with_variants=False)
    # The slow variant decode must NOT run on a jump.
    assert calls["variants"] == 0, "navigate still fetched variants inline (would time out)"
    assert p["variants_deferred"] is True
    assert p["variant_tracks"] == []
    # Reference + genes still come back so the region is usable immediately.
    assert p["reference_data"], "reference should load fast on a jump"
    assert p["genes_track"]["style"] == "gene"
    assert len(p["genes_track"]["series"][0]["features"]) == 1, "genes should load fast on a jump"



def test_navigate_eager_still_fetches_variants():
    stub, calls = _nav_stub()
    p = stub.navigate_payload("c1", 100, 1000, with_variants=True)
    assert calls["variants"] == 1
    assert p["variants_deferred"] is False
    assert p["variant_tracks"], "eager path must include variants"


def test_navigate_too_wide_is_not_deferred():
    # A too-wide jump skips variants for a different reason (zoom banner); it must
    # not claim variants_deferred (which would trigger a frontend viewport fetch).
    stub, calls = _nav_stub()
    os.environ["GENOMESHADER_VARIANT_MAX_SPAN_BP"] = "1000"
    try:
        p = stub.navigate_payload("c1", 1, 100000, with_variants=False)
    finally:
        del os.environ["GENOMESHADER_VARIANT_MAX_SPAN_BP"]
    assert p["too_wide_for_variants"] is True
    assert p["variants_deferred"] is False
    assert calls["variants"] == 0


if __name__ == "__main__":
    test_navigate_defers_variants_for_fast_jump()
    test_navigate_eager_still_fetches_variants()
    test_navigate_too_wide_is_not_deferred()
    print("ok")
