"""Setup-time contig validation: a coordinate on a contig the genome doesn't
have must fail with a clean error, not a deep traceback from the fetch.
"""
import os
import sys
import types

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "python"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from genomeshader.view import GenomeShader, ContigNotFoundError


def _stub(sizes):
    s = types.SimpleNamespace()
    s.genome_build = "TestGenome"
    s._chrom_sizes = lambda: dict(sizes)
    s._debug_log = lambda *a, **k: None
    s._known_contigs = types.MethodType(GenomeShader._known_contigs, s)
    s._require_known_contig = types.MethodType(GenomeShader._require_known_contig, s)
    return s


def test_unknown_contig_raises_clean():
    s = _stub({"chr1": 100, "chr2": 200})
    with pytest.raises(ContigNotFoundError) as ei:
        s._require_known_contig("chrX")
    msg = str(ei.value)
    assert "chrX" in msg and "not in the reference" in msg
    assert "chr1" in msg  # lists what IS available


def test_known_contig_passes():
    s = _stub({"chr1": 100})
    s._require_known_contig("chr1")  # must not raise


def test_no_chrom_sizes_skips_validation():
    # UCSC-backed build with no staged chrom_sizes: contig set unknown -> skip.
    s = _stub({})
    s._require_known_contig("whatever")  # must not raise


if __name__ == "__main__":
    test_unknown_contig_raises_clean()
    test_known_contig_passes()
    test_no_chrom_sizes_skips_validation()
    print("ok")
