"""The chunk-merge fast path must equal the general merge, exactly.

Chunks are fetched per window, so a read straddling a chunk edge appears in both
neighbours and must be de-duplicated (elements unioned). The fast path only keys the
reads that overlap another chunk; everything else is copied through. Same output or
it is wrong.
"""
from __future__ import annotations

import json
import os
import random
import sys

import pytest

sys.path.insert(0, os.path.dirname(__file__))
pytest.importorskip("playwright")
from playwright.sync_api import sync_playwright  # noqa: E402
import harness  # noqa: E402


@pytest.fixture(scope="module")
def page(tmp_path_factory):
    with sync_playwright() as pw:
        try:
            b = pw.chromium.launch(args=harness.CHROMIUM_ARGS)
        except Exception as e:  # pragma: no cover
            pytest.skip(f"chrome unavailable: {e}")
        pg = b.new_page()
        pg.goto(harness.write_page(tmp_path_factory.mktemp("m"), harness.build_page()), wait_until="load")
        pg.wait_for_function("() => window.__GS_READY === true", timeout=20000)
        yield pg
        b.close()


def _reads(rnd, n, lo, hi):
    """(start, end, elements[(type, s, e, seq)]) with elements inside the read."""
    out = []
    for i in range(n):
        s = rnd.randint(lo, hi - 200)
        e = s + rnd.randint(50, 400 if i % 7 else 9000)     # a few long reads span several chunks
        els = []
        for _ in range(rnd.randint(0, 4)):
            t = rnd.choice([1, 1, 2, 3, 4])
            p = rnd.randint(s, e - 1)
            els.append((t, p, p if t != 3 else min(e, p + rnd.randint(1, 8)), rnd.choice("ACGT") if t in (1, 2) else ""))
        els.sort(key=lambda x: x[1])
        out.append((f"r{i}", s, e, els, rnd.random() < .5, rnd.choice([0, 1, 2])))
    return out


def _chunk_payload(reads, c0, c1):
    cols = {k: [] for k in ("query_name", "element_type", "reference_start", "reference_end",
                            "is_forward", "haplotype", "sample_name", "sequence")}

    def add(name, t, s, e, fw, hp, seq=""):
        cols["query_name"].append(name); cols["element_type"].append(t); cols["reference_start"].append(s)
        cols["reference_end"].append(e); cols["is_forward"].append(fw); cols["haplotype"].append(hp)
        cols["sample_name"].append("S"); cols["sequence"].append(seq)

    for name, s, e, els, fw, hp in reads:
        if e < c0 or s > c1:
            continue                                        # a BAM window returns overlapping reads only
        add(name, 0, s, e, fw, hp)
        for t, ps, pe, seq in els:
            add(name, t, ps, pe, fw, hp, seq)
    return cols


@pytest.mark.parametrize("seed", [1, 2, 3])
def test_fast_merge_equals_the_general_merge(page, seed):
    rnd = random.Random(seed)
    reads = _reads(rnd, 600, 1, 300000)
    ranges = [(1, 100000), (100001, 200000), (200001, 300000)]
    payloads = [_chunk_payload(reads, a, b) for a, b in ranges]
    got = page.evaluate("([p, r]) => window.__GS_TEST_merge(p, r, false)", [payloads, ranges])
    want = page.evaluate("([p, r]) => window.__GS_TEST_merge(p, r, true)", [payloads, ranges])
    assert got["query_name"] == want["query_name"]
    assert json.dumps(got, sort_keys=True) == json.dumps(want, sort_keys=True)
    # and it really merged something: duplicates at the edges were removed
    total_in = sum(len(p["query_name"]) for p in payloads)
    assert len(got["query_name"]) < total_in
