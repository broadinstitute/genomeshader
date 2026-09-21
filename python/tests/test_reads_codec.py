"""Round-trip + fallback behaviour of the binary reads codec."""
import json

import pytest

np = pytest.importorskip("numpy")

from genomeshader import reads_codec as rc  # noqa: E402


def _reads(n=50):
    return {
        "query_name": [f"read/{i}" for i in range(n)],
        "element_type": [0 if i % 3 == 0 else 1 for i in range(n)],
        "reference_start": [32_000_000 + i * 7 for i in range(n)],
        "reference_end": [32_000_150 + i * 7 for i in range(n)],
        "is_forward": [bool(i % 2) for i in range(n)],
        "haplotype": [i % 3 for i in range(n)],
        "sample_name": ["S1"] * n,
        "sequence": ["" if i % 3 == 0 else "ACGT"[i % 4] for i in range(n)],
        "sa_tag": ["" if i % 5 else "chr20,32005500,+,800S800M,60,0;" for i in range(n)],
        "mean_base_quality": [30.5 + i for i in range(n)],
        "insert_size": [0] * n,
    }


def test_roundtrip_is_exact():
    reads = _reads()
    buffers = []
    manifest = rc.encode_reads(reads, buffers)
    assert manifest is not None and manifest["n"] == 50
    assert rc.decode_reads(manifest, buffers) == reads


def test_bool_columns_come_back_as_real_booleans():
    reads = _reads()
    buffers = []
    out = rc.decode_reads(rc.encode_reads(reads, buffers), buffers)
    assert all(isinstance(v, bool) for v in out["is_forward"])


def test_large_ints_use_a_wider_type_and_stay_exact():
    reads = {"query_name": ["a", "b"], "reference_start": [1, 2 ** 40]}
    buffers = []
    manifest = rc.encode_reads(reads, buffers)
    kinds = {c["name"]: c["kind"] for c in manifest["cols"]}
    assert kinds["reference_start"] == "f64"
    assert rc.decode_reads(manifest, buffers)["reference_start"] == [1.0, float(2 ** 40)]


@pytest.mark.parametrize("bad", [
    {"query_name": ["a", "b"], "x": [1, "two"]},          # mixed types
    {"query_name": ["a", "b"], "x": [1, None]},           # null in an int column
    {"query_name": ["a", "b"], "x": [True, None]},        # null in a bool column
    {"query_name": ["a", "b\0c"]},                        # NUL inside a string
    {"query_name": ["a", "b"], "x": [1, 2 ** 60]},        # beyond exact float range
    {"query_name": ["a", "b"], "x": [1]},                 # ragged columns
])
def test_unrepresentable_columns_fall_back_to_json_instead_of_changing_data(bad):
    buffers = []
    assert rc.encode_reads(bad, buffers) is None


def test_batch_items_mix_binary_and_json_and_keep_other_fields():
    good = {"reads": _reads(10), "count": 10, "bam_urls": ["gs://x.bam"], "sample_id": "S1"}
    bad = {"reads": {"query_name": ["a", "b"], "x": [1, "two"]}, "count": 2}   # not representable
    err = {"error": "boom"}
    empty = {"reads": {}, "count": 0}
    items, buffers = rc.encode_batch_items([good, bad, err, empty])
    assert "reads" not in items[0] and items[0]["reads_bin"]["n"] == 10
    assert items[0]["count"] == 10 and items[0]["bam_urls"] == ["gs://x.bam"] and items[0]["sample_id"] == "S1"
    assert items[1]["reads"] == bad["reads"] and "reads_bin" not in items[1]          # JSON fallback, untouched
    assert items[2] == err and items[3] == empty
    assert rc.decode_reads(items[0]["reads_bin"], buffers) == good["reads"]
    # a failed item leaves no stray buffers behind (indices stay dense)
    assert all(c["buf"] < len(buffers) for c in items[0]["reads_bin"]["cols"])


def test_binary_is_smaller_and_not_pathologically_slower_to_produce_than_json():
    import time
    reads = _reads(50000)
    t0 = time.perf_counter(); buffers = []; rc.encode_reads(reads, buffers); t_bin = time.perf_counter() - t0
    t0 = time.perf_counter(); as_json = json.dumps(reads); t_json = time.perf_counter() - t0
    assert sum(len(b) for b in buffers) < len(as_json)
    # json.dumps is C-accelerated, so the kernel-side encode is a little slower; the
    # win is browser-side (no JSON.parse, typed arrays). Guard against a regression.
    assert t_bin < t_json * 4, (t_bin, t_json)
