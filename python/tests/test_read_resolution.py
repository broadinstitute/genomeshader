"""Sample -> BAM-URL resolution for the reads path.

Without an explicit set_sample_mapping, a selected VCF sample must still resolve
to a real read URL by matching an attached read's filename stem (sample "X" ->
".../X.bam"). The old code returned the bare sample name, which isn't a URL, so
the read fetch failed to parse it and the smart track hung on "loading…".

Pure logic — bind the two methods to a stub with a fake session. No compiled
extension needed.
"""
import types

from genomeshader.view import GenomeShader


def _obj(mapping, attached):
    o = types.SimpleNamespace()
    o._sample_mapping = mapping
    o._session = types.SimpleNamespace(get_attached_reads=lambda: attached)
    o.get_bam_samples_for_vcf_samples = types.MethodType(
        GenomeShader.get_bam_samples_for_vcf_samples, o)
    o._attached_reads_by_stem = types.MethodType(
        GenomeShader._attached_reads_by_stem, o)
    return o


def test_identity_resolves_against_attached_reads():
    o = _obj({}, ["gs://b/bam/FP0008-C.bam", "gs://b/bam/FP0009-D.bam"])
    assert o.get_bam_samples_for_vcf_samples(["FP0008-C"]) == ["gs://b/bam/FP0008-C.bam"]


def test_cram_stem_also_matches():
    o = _obj({}, ["gs://b/reads/S1.cram"])
    assert o.get_bam_samples_for_vcf_samples(["S1"]) == ["gs://b/reads/S1.cram"]


def test_explicit_mapping_wins_over_attached():
    o = _obj({"S1": ["gs://x/custom_s1.bam"]}, ["gs://b/S1.bam"])
    assert o.get_bam_samples_for_vcf_samples(["S1"]) == ["gs://x/custom_s1.bam"]


def test_unmatched_sample_falls_back_to_bare_name():
    # No attached read matches -> bare name (the fetch will then report a clear
    # "no BAM" rather than silently mapping to the wrong file).
    o = _obj({}, ["gs://b/other.bam"])
    assert o.get_bam_samples_for_vcf_samples(["NOPE"]) == ["NOPE"]
