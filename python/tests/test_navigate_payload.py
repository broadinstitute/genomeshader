"""navigate_payload assembles a full per-window render payload for a contig jump.

Pure assembly logic — bind the method to a stub carrying the per-region getters
it calls (reference/ideogram/genes/repeats/fetch_variants_payload). No compiled
extension or staged genome, so it runs everywhere. Guards that each piece is
fetched defensively: a getter that raises yields its empty default rather than
failing the whole jump.
"""
import types

from genomeshader.view import GenomeShader


def _stub(**methods):
    o = types.SimpleNamespace()
    for name, fn in methods.items():
        setattr(o, name, fn)
    o.navigate_payload = types.MethodType(GenomeShader.navigate_payload, o)
    return o


def _raise(*_a, **_k):
    raise RuntimeError("track unavailable")


def test_assembles_all_pieces():
    o = _stub(
        fetch_variants_payload=lambda c, s, e: {
            "variant_tracks": [{"name": "t", "variants_data": [{"pos": 150}]}],
            "insertion_variants_lookup": [{"id": "i1"}],
        },
        reference=lambda c, s, e: "ACGT",
        ideogram=lambda c: [{"chrom": c}],
        genes=lambda c, s, e: [{"name": "g1"}],
        repeats=lambda c, s, e: [{"cls": "LINE"}],
    )
    p = o.navigate_payload("chr2", 100, 200)
    assert p["contig"] == "chr2" and p["start"] == 100 and p["end"] == 200
    assert p["region"] == "chr2:100-200"
    assert p["reference_data"] == "ACGT"
    assert p["ideogram_data"] == [{"chrom": "chr2"}]
    assert p["transcripts_data"] == [{"name": "g1"}]
    assert p["repeats_data"] == [{"cls": "LINE"}]
    assert p["variant_tracks"][0]["variants_data"] == [{"pos": 150}]
    assert p["insertion_variants_lookup"] == [{"id": "i1"}]


def test_missing_tracks_fall_back_to_empty_not_error():
    # reference/genes/repeats/ideogram all raise; variants still come through.
    o = _stub(
        fetch_variants_payload=lambda c, s, e: {"variant_tracks": [], "insertion_variants_lookup": []},
        reference=_raise, ideogram=_raise, genes=_raise, repeats=_raise,
    )
    p = o.navigate_payload("chrX", 1, 50)
    assert p["reference_data"] == ""
    assert p["ideogram_data"] == [] and p["transcripts_data"] == [] and p["repeats_data"] == []
    assert p["variant_tracks"] == []


def test_none_returns_become_defaults():
    # A getter returning None (e.g. no reference staged) becomes the empty default.
    o = _stub(
        fetch_variants_payload=lambda c, s, e: {"variant_tracks": []},
        reference=lambda c, s, e: None,
        ideogram=lambda c: None,
        genes=lambda c, s, e: None,
        repeats=lambda c, s, e: None,
    )
    p = o.navigate_payload("chr1", 1, 10)
    assert p["reference_data"] == "" and p["ideogram_data"] == []
    assert p["transcripts_data"] == [] and p["repeats_data"] == []
    assert p["insertion_variants_lookup"] == []  # absent key -> default


def test_region_track_meta_defensive():
    o = _stub(
        reference=lambda c, s, e: "ACGT",
        genes=lambda c, s, e: [{"name": "g"}],
        repeats=_raise,                       # missing -> []
        ideogram=lambda c: [{"chrom": c}],
    )
    o._region_track_meta = types.MethodType(GenomeShader._region_track_meta, o)
    m = o._region_track_meta("chr2", 100, 200)
    assert m["reference_data"] == "ACGT"
    assert m["transcripts_data"] == [{"name": "g"}]
    assert m["repeats_data"] == []            # raiser -> default
    assert m["ideogram_data"] == [{"chrom": "chr2"}]
    assert m["data_bounds"] == {"start": 100, "end": 200}
