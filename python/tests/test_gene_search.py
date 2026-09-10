"""Gene / transcript search-to-jump (resolve_feature).

Covers the pure ranking (_rank_feature_matches) and the genome-wide index build
(_gene_name_index -> resolve_feature) against parsed PlasmoDB gene models,
without needing a live GCS session or a full stage.
"""
import os
import sys
import types

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "python"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from genomeshader.view import GenomeShader
from genomeshader.plasmodb import parse_gff_genes


def test_rank_orders_exact_prefix_substring():
    idx = [
        ("PF3D7_0100100", "c1", 100, 200),
        ("PF3D7_0100200", "c1", 300, 400),
        ("XPF3D7_9", "c2", 50, 60),        # substring only
    ]
    out = GenomeShader._rank_feature_matches(idx, "PF3D7_0100100", 10)
    assert out and out[0]["name"] == "PF3D7_0100100" and out[0]["start"] == 100
    # prefix returns both PF3D7_010* before the substring-only XPF3D7_9
    pref = GenomeShader._rank_feature_matches(idx, "PF3D7_0100", 10)
    names = [m["name"] for m in pref]
    assert names[:2] == ["PF3D7_0100100", "PF3D7_0100200"]
    # empty query -> nothing
    assert GenomeShader._rank_feature_matches(idx, "", 10) == []


def _stub_from_gff(gff_path):
    """Minimal GenomeShader-like stub: parsed gene models + the real
    _gene_name_index / resolve_feature / _rank_feature_matches bound in."""
    by_contig = parse_gff_genes(gff_path)
    stub = types.SimpleNamespace()
    stub._chrom_sizes = lambda: {c: 10 ** 9 for c in by_contig}  # whole-contig
    stub.genes = lambda contig, start, end, **k: by_contig.get(contig, [])
    stub._gene_index_memo = None

    class _Dbg:
        def __enter__(self): return self
        def __exit__(self, *a): return False
    stub._dbg_time = lambda *a, **k: _Dbg()
    # Bind the real methods (unbound) with the stub as self.
    stub._rank_feature_matches = GenomeShader._rank_feature_matches  # staticmethod
    stub._gene_name_index = types.MethodType(GenomeShader._gene_name_index, stub)
    stub.resolve_feature = types.MethodType(GenomeShader.resolve_feature, stub)
    return stub, by_contig


def test_resolve_feature_on_plasmodb_gff():
    gff = "/workspace/fiss_downloads/PlasmoDB-61_Pfalciparum3D7.gff"
    if not os.path.exists(gff):
        import pytest
        pytest.skip("PlasmoDB GFF fixture not present")
    stub, by_contig = _stub_from_gff(gff)

    # A known systematic gene ID resolves to a single locus on its contig.
    hit = stub.resolve_feature("PF3D7_1309900")
    assert hit, "systematic gene ID did not resolve"
    assert hit[0]["name"] == "PF3D7_1309900"
    assert hit[0]["contig"] == "Pf3D7_13_v3"
    assert hit[0]["start"] > 0 and hit[0]["end"] > hit[0]["start"]

    # Transcript ID (gene ID + .1) resolves to the parent gene span.
    tx = stub.resolve_feature("PF3D7_1309900.1")
    assert tx, "transcript ID did not resolve"
    assert tx[0]["start"] == hit[0]["start"]

    # Nonexistent query -> no matches (graceful, not an error).
    assert stub.resolve_feature("NO_SUCH_GENE_XYZ") == []


if __name__ == "__main__":
    test_rank_orders_exact_prefix_substring()
    test_resolve_feature_on_plasmodb_gff()
    print("ok")
