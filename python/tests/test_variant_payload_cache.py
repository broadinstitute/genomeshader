"""Host-side viewport variant-payload cache (#77).

Unit-tests the bounded LRU region cache that amortizes the expensive window
read/parse (at 20k+ samples the wall is reading the ~500KB/record VCF lines,
not the tally). Pure logic — no compiled extension, no VCF — so it runs
everywhere. The end-to-end amortization (a re-visited window served from RAM
instead of re-parsing) is exercised against real Pf7 data separately; here we
guard coverage, subset, LRU touch, and eviction.
"""
import types

from genomeshader.view import GenomeShader


def _cache_obj(max_entries=3):
    """A minimal object carrying just the cache methods + state, so we can test
    the cache in isolation without constructing a full session/UCSC-backed
    GenomeShader."""
    o = types.SimpleNamespace()
    o._agg_region_cache = []
    o._agg_region_cache_max = max_entries
    o._agg_region_cache_get = types.MethodType(GenomeShader._agg_region_cache_get, o)
    o._agg_region_cache_put = types.MethodType(GenomeShader._agg_region_cache_put, o)
    o._subset_variant_payload = types.MethodType(GenomeShader._subset_variant_payload, o)
    return o


def _payload(positions):
    return {"variant_tracks": [{"id": "flow-0", "variants_data":
             [{"id": f"v{p}", "pos": p} for p in positions]}],
            "insertion_variants_lookup": []}


def test_exact_hit_and_miss():
    o = _cache_obj()
    assert o._agg_region_cache_get("sig", "chr1", 100, 200) is None  # empty -> miss
    o._agg_region_cache_put("sig", "chr1", 100, 200, _payload([120, 180]), True)
    hit = o._agg_region_cache_get("sig", "chr1", 100, 200)
    assert hit is not None and hit["aggregate"] is True
    # different dataset signature or contig -> miss
    assert o._agg_region_cache_get("other", "chr1", 100, 200) is None
    assert o._agg_region_cache_get("sig", "chr2", 100, 200) is None
    # a window NOT covered (extends past the cached region) -> miss
    assert o._agg_region_cache_get("sig", "chr1", 100, 300) is None


def test_covering_region_serves_subwindow_via_subset():
    o = _cache_obj()
    o._agg_region_cache_put("sig", "chr1", 0, 1000,
                            _payload([50, 250, 500, 900]), True)
    hit = o._agg_region_cache_get("sig", "chr1", 200, 600)  # inside the cached region
    assert hit is not None
    sub = o._subset_variant_payload(hit["payload"], 200, 600)
    got = [v["pos"] for v in sub["variant_tracks"][0]["variants_data"]]
    assert got == [250, 500], f"subset should keep only in-window variants, got {got}"


def test_smallest_covering_region_wins():
    o = _cache_obj(max_entries=5)
    o._agg_region_cache_put("sig", "chr1", 0, 1000, _payload([500]), True)
    o._agg_region_cache_put("sig", "chr1", 400, 600, _payload([500]), True)
    hit = o._agg_region_cache_get("sig", "chr1", 480, 520)
    assert hit["start"] == 400 and hit["end"] == 600, "should pick the tightest covering region"


def test_lru_eviction_is_bounded():
    o = _cache_obj(max_entries=3)
    for i in range(6):
        o._agg_region_cache_put("sig", "chr1", i * 100, i * 100 + 100, _payload([i * 100 + 50]), True)
    assert len(o._agg_region_cache) == 3, "cache must stay bounded"
    # the three most-recent (i=3,4,5) survive; older ones evicted
    survivors = {(r["start"], r["end"]) for r in o._agg_region_cache}
    assert survivors == {(300, 400), (400, 500), (500, 600)}


def test_hit_touches_lru_order():
    o = _cache_obj(max_entries=2)
    o._agg_region_cache_put("sig", "chr1", 0, 100, _payload([50]), True)
    o._agg_region_cache_put("sig", "chr1", 100, 200, _payload([150]), True)
    # touch the first so it becomes most-recently-used
    assert o._agg_region_cache_get("sig", "chr1", 0, 100) is not None
    # insert a third -> the un-touched (100,200) is evicted, (0,100) survives
    o._agg_region_cache_put("sig", "chr1", 200, 300, _payload([250]), True)
    survivors = {(r["start"], r["end"]) for r in o._agg_region_cache}
    assert survivors == {(0, 100), (200, 300)}, f"LRU touch not honored: {survivors}"
