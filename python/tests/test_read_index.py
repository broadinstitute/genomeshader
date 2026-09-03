"""Background read index: VCF-sample -> read-file mapping (view.py).

_build_read_index lists the pending read dirs, matches each file to a VCF sample
by filename stem (a guess — filenames aren't guaranteed to be sample names),
then reads @RG SM headers for the leftovers (authoritative). Here we stub the
GCS listing and the Rust SM reader and check both passes + the both-attached
trigger.
"""
import threading
import types
from unittest import mock

import genomeshader.genomeshader as gs
from genomeshader.view import GenomeShader


def _obj(universe, pending):
    o = types.SimpleNamespace()
    o._vcf_sample_universe = set(universe)
    o._pending_read_dirs = list(pending)
    o._read_index = {}
    o._read_index_thread = None
    o._read_index_done = threading.Event()
    o._read_index_lock = threading.Lock()
    o._session = types.SimpleNamespace(get_attached_reads=lambda: [])
    for name in ("_build_read_index", "_maybe_start_read_index"):
        setattr(o, name, types.MethodType(getattr(GenomeShader, name), o))
    o._read_stem = GenomeShader._read_stem  # staticmethod -> plain function
    return o


def test_two_pass_filename_then_header():
    o = _obj({"S1", "S2", "WEIRD"}, [("gs://d/", "all")])
    listing = {".bam": ["gs://d/S1.bam", "gs://d/S2.bam", "gs://d/lab_9921.bam"], ".cram": []}
    # lab_9921.bam's name matches no sample; its @RG SM is WEIRD.
    with mock.patch.object(gs, "_gcs_list_files_of_type",
                           side_effect=lambda p, ext: listing[ext]), \
         mock.patch.object(gs, "_bam_sample_names",
                           return_value=[("gs://d/lab_9921.bam", ["WEIRD"])]) as bsn:
        o._build_read_index()
    # header read only for the one filename miss
    assert bsn.call_args[0][0] == ["gs://d/lab_9921.bam"]
    assert o._read_index == {
        "S1": ["gs://d/S1.bam"],
        "S2": ["gs://d/S2.bam"],
        "WEIRD": ["gs://d/lab_9921.bam"],
    }
    assert o._read_index_done.is_set()


def test_header_sm_outside_universe_is_dropped():
    o = _obj({"S1"}, [("gs://d/", "all")])
    listing = {".bam": ["gs://d/S1.bam", "gs://d/other.bam"], ".cram": []}
    with mock.patch.object(gs, "_gcs_list_files_of_type",
                           side_effect=lambda p, ext: listing[ext]), \
         mock.patch.object(gs, "_bam_sample_names",
                           return_value=[("gs://d/other.bam", ["NOT_IN_VCF"])]):
        o._build_read_index()
    assert o._read_index == {"S1": ["gs://d/S1.bam"]}  # other.bam's SM not in the cohort


def test_trigger_waits_for_both_variants_and_reads():
    # reads pending but no variants yet -> no thread
    o = _obj(set(), [("gs://d/", "all")])
    o._maybe_start_read_index()
    assert o._read_index_thread is None
    # variants arrive -> thread starts
    o._vcf_sample_universe = {"S1"}
    with mock.patch.object(gs, "_gcs_list_files_of_type", return_value=[]), \
         mock.patch.object(gs, "_bam_sample_names", return_value=[]):
        o._maybe_start_read_index()
        assert o._read_index_thread is not None
        o._read_index_thread.join(timeout=5)
    assert o._read_index_done.is_set()
