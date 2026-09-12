"""Live GCS integration: a region jump must return fast (reference/genes) and
NOT block on the cohort-scale variant decode.

Needs Google auth (ADC) + network + the Pf7 mirror buckets, so it's skipped
unless GENOMESHADER_RUN_GCS_INTEGRATION=1. Run it in an authed environment:

    GENOMESHADER_RUN_GCS_INTEGRATION=1 pytest python/tests/integration/test_pf7_navigate.py -s

It reproduces the user's setup, then asserts navigate_payload(with_variants=False)
is fast even though the standalone variant decode for the same window is slow —
i.e. the jump is decoupled from the (previously timeout-inducing) decode.
"""
import os
import time

import pytest

if os.environ.get("GENOMESHADER_RUN_GCS_INTEGRATION") != "1":
    pytest.skip("set GENOMESHADER_RUN_GCS_INTEGRATION=1 (needs GCS auth + network)",
                allow_module_level=True)

import genomeshader as G

SESSION = os.environ.get(
    "GENOMESHADER_TEST_SESSION_DIR",
    "gs://fc-b06e896e-cc1d-4deb-b638-f7b87c3e5dbd/tmp/jts_genomeshader_test/genomeshader")
CONTIG = "Pf3D7_01_v3"
# The initial window and a "jump elsewhere" window on the same contig.
JUMP_START, JUMP_END = 100000, 101000
FAST_BUDGET_S = float(os.environ.get("GENOMESHADER_JUMP_BUDGET_S", "20"))


@pytest.fixture(scope="module")
def shader():
    s = G.GenomeShader(genome_build="PlasmoDB-61_Pfalciparum3D7",
                       gcs_session_dir=SESSION, debug=True)
    G.stage_reference(
        s,
        fasta="gs://broad-malaria-public/short_read_workspace_data/reference/PlasmoDB-61_Pfalciparum3D7_Genome.fasta",
        gff="gs://broad-malaria-public/short_read_workspace_data/reference/PlasmoDB-61_Pfalciparum3D7.gff")
    s.attach_variants("pf7", "gs://broad-dsp-pf7-mirror/vcf/")
    s.attach_reads("pf7", "gs://broad-dsp-pf7-mirror/bam/")
    return s


def test_jump_returns_fast_without_variants(shader):
    """navigate_payload(with_variants=False) returns reference + genes quickly."""
    t0 = time.time()
    p = shader.navigate_payload(CONTIG, JUMP_START, JUMP_END, with_variants=False)
    dt = time.time() - t0
    print(f"\n[navigate fast] {dt:.2f}s  ref_len={len(p.get('reference_data') or '')} "
          f"genes={len((p.get('genes_track') or {}).get('series', [{}])[0].get('features') or [])} deferred={p.get('variants_deferred')}")
    assert p["variants_deferred"] is True
    assert p["variant_tracks"] == []
    assert p["reference_data"], "reference did not load on the jump"
    assert dt < FAST_BUDGET_S, f"fast jump took {dt:.1f}s (> {FAST_BUDGET_S}s budget)"


def test_variant_decode_is_the_slow_part(shader):
    """The same window's variant decode (what used to be inline in navigate) is
    the expensive step — this is informational: it prints the cold decode time
    so the contrast with the fast jump is visible. Not asserted (it can vary),
    but it must at least return without raising (no 'real error')."""
    t0 = time.time()
    vp = shader.fetch_variants_payload(CONTIG, JUMP_START, JUMP_END)
    dt = time.time() - t0
    ntracks = len(vp.get("variant_tracks") or [])
    print(f"\n[variant decode] {dt:.2f}s  tracks={ntracks}")
    assert isinstance(vp.get("variant_tracks"), list), "variant decode errored"
