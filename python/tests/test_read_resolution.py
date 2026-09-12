"""Sample -> read-URL resolution (view.py get_bam_samples_for_vcf_samples).

Resolution order: explicit set_sample_mapping > background read index (built
from filename + @RG SM) > an explicit .bam attach matched by filename stem >
a value that's already a locator. A plain unmatched name resolves to nothing,
so the caller reports a clean "no read file for sample" instead of trying to
parse a bare sample name as a URL (the old bug that hung the smart track on
"loading…").

Pure logic — bind the methods to a stub with the index state + a fake session.
"""
import threading
import types

from genomeshader.view import GenomeShader


def _obj(mapping=None, attached=(), read_index=None):
    o = types.SimpleNamespace()
    o._sample_mapping = mapping or {}
    o._session = types.SimpleNamespace(get_attached_reads=lambda: list(attached))
    o._read_index = read_index or {}
    o._read_index_thread = None                 # index already "done" -> no wait
    o._read_index_done = threading.Event(); o._read_index_done.set()
    o._read_index_lock = threading.Lock()
    for name in ("get_bam_samples_for_vcf_samples", "_attached_reads_by_stem",
                 "_samples_with_reads"):
        setattr(o, name, types.MethodType(getattr(GenomeShader, name), o))
    o._read_stem = GenomeShader._read_stem  # staticmethod -> plain function
    return o


def test_explicit_mapping_wins():
    o = _obj(mapping={"S1": ["gs://x/custom_s1.bam"]},
             attached=["gs://b/S1.bam"], read_index={"S1": ["gs://idx/S1.bam"]})
    assert o.get_bam_samples_for_vcf_samples(["S1"]) == ["gs://x/custom_s1.bam"]


def test_background_index_hit():
    # The index (built from filename/@RG SM) resolves a sample whose filename
    # does NOT match its name.
    o = _obj(read_index={"HG002": ["gs://reads/weird_name_123.bam"]})
    assert o.get_bam_samples_for_vcf_samples(["HG002"]) == ["gs://reads/weird_name_123.bam"]


def test_falls_back_to_attached_by_filename_stem():
    o = _obj(attached=["gs://b/bam/FP0008-C.bam"])
    assert o.get_bam_samples_for_vcf_samples(["FP0008-C"]) == ["gs://b/bam/FP0008-C.bam"]


def test_multiple_attached_same_stem_all_resolve():
    # long_reads/HG001.bam + short_reads/HG001.bam share a stem — both must
    # resolve so the UI can open one smart track per BAM.
    o = _obj(attached=["gs://b/long_reads/HG001.bam", "gs://b/short_reads/HG001.bam"])
    urls = o.get_bam_samples_for_vcf_samples(["HG001"])
    assert set(urls) == {"gs://b/long_reads/HG001.bam", "gs://b/short_reads/HG001.bam"}


def test_read_bam_index_snapshot_lists_multi_bam_sample():
    o = _obj(mapping={"S1": ["gs://x/s1_long.bam", "gs://x/s1_short.bam"]},
             attached=["gs://b/HG001.bam"])
    for name in ("_read_bam_index_snapshot",):
        setattr(o, name, types.MethodType(getattr(GenomeShader, name), o))
    snap = o._read_bam_index_snapshot()
    assert snap["S1"] == ["gs://x/s1_long.bam", "gs://x/s1_short.bam"]
    assert snap["HG001"] == ["gs://b/HG001.bam"]


def test_unmatched_plain_name_resolves_to_nothing():
    o = _obj(attached=["gs://b/other.bam"])
    assert o.get_bam_samples_for_vcf_samples(["NOPE"]) == []


def test_locator_value_passes_through():
    o = _obj()
    assert o.get_bam_samples_for_vcf_samples(["gs://b/explicit.bam"]) == ["gs://b/explicit.bam"]


def test_samples_with_reads_is_attached_set_not_vcf_only():
    o = _obj(mapping={"S1": ["gs://x/s1.bam"]},
              attached=["gs://b/HG001.bam", "gs://b/HG002.cram"],
              read_index={"HG003": ["gs://idx/weird.bam"]})
    assert o._samples_with_reads() == ["HG001", "HG002", "HG003", "S1"]


def test_samples_with_reads_empty_when_nothing_attached():
    o = _obj(attached=["gs://b/other.bam"])
    # Filename stem is in the set; a VCF-only name is not.
    assert "HG005" not in o._samples_with_reads()
    assert "other" in o._samples_with_reads()
