"""End-to-end integration test against the REAL compiled Rust extension.

This is the "full test harness" the closed-loop workflow proved by hand, made
permanent: build a synthetic multi-sample VCF (bgzip+tabix), attach it through
the actual PyO3 session (`gs._init`), and assert that

  1. the long-format extractor and
  2. the Rust aggregate path (`get_locus_variant_aggregates`)

both agree with brute-force truth computed from the genotypes we wrote. Then
drive view.py's `fetch_carriers` through the real session to prove the
carriers-on-demand path resolves real sample names.

Skips (not fails) when the extension isn't built or bgzip/tabix are absent, so
`pytest python/tests` stays green on a machine that hasn't run
`scripts/setup_test_env.sh`. Run that script first to exercise this file.
"""
import os
import shutil
import subprocess
import sys
from unittest.mock import patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
pytest.importorskip("genomeshader.genomeshader")
import genomeshader.genomeshader as gs  # noqa: E402
from genomeshader.view import GenomeShader  # noqa: E402

pytestmark = pytest.mark.skipif(
    not (shutil.which("bgzip") and shutil.which("tabix")),
    reason="bgzip/tabix not available",
)

# Synthetic cohort: N samples, 3 variants. Genotypes are deterministic so the
# expected aggregate counts are computable here without re-reading the VCF.
N = 200
# (contig, pos, ref, alt). Genotype for sample i decided by a fixed rule below.
SITES = [
    ("chr1", 100, "A", "C"),
    ("chr1", 200, "G", "T"),
    ("chr1", 300, "AT", "A"),  # deletion
]


def _gt(site_idx, i):
    """Deterministic genotype for sample i at site_idx. Mixes hom-ref, het,
    hom-alt, and missing so n_ref/n_alt/n_missing are all non-trivial."""
    r = (i * 7 + site_idx * 3) % 20
    if r == 0:
        return "./."          # missing
    if r < 4:
        return "1/1"          # hom alt  -> 2 alt
    if r < 11:
        return "0/1"          # het      -> 1 ref, 1 alt
    return "0/0"              # hom ref  -> 2 ref


def _expected(site_idx):
    # The Rust aggregate counts SAMPLES, not alleles: n_ref = #samples carrying
    # >=1 ref copy, n_alt = #samples carrying >=1 alt copy (a het counts in
    # BOTH), n_missing = #samples with a missing GT. This is what the viewer's
    # flow bands want ("N samples carry this allele").
    n_ref = n_alt = n_missing = 0
    for i in range(N):
        g = _gt(site_idx, i)
        if g == "./.":
            n_missing += 1
            continue
        toks = g.replace("|", "/").split("/")
        if any(t == "0" for t in toks):
            n_ref += 1
        if any(t not in ("0", ".") for t in toks):
            n_alt += 1
    return n_ref, n_alt, n_missing


@pytest.fixture(scope="module")
def synth_vcf(tmp_path_factory):
    d = tmp_path_factory.mktemp("gs_it")
    raw = d / "synth.vcf"
    samples = [f"S{i}" for i in range(N)]
    lines = [
        "##fileformat=VCFv4.2",
        '##FILTER=<ID=PASS,Description="All filters passed">',
        "##contig=<ID=chr1,length=1000>",
        '##FORMAT=<ID=GT,Number=1,Type=String,Description="Genotype">',
        "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\t" + "\t".join(samples),
    ]
    for si, (contig, pos, ref, alt) in enumerate(SITES):
        gts = "\t".join(_gt(si, i) for i in range(N))
        lines.append(f"{contig}\t{pos}\t.\t{ref}\t{alt}\t.\tPASS\t.\tGT\t{gts}")
    raw.write_text("\n".join(lines) + "\n")

    gz = str(raw) + ".gz"
    with open(gz, "wb") as out:
        subprocess.run(["bgzip", "-c", str(raw)], stdout=out, check=True)
    subprocess.run(["tabix", "-p", "vcf", gz], check=True)
    return gz


def test_aggregate_matches_longformat_and_truth(synth_vcf):
    """Rust aggregate == long-format recompute == brute-force truth, through the
    real compiled session."""
    sess = gs._init(None)
    sess.attach_variants([synth_vcf], [synth_vcf + ".tbi"], None)

    long_df = sess.get_locus_variants("chr1:1-1000")
    assert len(long_df) == N * len(SITES)  # one row per (variant, sample)

    agg_df = sess.get_locus_variant_aggregates("chr1:1-1000")
    assert len(agg_df) == len(SITES)  # one row per (variant, alt)

    agg = {int(r["position"]): r for r in agg_df.iter_rows(named=True)}
    for si, (_c, pos, _ref, _alt) in enumerate(SITES):
        exp = _expected(si)
        row = agg[pos]
        got = (row["n_ref"], row["n_alt"], row["n_missing"])
        assert got == exp, f"site {pos}: agg {got} != truth {exp}"
        assert row["n_samples"] == N


def test_fetch_carriers_through_view(synth_vcf):
    """Drive view.py fetch_carriers over the real session (no UCSC network)."""
    # Create the REAL session BEFORE patching: `genomeshader.view.gs` is the same
    # module object as `gs` here, so patching gs._init also replaces it for this
    # scope — build `real` first, then hand it back from the patched _init.
    real = gs._init(None)
    with patch("genomeshader.view.gs._init", return_value=real), \
         patch("genomeshader.view.requests.get") as mock_get:
        mock_get.return_value.status_code = 200
        mock_get.return_value.json.return_value = {"ucscGenomes": {"hg38": {}}}
        g = GenomeShader(genome_build="hg38",
                         gcs_session_dir="gs://test-bucket/genomeshader")
    g._session.attach_variants([synth_vcf], [synth_vcf + ".tbi"], None)

    # Populate the Rust staged_tree with a wide query FIRST. This is what makes
    # the subsequent single-position "chr1:100-100" hit find_covering_variant_
    # staged_file -> iset.iter(100..100), which panicked before the parse_locus
    # zero-width fix. Without this prior query the regression wouldn't reproduce.
    g.get_locus_variants("chr1:1-1000")

    # Carriers of ALT "C" at chr1:100 == samples with a non-ref allele there.
    carriers = g.fetch_carriers("chr1", 100, "A", "C", n=N)
    expected = {f"S{i}" for i in range(N) if _gt(0, i) not in ("0/0", "./.")}
    assert set(carriers) == expected
    assert carriers  # non-empty sanity

    # Ref-allele carriers (samples carrying at least one ref copy).
    ref_carriers = g.fetch_carriers("chr1", 100, "A", "A", n=N)
    exp_ref = {f"S{i}" for i in range(N) if "0" in _gt(0, i).replace("/", "")}
    assert set(ref_carriers) == exp_ref
