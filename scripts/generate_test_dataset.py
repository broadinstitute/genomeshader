#!/usr/bin/env python3
"""Generate a fake but realistic GenomeShader test dataset.

The files are small, fully synthetic, and planted so three hg38 windows exercise
the display features that are hard to cover with production callsets:

  * haplotagged long-read BAMs (~17 kb at ~15×; HP:i:1 / HP:i:2, plus untagged,
    chimeric, secondary)
  * short-read CRAMs (~35×, 151 bp paired, no haplotag, plus discordant /
    duplicate / MAPQ=0 pairs)
  * a joint VCF of SNVs, MNPs, delins, indels, and SVs with statistical phasing
    (`0|1`, two FORMAT/PS blocks), plus mixed unphased / half-call / missing GTs
  * per-sample TRGT VCFs with unphased genotypes (GT uses `/`, no PS)
  * a gene-rich chr14 window (ARHGAP5 / ARHGAP5-AS1 / LOC105370440), a second
    contig (chr21), a coverage gap, extra BAMs (second flowcell, MD-stripped,
    reads-only sample), and TSV/BED tracks for attach_data()

Reads are simulated against real hg38 slices so the UCSC reference / gene /
repeat tracks line up with the alleles in the reads. CRAM is written
with ``no_ref`` so it decodes without an external FASTA.

Examples::

    python scripts/generate_test_dataset.py
    python scripts/generate_test_dataset.py -o /tmp/gs-testdata
    python scripts/generate_test_dataset.py --upload gs://BUCKET/genomeshader/testdata/

Requires samtools, bgzip, and tabix on PATH.
"""
from __future__ import annotations

import argparse
import json
import os
import random
import shutil
import subprocess
import sys
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, List, Optional, Sequence, Tuple

# ---------------------------------------------------------------------------
# Loci: real hg38 windows so UCSC annotation tracks resolve. 1-based inclusive.
# chr20 is the planted-feature catalog; chr14 is the gene-rich default view.
# ---------------------------------------------------------------------------
CONTIG = "chr20"
CONTIG_LENGTH = 64_444_167  # GRCh38
ORIGIN = 32_000_000          # 1-based position of the first base we fetch
SPAN = 20_000
REGION_END = ORIGIN + SPAN - 1  # 32,019,999
GENOME_BUILD = "hg38"
SAMPLES = ("HG001", "HG002", "HG003", "HG004")
VCF_ONLY_SAMPLE = "HG005"          # in the joint VCF, no BAM/CRAM
ORPHAN_SAMPLE = "HG_ORPHAN"      # BAM only — not in any VCF
VCF_SAMPLES = SAMPLES + (VCF_ONLY_SAMPLE,)
SEED = 42
PHASE_SET = ORIGIN + 5_000       # FORMAT/PS for the main statistically-phased block
PHASE_SET_2 = ORIGIN + 6_880     # second phase set (dense SNP cluster)

# Default viewer window: dense SNVs + small indels, no large SVs.
SHOWCASE = (ORIGIN + 5_000, ORIGIN + 6_800)  # chr20:32005000-32006800
DEEP_PILEUP = (ORIGIN + 5_200, ORIGIN + 5_360)  # extra Illumina depth on top of ~35x
COVERAGE_GAP = (ORIGIN + 18_800, ORIGIN + 19_400)  # no reads on purpose

# Read-length / coverage targets (diploid, interior of the slice).
LONG_READ_MEAN = 17_000
LONG_READ_HALF_RANGE = 5_000      # 12–22 kb
LONG_READ_COVERAGE = 15            # diploid
SHORT_READ_LEN = 151
SHORT_READ_COVERAGE = 35         # diploid, 30–40x

# Second contig for contig-switch tests.
CONTIG2 = "chr21"
CONTIG2_LENGTH = 46_709_983
ORIGIN2 = 15_000_000
SPAN2 = 5_000
REGION2_END = ORIGIN2 + SPAN2 - 1  # 15,004,999
SHOWCASE2 = (ORIGIN2 + 1_000, ORIGIN2 + 3_000)

# Gene-rich window (LOC105370440, ARHGAP5-AS1, ARHGAP5, RNU6-7/8).
CONTIG3 = "chr14"
CONTIG3_LENGTH = 107_043_718
ORIGIN3 = 31_988_133
SPAN3 = 32_254_546 - ORIGIN3 + 1  # 266,414 bp
REGION3_END = ORIGIN3 + SPAN3 - 1  # 32,254,546
# Default viewer: dense haplotype block in ARHGAP5 5' (~2.8 kb, like chr20).
# Zoom out to SHOWCASE3_GENES for ARHGAP5-AS1 + the 8 bp INS.
SHOWCASE3 = (32_079_800, 32_082_600)
SHOWCASE3_GENES = (32_075_000, 32_090_000)
PHASE_SET_14 = 32_080_000


def other_base(b: str, rng: random.Random, extra: Optional[str] = None) -> str:
    choices = [x for x in "ACGT" if x != b.upper() and x != (extra or "")]
    return rng.choice(choices)


def run(cmd: Sequence[str], **kw) -> None:
    subprocess.run(cmd, check=True, **kw)


def require_tools() -> None:
    missing = [t for t in ("samtools", "bgzip", "tabix") if shutil.which(t) is None]
    if missing:
        sys.exit(f"missing required tool(s): {', '.join(missing)}")


def mean_depth(path: Path, region: str) -> float:
    proc = subprocess.run(
        ["samtools", "depth", "-a", "-r", region, str(path)],
        check=True, capture_output=True, text=True,
    )
    ds = [int(line.split("\t")[2]) for line in proc.stdout.splitlines() if line]
    return (sum(ds) / len(ds)) if ds else 0.0


# ---------------------------------------------------------------------------
# Variant catalog
# ---------------------------------------------------------------------------
Gt = Tuple[Optional[int], Optional[int]]  # allele indices; None = missing


@dataclass
class Site:
    """One planted variant. ``ref`` / ``alts`` are filled after the FASTA loads."""
    sid: str
    pos: int
    kind: str  # snv, ins, del, sv_seq, sv_sym, tr, mnp, delins, bnd, star
    gts: List[Gt]
    alts_spec: List[str] = field(default_factory=list)  # SNV letters, or insertion seqs
    del_len: int = 0
    svtype: str = ""
    svlen: int = 0
    tr_span: int = 0
    mnp_len: int = 0
    filt: str = "PASS"
    note: str = ""
    ref: str = ""
    alts: List[str] = field(default_factory=list)
    phased: bool = True
    chrom: str = CONTIG
    phase_set: int = PHASE_SET
    extra_info: dict = field(default_factory=dict)
    extra_gts: dict = field(default_factory=dict)  # sample -> Gt (VCF-only samples)

    @property
    def end(self) -> int:
        if self.kind in ("del", "sv_seq") and self.del_len:
            return self.pos + self.del_len
        if self.kind == "sv_sym":
            return self.pos + abs(self.svlen) - 1
        if self.kind == "tr":
            return self.pos + self.tr_span - 1
        if self.kind == "mnp" and self.mnp_len:
            return self.pos + self.mnp_len - 1
        if self.kind == "delins" and self.ref:
            return self.pos + len(self.ref) - 1
        return self.pos


def _g(*pairs: Gt) -> List[Gt]:
    assert len(pairs) == len(SAMPLES)
    return list(pairs)


def catalog(rng: random.Random) -> List[Site]:
    """Planted sites. REF/ALT sequences filled later from the FASTA.

    Genotype tuples are (hap1, hap2) with 0=REF, 1=first ALT, 2=second ALT.
    """
    # Shorthand
    r = (0, 0)
    h10 = (1, 0)
    h01 = (0, 1)
    h11 = (1, 1)
    miss = (None, None)

    sites: List[Site] = [
        Site("snv_common", ORIGIN + 5_120, "snv",
             _g(h01, h10, h11, r),
             note="common het/hom-alt mix; ribbons should switch phase across samples"),
        Site("snv_homalt", ORIGIN + 5_180, "snv",
             _g(h11, h11, r, r),
             note="hom-alt in HG001/HG002, hom-ref in HG003/HG004"),
        Site("snv_multi", ORIGIN + 5_240, "snv",
             _g((0, 1), (0, 2), (1, 2), (0, 0)),
             alts_spec=["C", "T"],  # filled as two alts different from ref
             note="tri-allelic SNV; flow should show three non-ref bands"),
        Site("hapblock_1", ORIGIN + 5_300, "snv",
             _g(h01, h10, h01, h10),
             note="three consecutive phased SNVs (haplotype block / ribbon test)"),
        Site("hapblock_2", ORIGIN + 5_301, "snv",
             _g(h01, h10, h01, h10),
             note="haplotype block base 2 — same phase as hapblock_1"),
        Site("hapblock_3", ORIGIN + 5_302, "snv",
             _g(h01, h10, h01, h10),
             note="haplotype block base 3 — same phase as hapblock_1"),
        Site("snv_lowqual", ORIGIN + 5_380, "snv",
             _g(h01, r, r, r), filt="LowQual",
             note="FILTER=LowQual; INFO panel + filter status"),
        Site("mnp_3bp", ORIGIN + 5_420, "mnp",
             _g(h01, h10, r, r), mnp_len=3,
             note="3bp MNP — variantType=mnp, SUB 3 bp in the allele card"),
        Site("delins", ORIGIN + 5_480, "delins",
             _g(h01, r, h10, r), del_len=5, alts_spec=["TG"],
             note="complex delins (5bp→2bp) — variantType=complex"),
        Site("del_1bp", ORIGIN + 5_520, "del",
             _g(h01, h10, h11, r), del_len=1,
             note="1bp deletion"),
        Site("ins_1bp", ORIGIN + 5_640, "ins",
             _g(h01, h10, r, r), alts_spec=["G"],
             note="1bp insertion"),
        Site("ins_12bp", ORIGIN + 5_780, "ins",
             _g(h01, h10, h11, r), alts_spec=["GATTACAAGGAT"],
             note="12bp insertion — expandable lollipop / insertion tiles"),
        Site("del_8bp", ORIGIN + 5_940, "del",
             _g(h01, h10, r, r), del_len=8,
             note="8bp deletion"),
        Site("ins_40bp", ORIGIN + 6_120, "ins",
             _g(h01, r, h11, r), alts_spec=["ACGTACGTACGTACGTACGTACGTACGTACGTACGTACGT"],
             note="40bp insertion — wide expandable gap, hom-alt in HG003"),
        Site("ins_multi", ORIGIN + 6_280, "ins",
             _g((0, 1), (0, 2), (1, 2), r),
             alts_spec=["GATTACA", "GATTACAGATTACA"],
             note="multi-allelic insertion (7bp and 14bp ALTs); flow shows two INS bands"),
        Site("unphased_het", ORIGIN + 6_340, "snv",
             _g(h01, h10, r, r), phased=False,
             note="unphased 0/1 in an otherwise-phased VCF (no PS) — mixed phasing"),
        Site("compound_a", ORIGIN + 6_420, "snv",
             _g(h10, h01, r, r),
             note="compound-het with compound_b in HG001 (this allele on hap1)"),
        Site("compound_b", ORIGIN + 6_580, "snv",
             _g(h01, h10, r, r),
             note="compound-het with compound_a in HG001 (this allele on hap2)"),
        Site("snv_missing", ORIGIN + 6_640, "snv",
             _g(h01, h10, h01, miss),
             note="missing GT (./.) in HG004"),
        # Tandem-repeat loci: also emitted as unphased TRGT VCFs.
        Site("tr_cag", ORIGIN + 6_740, "tr",
             _g((0, 1), (1, 1), (1, 2), (0, 0)),
             alts_spec=["CAG", "CAG"],  # motifs; expansions filled later
             tr_span=30, phased=False,
             note="CAG-like TR — TRGT track, unphased 0/1 and 1/2"),
        Site("dense_1", ORIGIN + 6_880, "snv",
             _g(h01, h10, h01, h10), phase_set=PHASE_SET_2,
             note="dense SNP cluster in a SECOND phase set (PS break vs the main block)"),
        Site("dense_2", ORIGIN + 6_888, "snv",
             _g(h01, h10, h01, h10), phase_set=PHASE_SET_2,
             note="dense cluster base 2"),
        Site("dense_3", ORIGIN + 6_896, "snv",
             _g(h01, h10, h01, h10), phase_set=PHASE_SET_2,
             note="dense cluster base 3"),
        Site("dense_4", ORIGIN + 6_904, "snv",
             _g(h01, h10, h01, h10), phase_set=PHASE_SET_2,
             note="dense cluster base 4"),
        Site("dense_5", ORIGIN + 6_912, "snv",
             _g(h01, h10, h01, h10), phase_set=PHASE_SET_2,
             note="dense cluster base 5"),
        Site("dense_6", ORIGIN + 6_920, "snv",
             _g(h01, h10, h01, h10), phase_set=PHASE_SET_2,
             note="dense cluster base 6 — six SNVs in 40 bp"),
        Site("snv_halfcall", ORIGIN + 7_050, "snv",
             _g((0, None), h01, r, r),
             note="half-call 0|. in HG001 (one allele missing, still in the phase set)"),
        Site("snv_homref", ORIGIN + 7_120, "snv",
             _g(r, r, r, r),
             extra_gts={VCF_ONLY_SAMPLE: (0, 0)},
             note="hom-ref in every sample — site is still listed in the variant table"),
        Site("snv_noqual", ORIGIN + 7_180, "snv",
             _g(h01, r, r, r),
             note="QUAL=. (missing) in the VCF"),
        Site("ins_200bp", ORIGIN + 7_200, "ins",
             _g(h01, r, r, r),
             alts_spec=["ACGT" * 50],
             note="200bp insertion — stress-test expandable insertion gap"),
        Site("snv_vqsr", ORIGIN + 7_450, "snv",
             _g(h01, r, r, r), filt="VQSRTranche99.90",
             note="FILTER=VQSRTranche99.90"),
        Site("snv_clinvar", ORIGIN + 7_600, "snv",
             _g(h01, h10, r, r),
             extra_info={
                 "DP": "42", "MQ": "58.2", "QD": "12.1", "FS": "1.4", "SOR": "0.8",
                 "MQRankSum": "-0.3", "ReadPosRankSum": "0.1",
                 "CLNSIG": "Pathogenic", "CLNDN": "Fake_disease",
                 "SOMATIC": True,
                 "CSQ": "T|missense_variant|MODERATE|FAKEGENE|ENSG00000000001|"
                        "Transcript|ENST00000000001|protein_coding|5/10",
             },
             extra_gts={VCF_ONLY_SAMPLE: (0, 1)},
             note="INFO-rich site (ClinVar+CSQ+GATK QC); HG005 (VCF-only) is 0|1 here"),
        Site("snv_singleton", ORIGIN + 7_750, "snv",
             _g(h01, r, r, r),
             note="rare singleton (only HG001 carries ALT)"),
        Site("sv_del_180", ORIGIN + 8_000, "sv_seq",
             _g(h01, h10, r, r), del_len=180,
             note="180bp sequence-resolved deletion (long-read CIGAR D)"),
        Site("star_overlap", ORIGIN + 8_080, "star",
             _g((1, 0), (0, 1), r, r),
             note="ALT=* spanning-deletion allele overlapping sv_del_180 (VCF only)"),
        Site("sv_ins_90", ORIGIN + 9_800, "ins",
             _g(h01, r, h10, r),
             alts_spec=["GATC" * 22 + "AC"],  # 90 bp
             note="90bp sequence-resolved insertion (SV-scale expandable gap)"),
        Site("tr_aagg", ORIGIN + 11_080, "tr",
             _g((0, 1), (0, 2), (1, 2), (0, 1)),
             alts_spec=["AAGG", "AAGG"],
             tr_span=24, phased=False,
             note="AAGG tetranucleotide TR — second TRGT locus"),
        Site("sv_del_sym", ORIGIN + 12_500, "sv_sym",
             _g(h01, h10, r, r), svtype="DEL", svlen=-400,
             note="symbolic <DEL> 400bp (INFO/SVTYPE+END); not in read CIGARs"),
        Site("sv_dup_sym", ORIGIN + 14_500, "sv_sym",
             _g(h01, r, h11, r), svtype="DUP", svlen=600,
             note="symbolic <DUP> 600bp"),
        Site("sv_inv_sym", ORIGIN + 16_800, "sv_sym",
             _g(h01, h10, r, r), svtype="INV", svlen=250,
             note="symbolic <INV> 250bp"),
        Site("sv_ins_sym", ORIGIN + 18_200, "sv_sym",
             _g(h01, r, r, r), svtype="INS", svlen=120,
             note="symbolic <INS> 120bp"),
        Site("bnd_breakend", ORIGIN + 10_400, "bnd",
             _g(h01, r, r, r),
             note="BND breakend N[chr20:32015400[ — symbolic ALT display"),
        Site("cnv_cn", ORIGIN + 10_650, "sv_sym",
             _g(h01, h10, r, r), svtype="CNV", svlen=800,
             note="symbolic <CNV> 800bp"),
        # chr21 — contig-switch: a second sequence with its own SNVs + reads.
        Site("chr21_snv_a", ORIGIN2 + 1_200, "snv",
             _g(h01, h10, h11, r), chrom=CONTIG2,
             note="chr21 SNV — contig-switch / second-chrom routing"),
        Site("chr21_snv_b", ORIGIN2 + 2_400, "snv",
             _g(h11, r, h01, r), chrom=CONTIG2,
             note="chr21 SNV 2"),
        Site("chr21_ins", ORIGIN2 + 1_800, "ins",
             _g(h01, r, r, r), alts_spec=["TTAGGG"], chrom=CONTIG2,
             note="chr21 6bp insertion"),
        # chr14 — gene-rich window (LOC105370440 / ARHGAP5-AS1 / ARHGAP5).
        Site("chr14_loc_snv", 32_050_000, "snv",
             _g(h01, h10, r, h11), chrom=CONTIG3,
             note="SNV in LOC105370440"),
        Site("chr14_as_snv", 32_076_050, "snv",
             _g(h10, h01, h01, r), chrom=CONTIG3, phase_set=PHASE_SET_14,
             note="SNV in ARHGAP5-AS1"),
        Site("chr14_arhgap5_snv", 32_080_000, "snv",
             _g(h01, h10, h11, r), chrom=CONTIG3, phase_set=PHASE_SET_14,
             extra_gts={VCF_ONLY_SAMPLE: (0, 1)},
             note="phased SNV in ARHGAP5 5'; HG005 is 0|1 here"),
        *[
            Site(
                f"chr14_block_{i + 1}",
                32_080_040 + i * 80,
                "snv",
                _g(h01, h10, h01, h10) if i % 2 == 0 else _g(h10, h01, h10, h01),
                chrom=CONTIG3,
                phase_set=PHASE_SET_14,
                note="dense ARHGAP5 haplotype-block SNV",
            )
            for i in range(12)
        ],
        Site("chr14_arhgap5_het", 32_082_400, "snv",
             _g(h10, r, h01, h10), chrom=CONTIG3, phase_set=PHASE_SET_14,
             note="second ARHGAP5 SNV in the same phase set"),
        Site("chr14_arhgap5_ins", 32_085_000, "ins",
             _g(h01, r, h10, r), alts_spec=["ACGTACGT"], chrom=CONTIG3,
             phase_set=PHASE_SET_14,
             note="8bp insertion in ARHGAP5"),
        Site("chr14_arhgap5_del", 32_120_000, "del",
             _g(h10, h01, r, r), del_len=12, chrom=CONTIG3,
             note="12bp deletion in ARHGAP5 body"),
        Site("chr14_arhgap5_end", 32_159_200, "snv",
             _g(h11, h01, r, h10), chrom=CONTIG3,
             note="SNV near ARHGAP5 3' end"),
        Site("chr14_rnu6", 32_202_080, "snv",
             _g(h01, r, r, r), chrom=CONTIG3,
             note="SNV next to RNU6-7"),
    ]
    # Fill SNV alts that weren't specified — keep deterministic via rng.
    # Actual REF/ALT strings are resolved after the FASTA is in hand.
    _ = rng
    return sites


def fill_alleles(sites: List[Site], sequences: dict, rng: random.Random) -> None:
    """sequences: chrom -> (origin_1based, seq)."""
    def at(site: Site, n: int = 1) -> str:
        origin, seq = sequences[site.chrom]
        i = site.pos - origin
        return seq[i:i + n].upper()

    for s in sites:
        if s.kind == "snv":
            s.ref = at(s, 1)
            if s.alts_spec:
                alts = []
                used = {s.ref}
                for letter in s.alts_spec:
                    a = letter.upper() if letter.upper() not in used else other_base(s.ref, rng)
                    if a == s.ref or a in used:
                        a = other_base(s.ref, rng, extra="".join(used))
                    alts.append(a)
                    used.add(a)
                s.alts = alts
            else:
                s.alts = [other_base(s.ref, rng)]
        elif s.kind == "mnp":
            n = s.mnp_len or 3
            s.ref = at(s, n)
            s.alts = ["".join(other_base(b, rng) for b in s.ref)]
        elif s.kind == "delins":
            s.ref = at(s, s.del_len or 5)
            s.alts = [spec.upper() for spec in s.alts_spec] or ["TG"]
        elif s.kind == "ins":
            s.ref = at(s, 1)
            s.alts = [s.ref + spec for spec in s.alts_spec]
        elif s.kind in ("del", "sv_seq"):
            s.ref = at(s, s.del_len + 1)
            s.alts = [s.ref[0]]
        elif s.kind == "sv_sym":
            s.ref = at(s, 1)
            s.alts = [f"<{s.svtype}>"]
        elif s.kind == "tr":
            s.ref = at(s, s.tr_span)
            motif = (s.alts_spec[0] if s.alts_spec else "CAG").upper()
            s.alts = [s.ref + motif * 2, s.ref + motif * 5]
        elif s.kind == "bnd":
            s.ref = at(s, 1)
            mate = s.pos + 5_000
            s.alts = [f"N[{s.chrom}:{mate}["]
        elif s.kind == "star":
            s.ref = at(s, 1)
            s.alts = ["*"]
        else:
            raise ValueError(s.kind)


# ---------------------------------------------------------------------------
# Haplotype construction + read slicing
# ---------------------------------------------------------------------------
@dataclass
class Block:
    op: str          # M, I, D
    ref_start: int   # 1-based; for I, the ref pos AFTER which the insertion sits
    qstart: int      # 0-based index into hap_seq (D: junction index)
    query: str       # M/I sequence; empty for D
    ref_seq: str     # M/D reference bases; empty for I


def build_haplotype(seq: str, origin: int, edits: List[Tuple[int, str, str]]) -> Tuple[str, List[Block]]:
    """Apply (pos, ref, alt) edits to the slice. Returns (hap_seq, blocks)."""
    edits = sorted(edits, key=lambda e: e[0])
    hap: List[str] = []
    blocks: List[Block] = []
    gpos = origin
    qcur = 0
    ei = 0
    end = origin + len(seq) - 1

    def match_run(upto: int) -> None:
        nonlocal gpos, qcur
        if upto < gpos:
            return
        sl = seq[gpos - origin:upto - origin + 1].upper()
        if not sl:
            return
        hap.append(sl)
        blocks.append(Block("M", gpos, qcur, sl, sl))
        qcur += len(sl)
        gpos = upto + 1

    while gpos <= end:
        if ei < len(edits) and edits[ei][0] == gpos:
            pos, ref_a, alt = edits[ei]
            ei += 1
            # Equal-length alleles (SNVs/MNPs) stay in M so they show up as
            # mismatches via MD, not as a 1D1I delins. Length-changing alleles
            # keep the shared prefix as M, then D the rest of REF / I the rest of ALT.
            if len(ref_a) == len(alt):
                hap.append(alt)
                blocks.append(Block("M", gpos, qcur, alt, ref_a))
                qcur += len(alt)
                gpos += len(ref_a)
                continue
            i = 0
            while i < len(ref_a) and i < len(alt) and ref_a[i] == alt[i]:
                i += 1
            if i:
                sl = alt[:i]
                hap.append(sl)
                blocks.append(Block("M", gpos, qcur, sl, ref_a[:i]))
                qcur += i
                gpos += i
            if len(ref_a) > i:
                deleted = ref_a[i:]
                blocks.append(Block("D", gpos, qcur, "", deleted))
                gpos += len(deleted)
            if len(alt) > i:
                inserted = alt[i:]
                hap.append(inserted)
                blocks.append(Block("I", gpos, qcur, inserted, ""))
                qcur += len(inserted)
        else:
            nxt = edits[ei][0] - 1 if ei < len(edits) else end
            match_run(min(nxt, end))
    return "".join(hap), blocks


def slice_read(hap_seq: str, blocks: List[Block], qstart: int, qend: int
               ) -> Optional[Tuple[int, List[Tuple[int, str]], str]]:
    """Clip haplotype [qstart, qend) to a (leftmost_ref_pos, cigar, seq) alignment."""
    qstart = max(0, qstart)
    qend = min(len(hap_seq), qend)
    if qstart >= qend:
        return None
    seq = hap_seq[qstart:qend]
    cigar: List[Tuple[int, str]] = []
    leftmost: Optional[int] = None

    for b in blocks:
        if b.op == "D":
            # Include only if the read has hap bases on both sides of the junction.
            if qstart < b.qstart < qend:
                cigar.append((len(b.ref_seq), "D"))
                if leftmost is None:
                    leftmost = b.ref_start
            continue
        bq0, bq1 = b.qstart, b.qstart + len(b.query)
        lo, hi = max(qstart, bq0), min(qend, bq1)
        if lo >= hi:
            continue
        off = lo - bq0
        take = hi - lo
        if b.op == "M":
            if leftmost is None:
                leftmost = b.ref_start + off
            cigar.append((take, "M"))
        elif b.op == "I":
            cigar.append((take, "I"))
            if leftmost is None:
                # Insertion-only leading clip: POS is the ref base to the right.
                leftmost = b.ref_start
    if not seq or leftmost is None:
        return None
    cigar = merge_cigar(cigar)
    return leftmost, cigar, seq


def merge_cigar(ops: List[Tuple[int, str]]) -> List[Tuple[int, str]]:
    out: List[Tuple[int, str]] = []
    for n, op in ops:
        if n <= 0:
            continue
        if out and out[-1][1] == op:
            out[-1] = (out[-1][0] + n, op)
        else:
            out.append((n, op))
    return out


def cigar_str(ops: Iterable[Tuple[int, str]]) -> str:
    return "".join(f"{n}{op}" for n, op in ops if n)


def compute_md(seq: str, pos: int, cigar: List[Tuple[int, str]], ref: str, origin: int) -> str:
    """MD tag from CIGAR + query + slice reference (origin-based)."""
    parts: List[str] = []
    matches = 0
    q = 0
    rpos = pos

    def flush_matches() -> None:
        nonlocal matches
        if matches:
            parts.append(str(matches))
            matches = 0

    for n, op in cigar:
        if op == "M":
            for k in range(n):
                rb = ref[rpos - origin].upper()
                qb = seq[q].upper()
                if qb == rb:
                    matches += 1
                else:
                    flush_matches()
                    parts.append(rb)
                q += 1
                rpos += 1
        elif op == "D":
            deleted = ref[rpos - origin:rpos - origin + n].upper()
            flush_matches()
            parts.append("^" + deleted)
            rpos += n
        elif op in ("I", "S"):
            q += n
        elif op == "N":
            rpos += n
    flush_matches()
    return "".join(parts) or "0"


def nm_tag(seq: str, pos: int, cigar: List[Tuple[int, str]], ref: str, origin: int) -> int:
    nm = 0
    q = 0
    rpos = pos
    for n, op in cigar:
        if op == "M":
            for k in range(n):
                if seq[q].upper() != ref[rpos - origin].upper():
                    nm += 1
                q += 1
                rpos += 1
        elif op in ("I", "D"):
            nm += n
            if op == "I":
                q += n
            else:
                rpos += n
        elif op == "S":
            q += n
    return nm


# ---------------------------------------------------------------------------
# FASTA
# ---------------------------------------------------------------------------
_UCSC_SEQ_CHUNK = 80_000


def _ucsc_dna(chrom: str, origin: int, span: int) -> str:
    """Fetch `span` bp starting at 1-based `origin` from the UCSC sequence API."""
    start0, end0 = origin - 1, origin + span - 1
    url = (
        f"https://api.genome.ucsc.edu/getData/sequence?genome={GENOME_BUILD}"
        f";chrom={chrom};start={start0};end={end0}"
    )
    print(f"fetching hg38 {chrom}:{origin}-{origin + span - 1} from UCSC…")
    with urllib.request.urlopen(url, timeout=120) as resp:
        payload = json.loads(resp.read().decode())
    seq = payload["dna"].upper()
    if len(seq) != span:
        sys.exit(f"UCSC returned {len(seq)} bp, expected {span} for "
                 f"{chrom}:{origin}-{origin + span - 1}")
    return seq


def fetch_hg38_slice(cache: Path, chrom: str, origin: int, span: int) -> str:
    cache.parent.mkdir(parents=True, exist_ok=True)
    if cache.is_file():
        seq = cache.read_text().strip().upper()
        if len(seq) == span and set(seq) <= set("ACGTN"):
            return seq
    if span <= _UCSC_SEQ_CHUNK:
        seq = _ucsc_dna(chrom, origin, span)
    else:
        parts = []
        off = 0
        while off < span:
            n = min(_UCSC_SEQ_CHUNK, span - off)
            parts.append(_ucsc_dna(chrom, origin + off, n))
            off += n
        seq = "".join(parts)
    cache.write_text(seq + "\n")
    return seq


def write_fasta(path: Path, chrom: str, origin: int, seq: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    end = origin + len(seq) - 1
    with path.open("w") as fh:
        fh.write(f">{chrom}:{origin}-{end}\n")
        for i in range(0, len(seq), 80):
            fh.write(seq[i:i + 80] + "\n")
    run(["samtools", "faidx", str(path)])


# ---------------------------------------------------------------------------
# Alignments
# ---------------------------------------------------------------------------
SKIP_READ_KINDS = frozenset({"sv_sym", "bnd", "star"})


def hap_edits_for(sites: List[Site], sample_idx: int, hap: int, chrom: str
                  ) -> List[Tuple[int, str, str]]:
    edits = []
    for s in sites:
        if s.chrom != chrom or s.kind in SKIP_READ_KINDS:
            continue
        if sample_idx < 0 or sample_idx >= len(s.gts):
            continue
        a1, a2 = s.gts[sample_idx]
        allele = (a1, a2)[hap]
        if allele is None or allele == 0:
            continue
        edits.append((s.pos, s.ref, s.alts[allele - 1]))
    return edits


def add_noise(seq: str, cigar: List[Tuple[int, str]], rng: random.Random,
              rate: float) -> str:
    """Substitute a few matched bases (CIGAR stays M; MD records the diffs)."""
    chars = list(seq)
    q = 0
    for n, op in cigar:
        if op == "M":
            for k in range(n):
                if rng.random() < rate and chars[q] in "ACGT":
                    chars[q] = other_base(chars[q], rng)
                q += 1
        elif op in ("I", "S"):
            q += n
    return "".join(chars)


def sam_header(sample: str, platform: str, rg_ids: Sequence[str]) -> str:
    pl = "PACBIO" if platform == "pacbio" else "ILLUMINA"
    lines = [
        "@HD\tVN:1.6\tSO:unsorted",
        f"@SQ\tSN:{CONTIG}\tLN:{CONTIG_LENGTH}",
        f"@SQ\tSN:{CONTIG2}\tLN:{CONTIG2_LENGTH}",
        f"@SQ\tSN:{CONTIG3}\tLN:{CONTIG3_LENGTH}",
    ]
    for rg_id in rg_ids:
        lines.append(
            f"@RG\tID:{rg_id}\tSM:{sample}\tPL:{pl}\tLB:fake-{platform}\tDS:GenomeShader fake testdata"
        )
    lines.append("@CO\tSynthetic reads for GenomeShader display tests. Not biological.")
    return "\n".join(lines) + "\n"


def write_sam_record(fh, *, qname, flag, pos, mapq, cigar, seq, qual, extra: str,
                     contig: str = CONTIG, rnext="*", pnext=0, tlen=0) -> None:
    fh.write("\t".join([
        qname, str(flag), contig, str(pos), str(mapq), cigar_str(cigar),
        rnext, str(pnext), str(tlen), seq, qual, extra,
    ]) + "\n")


def find_homopolymer(seq: str, origin: int, min_run: int = 8
                     ) -> Optional[Tuple[int, str, int]]:
    """Return (pos, base, run_len) of a homopolymer, preferring the showcase."""
    best = None
    i = 0
    while i < len(seq):
        j = i + 1
        while j < len(seq) and seq[j] == seq[i] and seq[i] in "ACGT":
            j += 1
        run = j - i
        if run >= min_run:
            pos = origin + i
            rec = (pos, seq[i].upper(), run)
            if SHOWCASE[0] <= pos <= SHOWCASE[1]:
                return rec
            if best is None:
                best = rec
        i = j
    return best


def _overlaps(start: int, cigar: List[Tuple[int, str]], gap: Tuple[int, int]) -> bool:
    consumed = sum(n for n, op in cigar if op in "MDN")
    end = start + max(0, consumed) - 1
    return not (end < gap[0] or start > gap[1])


def sample_long_read_len(rng: random.Random) -> int:
    return rng.randint(
        LONG_READ_MEAN - LONG_READ_HALF_RANGE,
        LONG_READ_MEAN + LONG_READ_HALF_RANGE,
    )


def trim_alignment_to_ref_end(
    pos: int, cigar: List[Tuple[int, str]], seq: str, last_ref: int,
) -> Optional[Tuple[List[Tuple[int, str]], str]]:
    """Keep the prefix of an alignment whose last reference base is ``last_ref``."""
    if pos > last_ref:
        return None
    new_cigar: List[Tuple[int, str]] = []
    q = 0
    r = pos
    for n, op in cigar:
        if op == "M":
            if r > last_ref:
                break
            take = min(n, last_ref - r + 1)
            if take <= 0:
                break
            new_cigar.append((take, "M"))
            q += take
            r += take
            if take < n:
                break
        elif op in ("I", "S"):
            if r > last_ref:
                break
            new_cigar.append((n, op))
            q += n
        elif op in ("D", "N"):
            if r > last_ref:
                break
            take = min(n, last_ref - r + 1)
            if take <= 0:
                break
            new_cigar.append((take, op))
            r += take
            if take < n:
                break
        else:
            q += n
    if q < 50 or not new_cigar:
        return None
    return merge_cigar(new_cigar), seq[:q]


def clip_for_gap(
    pos: int, cigar: List[Tuple[int, str]], seq: str, gap: Tuple[int, int],
) -> Optional[Tuple[List[Tuple[int, str]], str]]:
    """Drop reads that start in ``gap``; trim reads that would extend into it."""
    consumed = sum(n for n, op in cigar if op in "MDN")
    end = pos + max(0, consumed) - 1
    if end < gap[0] or pos > gap[1]:
        return cigar, seq
    if pos >= gap[0]:
        return None
    return trim_alignment_to_ref_end(pos, cigar, seq, gap[0] - 1)


def emit_long_reads(fh, sample: str, sample_idx: int, seq: str, sites: List[Site],
                    rng: random.Random, *, contig: str, origin: int,
                    rg: str, name_prefix: str, skip_gap: bool = False,
                    extra_stutter: bool = False,
                    coverage: float = LONG_READ_COVERAGE,
                    untagged: int = 2,
                    max_reads: Optional[int] = None) -> int:
    n = 0
    edits = [hap_edits_for(sites, sample_idx, h, contig) for h in (0, 1)]
    if extra_stutter:
        hp = find_homopolymer(seq, origin)
        if hp:
            pos, base, _run = hp
            # 1bp insertion on hap2 only — shows up in HP=2 reads, not in the VCF.
            edits[1] = edits[1] + [(pos, base, base + base)]
    haps = [build_haplotype(seq, origin, e) for e in edits]

    def emit(hseq, blocks, hap_tag: Optional[int], qstart: int, qlen: int,
              reverse: bool, soft_l: int, soft_r: int, mapq: int, name: str,
              rg_id: str, with_md: bool) -> None:
        nonlocal n
        if max_reads is not None and n >= max_reads:
            return
        qend = min(len(hseq), qstart + qlen)
        if qend - qstart < 200:
            return
        sliced = slice_read(hseq, blocks, qstart, qend)
        if sliced is None:
            return
        pos, cigar, rseq = sliced
        if len(rseq) < 200:
            return
        if skip_gap:
            clipped = clip_for_gap(pos, cigar, rseq, COVERAGE_GAP)
            if clipped is None:
                return
            cigar, rseq = clipped
        rseq = add_noise(rseq, cigar, rng, 0.0015)
        if soft_l:
            rseq = "".join(rng.choice("ACGT") for _ in range(soft_l)) + rseq
            cigar = [(soft_l, "S")] + cigar
        if soft_r:
            rseq = rseq + "".join(rng.choice("ACGT") for _ in range(soft_r))
            cigar = cigar + [(soft_r, "S")]
        cigar = merge_cigar(cigar)
        qual = chr(33 + 60) * len(rseq)
        flag = 16 if reverse else 0
        nm = nm_tag(rseq, pos, cigar, seq, origin)
        tags = [f"RG:Z:{rg_id}", f"NM:i:{nm}"]
        if with_md:
            tags.append(f"MD:Z:{compute_md(rseq, pos, cigar, seq, origin)}")
        if hap_tag is not None:
            tags.append(f"HP:i:{hap_tag}")
        write_sam_record(fh, qname=name, flag=flag, pos=pos, mapq=mapq,
                          cigar=cigar, seq=rseq, qual=qual, extra="\t".join(tags),
                          contig=contig)
        n += 1

    for hap_i, (hseq, blocks) in enumerate(haps):
        if len(hseq) < 500:
            continue
        effective = LONG_READ_MEAN
        step = max(200, int(effective / max(0.5, coverage / 2)))
        q = -LONG_READ_MEAN + rng.randint(0, max(1, step // 4))
        k = 0
        while q < len(hseq) - 200:
            if max_reads is not None and n >= max_reads:
                break
            reverse = (k % 5 == 2)
            soft_l = rng.choice([0, 0, 0, 8, 12, 18])
            soft_r = rng.choice([0, 0, 0, 8, 15])
            mapq = 60 if k % 11 else 20
            emit(hseq, blocks, hap_i + 1, q, sample_long_read_len(rng), reverse,
                 soft_l, soft_r, mapq,
                 f"{name_prefix}:h{hap_i + 1}:{k}", rg, with_md=(k % 7 != 0))
            q += step
            k += 1

    hseq, blocks = haps[0]
    for k in range(untagged):
        q = rng.randint(-LONG_READ_MEAN // 2, max(0, len(hseq) - 2_000))
        emit(hseq, blocks, None, q, sample_long_read_len(rng), False, 0, 0, 60,
             f"{name_prefix}:unphased:{k}", rg, with_md=True)

    if contig == CONTIG and max_reads is None:
        # Chimeric / supplementary pair: primary on chr20, SA mate on chr21.
        hseq, blocks = haps[0]
        sliced = slice_read(hseq, blocks, 200, 700)
        if sliced is not None:
            pos_p, cig, rseq = sliced
            if not (skip_gap and _overlaps(pos_p, cig, COVERAGE_GAP)):
                qual = chr(33 + 60) * len(rseq)
                sa_pri = f"{CONTIG2},{SHOWCASE2[0]},+,{len(rseq)}M,60,0;"
                sa_sup = f"{contig},{pos_p},+,{cigar_str(cig)},60,0;"
                tags_p = f"RG:Z:{rg}\tNM:i:0\tSA:Z:{sa_pri}"
                write_sam_record(
                    fh, qname=f"{name_prefix}:chimeric:0", flag=0, pos=pos_p,
                    mapq=60, cigar=cig, seq=rseq, qual=qual, extra=tags_p,
                    contig=contig,
                )
                write_sam_record(
                    fh, qname=f"{name_prefix}:chimeric:0", flag=2048,
                    pos=SHOWCASE2[0], mapq=60,
                    cigar=[(len(rseq), "M")], seq=rseq, qual=qual,
                    extra=f"RG:Z:{rg}\tNM:i:0\tSA:Z:{sa_sup}",
                    contig=CONTIG2,
                )
                n += 2
        # Secondary alignment (same locus, FLAG=256) + a MAPQ=0 read.
        sliced = slice_read(hseq, blocks, 400, 900)
        if sliced is not None:
            pos_s, cig, rseq = sliced
            if not (skip_gap and _overlaps(pos_s, cig, COVERAGE_GAP)):
                qual = chr(33 + 20) * len(rseq)
                write_sam_record(
                    fh, qname=f"{name_prefix}:secondary:0", flag=256, pos=pos_s,
                    mapq=0, cigar=cig, seq=rseq, qual=qual,
                    extra=f"RG:Z:{rg}\tNM:i:0", contig=contig,
                )
                n += 1
    return n


def emit_short_reads(fh, sample: str, sample_idx: int, seq: str, sites: List[Site],
                     rng: random.Random, *, contig: str, origin: int, span: int,
                     showcase: Tuple[int, int], deep: Optional[Tuple[int, int]] = None,
                     skip_gap: bool = False,
                     coverage: float = SHORT_READ_COVERAGE) -> int:
    """Paired 151 bp reads, no HP tag, diploid coverage ``coverage``."""
    rg = f"{sample}.illumina"
    n = 0
    haps = [build_haplotype(seq, origin, hap_edits_for(sites, sample_idx, h, contig))
            for h in (0, 1)]
    read_len = SHORT_READ_LEN
    step = max(1, int(round(2 * read_len / coverage)))
    starts = list(range(0, max(1, span - 400), step))
    if deep:
        deep_step = max(1, step // 2)
        starts += list(range(deep[0] - origin, max(deep[0] - origin + 1, deep[1] - origin),
                             deep_step))
    seen = set()

    def hap_qpos_for_ref(blocks: List[Block], ref_pos: int) -> Optional[int]:
        for b in blocks:
            if b.op != "M":
                continue
            r0, r1 = b.ref_start, b.ref_start + len(b.ref_seq) - 1
            if r0 <= ref_pos <= r1:
                return b.qstart + (ref_pos - b.ref_start)
        return None

    def emit_pair(i, rel, hap_i, insert, qname, softclip_left=False, discordant=False,
                 duplicate=False, mapq=60):
        nonlocal n
        hseq, blocks = haps[hap_i]
        ref_start = origin + rel
        mate2_ref = ref_start + insert - read_len
        q1 = hap_qpos_for_ref(blocks, ref_start)
        q2 = hap_qpos_for_ref(blocks, mate2_ref)
        if q1 is None or q2 is None:
            return
        s1 = slice_read(hseq, blocks, q1, q1 + read_len)
        s2 = slice_read(hseq, blocks, q2, q2 + read_len)
        if s1 is None or s2 is None:
            return
        pos1, cig1, seq1 = s1
        pos2, cig2, seq2 = s2
        if skip_gap and (_overlaps(pos1, cig1, COVERAGE_GAP) or _overlaps(pos2, cig2, COVERAGE_GAP)):
            return
        seq1 = add_noise(seq1, cig1, rng, 0.004)
        seq2 = add_noise(seq2, cig2, rng, 0.004)
        if softclip_left:
            clip = "".join(rng.choice("ACGT") for _ in range(12))
            seq1 = clip + seq1
            cig1 = [(12, "S")] + cig1
        qual1 = chr(33 + 35) * len(seq1)
        qual2 = chr(33 + 35) * len(seq2)
        tlen = (pos2 + sum(n for n, op in cig2 if op in "MDN") - pos1)
        if discordant:
            tlen += 180  # looks like a pair spanning the 180bp DEL
        md1 = compute_md(seq1, pos1, cig1, seq, origin)
        md2 = compute_md(seq2, pos2, cig2, seq, origin)
        nm1 = nm_tag(seq1, pos1, cig1, seq, origin)
        nm2 = nm_tag(seq2, pos2, cig2, seq, origin)
        flag1, flag2 = (97, 145) if discordant else (99, 147)
        if duplicate:
            flag1 |= 1024
            flag2 |= 1024
        write_sam_record(
            fh, qname=qname, flag=flag1, pos=pos1, mapq=mapq if not discordant else min(mapq, 20),
            cigar=cig1, seq=seq1, qual=qual1, rnext="=", pnext=pos2, tlen=tlen,
            extra=f"RG:Z:{rg}\tNM:i:{nm1}\tMD:Z:{md1}", contig=contig,
        )
        write_sam_record(
            fh, qname=qname, flag=flag2, pos=pos2, mapq=mapq if not discordant else min(mapq, 20),
            cigar=cig2, seq=seq2, qual=qual2, rnext="=", pnext=pos1, tlen=-tlen,
            extra=f"RG:Z:{rg}\tNM:i:{nm2}\tMD:Z:{md2}", contig=contig,
        )
        n += 2

    for i, rel in enumerate(starts):
        if rel in seen:
            continue
        seen.add(rel)
        jitter = rng.randint(0, max(0, step - 1))
        emit_pair(i, rel + jitter, rng.randrange(2), rng.randint(340, 440),
                  f"{sample}:illumina:{contig}:{i}")

    # Discordant pairs around the sequence-resolved DEL (samples that carry it).
    # Place both ends on flanking M sequence so hap_qpos_for_ref succeeds:
    # left of POS, right after POS+del_len.
    if contig == CONTIG and sample_idx in (0, 1):
        for k in range(6):
            rel = (ORIGIN + 8_000 - 250) - origin + k * 15
            emit_pair(10_000 + k, rel, 1 if sample_idx == 0 else 0, 700,
                      f"{sample}:illumina:discordant:{k}", discordant=True)

    # Soft-clipped short reads at the DEL breakpoint.
    if contig == CONTIG:
        emit_pair(20_000, (ORIGIN + 8_000) - origin, 0, 380,
                  f"{sample}:illumina:softclip_del", softclip_left=True)
        emit_pair(20_001, showcase[0] - origin + 40, 0, 380,
                  f"{sample}:illumina:duplicate", duplicate=True)
        emit_pair(20_002, showcase[0] - origin + 80, 1, 360,
                  f"{sample}:illumina:mapq0", mapq=0)
    return n


def sam_to_bam(sam: Path, bam: Path) -> None:
    bam.parent.mkdir(parents=True, exist_ok=True)
    tmp = bam.with_suffix(".unsorted.bam")
    run(["samtools", "view", "-b", "-o", str(tmp), str(sam)])
    run(["samtools", "sort", "-o", str(bam), str(tmp)])
    tmp.unlink()
    run(["samtools", "index", str(bam)])


def bam_to_cram(bam: Path, cram: Path) -> None:
    """CRAM that stores bases (no_ref) so decode needs no FASTA."""
    cram.parent.mkdir(parents=True, exist_ok=True)
    run(["samtools", "view", "--output-fmt", "cram,no_ref", "-o", str(cram), str(bam)])
    run(["samtools", "index", str(cram)])


# ---------------------------------------------------------------------------
# VCFs
# ---------------------------------------------------------------------------
def gt_field(gt: Gt, phased: bool) -> str:
    def tok(a: Optional[int]) -> str:
        return "." if a is None else str(a)
    a, b = gt
    sep = "|" if phased else "/"
    return f"{tok(a)}{sep}{tok(b)}"


def info_for(site: Site) -> str:
    ac = [0] * len(site.alts)
    an = 0
    ns = 0
    all_gts = list(site.gts) + list(site.extra_gts.values())
    for a, b in all_gts:
        alleles = [x for x in (a, b) if x is not None]
        if not alleles:
            continue
        ns += 1
        an += len(alleles)
        for x in alleles:
            if x > 0:
                ac[x - 1] += 1
    af = ",".join(f"{(c / an if an else 0):.4f}" for c in ac)
    parts = [
        f"NS={ns}",
        f"AC={','.join(str(c) for c in ac)}",
        f"AN={an}",
        f"AF={af}",
    ]
    if site.kind in ("sv_seq", "sv_sym"):
        svtype = site.svtype or ("DEL" if site.del_len else "INS")
        svlen = site.svlen if site.svlen else (
            -site.del_len if site.del_len else len(site.alts[0]) - len(site.ref)
        )
        parts += [f"SVTYPE={svtype}", f"SVLEN={svlen}", f"END={site.end}"]
    if site.kind == "tr":
        motif = site.alts_spec[0] if site.alts_spec else "CAG"
        parts += [
            f"TRID={site.sid}",
            f"END={site.end}",
            f"MOTIFS={motif}",
            f"STRUC=({motif})n",
        ]
    if site.kind == "bnd":
        parts += ["SVTYPE=BND"]
    if site.kind == "star":
        parts += ["SVTYPE=DEL"]
    for k, v in site.extra_info.items():
        if v is True:
            parts.append(k)
        else:
            parts.append(f"{k}={v}")
    if site.sid == "snv_common":
        parts.append("ANN=fake|synonymous|LOW|FAKEGENE|ENSG00000000000")
    return ";".join(parts)


def write_phased_vcf(path: Path, sites: List[Site]) -> None:
    header = [
        "##fileformat=VCFv4.2",
        "##source=GenomeShader fake testdata (statistically phased)",
        f"##contig=<ID={CONTIG},length={CONTIG_LENGTH}>",
        f"##contig=<ID={CONTIG2},length={CONTIG2_LENGTH}>",
        f"##contig=<ID={CONTIG3},length={CONTIG3_LENGTH}>",
        '##FILTER=<ID=PASS,Description="All filters passed">',
        '##FILTER=<ID=LowQual,Description="Planted low-quality site">',
        '##FILTER=<ID=VQSRTranche99.90,Description="VQSR tranche 99.90">',
        '##ALT=<ID=DEL,Description="Deletion">',
        '##ALT=<ID=DUP,Description="Duplication">',
        '##ALT=<ID=INV,Description="Inversion">',
        '##ALT=<ID=INS,Description="Insertion">',
        '##ALT=<ID=CNV,Description="Copy number variant">',
        '##INFO=<ID=SOMATIC,Number=0,Type=Flag,Description="Somatic event">',
        '##INFO=<ID=NS,Number=1,Type=Integer,Description="Number of samples with data">',
        '##INFO=<ID=AC,Number=A,Type=Integer,Description="Alternate allele count">',
        '##INFO=<ID=AN,Number=1,Type=Integer,Description="Total allele count">',
        '##INFO=<ID=AF,Number=A,Type=Float,Description="Alternate allele frequency">',
        '##INFO=<ID=END,Number=1,Type=Integer,Description="End position of the variant">',
        '##INFO=<ID=SVTYPE,Number=1,Type=String,Description="Type of structural variant">',
        '##INFO=<ID=SVLEN,Number=1,Type=Integer,Description="SV length">',
        '##INFO=<ID=DP,Number=1,Type=Integer,Description="Total depth">',
        '##INFO=<ID=MQ,Number=1,Type=Float,Description="RMS mapping quality">',
        '##INFO=<ID=QD,Number=1,Type=Float,Description="Quality by depth">',
        '##INFO=<ID=FS,Number=1,Type=Float,Description="Fisher strand">',
        '##INFO=<ID=SOR,Number=1,Type=Float,Description="Strand odds ratio">',
        '##INFO=<ID=MQRankSum,Number=1,Type=Float,Description="MQ rank sum">',
        '##INFO=<ID=ReadPosRankSum,Number=1,Type=Float,Description="Read-position rank sum">',
        '##INFO=<ID=CLNSIG,Number=1,Type=String,Description="ClinVar significance">',
        '##INFO=<ID=CLNDN,Number=1,Type=String,Description="ClinVar disease name">',
        '##INFO=<ID=CSQ,Number=.,Type=String,Description="Consequence annotations">',
        '##INFO=<ID=ANN,Number=.,Type=String,Description="Fake functional annotation">',
        '##INFO=<ID=TRID,Number=1,Type=String,Description="Tandem repeat ID">',
        '##INFO=<ID=MOTIFS,Number=.,Type=String,Description="TR motifs">',
        '##INFO=<ID=STRUC,Number=1,Type=String,Description="TR structure">',
        '##FORMAT=<ID=GT,Number=1,Type=String,Description="Genotype">',
        '##FORMAT=<ID=PS,Number=1,Type=Integer,Description="Phase set">',
        '##FORMAT=<ID=GQ,Number=1,Type=Integer,Description="Genotype quality">',
        "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\t" + "\t".join(VCF_SAMPLES),
    ]
    lines = list(header)
    ordered = sorted(sites, key=lambda s: (s.chrom, s.pos))
    for s in ordered:
        alts = ",".join(s.alts)
        if s.sid == "snv_noqual":
            qual = "."
        else:
            qual = "8" if s.filt != "PASS" else "99"
        fmt = "GT:PS:GQ"
        gts = []
        for name in VCF_SAMPLES:
            if name in s.extra_gts:
                gt = s.extra_gts[name]
            elif name in SAMPLES:
                gt = s.gts[SAMPLES.index(name)]
            else:
                gt = (0, 0)
            gq = 20 if s.filt != "PASS" else 99
            a, b = gt
            if a is None and b is None:
                gts.append(f"./.:.:{gq}")
            else:
                phased = bool(s.phased)
                ps = str(s.phase_set) if phased else "."
                gts.append(f"{gt_field(gt, phased)}:{ps}:{gq}")
        lines.append("\t".join([
            s.chrom, str(s.pos), s.sid, s.ref, alts, qual, s.filt,
            info_for(s), fmt, *gts,
        ]))
    _write_vcf_gz(path, lines)


def write_trgt_vcf(path: Path, sample: str, sample_idx: int, sites: List[Site]) -> None:
    header = [
        "##fileformat=VCFv4.2",
        "##source=TRGT_fake (unphased tandem-repeat genotypes)",
        f"##contig=<ID={CONTIG},length={CONTIG_LENGTH}>",
        '##FILTER=<ID=PASS,Description="All filters passed">',
        '##INFO=<ID=TRID,Number=1,Type=String,Description="Tandem repeat ID">',
        '##INFO=<ID=END,Number=1,Type=Integer,Description="End position of the tandem repeat inclusive">',
        '##INFO=<ID=MOTIFS,Number=.,Type=String,Description="Tandem repeat motifs">',
        '##INFO=<ID=STRUC,Number=1,Type=String,Description="Repeat structure">',
        '##FORMAT=<ID=GT,Number=1,Type=String,Description="Genotype">',
        '##FORMAT=<ID=AL,Number=.,Type=Integer,Description="Allele length">',
        '##FORMAT=<ID=ALLR,Number=.,Type=String,Description="Allele length range">',
        '##FORMAT=<ID=SD,Number=.,Type=Integer,Description="Number of spanning reads">',
        '##FORMAT=<ID=MC,Number=.,Type=String,Description="Motif counts">',
        '##FORMAT=<ID=MS,Number=.,Type=String,Description="Motif spans">',
        '##FORMAT=<ID=AP,Number=.,Type=Float,Description="Allele purity">',
        '##FORMAT=<ID=AM,Number=.,Type=Float,Description="Mean methylation">',
        f"#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\t{sample}",
    ]
    lines = list(header)
    for s in sites:
        if s.kind != "tr":
            continue
        a, b = s.gts[sample_idx]
        # Lengths of the two called alleles (REF or an ALT).
        def alen(idx: Optional[int]) -> int:
            if idx is None:
                return 0
            return len(s.ref) if idx == 0 else len(s.alts[idx - 1])
        la, lb = alen(a), alen(b)
        motif = s.alts_spec[0]
        mc_a = max(1, la // max(1, len(motif)))
        mc_b = max(1, lb // max(1, len(motif)))
        sample_gt = gt_field((a, b), phased=False)
        info = f"TRID={s.sid};END={s.end};MOTIFS={motif};STRUC=({motif})n"
        fmt = (
            f"{sample_gt}:{la},{lb}:{la}-{la},{lb}-{lb}:"
            f"{12},{14}:{mc_a},{mc_b}:0-{max(0, la - 1)},0-{max(0, lb - 1)}:"
            f"0.98,0.96:.,."
        )
        lines.append("\t".join([
            CONTIG, str(s.pos), s.sid, s.ref, ",".join(s.alts), "99", "PASS",
            info, "GT:AL:ALLR:SD:MC:MS:AP:AM", fmt,
        ]))
    _write_vcf_gz(path, lines)


def _write_vcf_gz(path: Path, lines: List[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = path.with_suffix("")  # drop .gz → .vcf
    if raw.suffix != ".vcf":
        raw = path.parent / (path.name.replace(".vcf.gz", ".vcf"))
    raw.write_text("\n".join(lines) + "\n")
    gz = Path(str(raw) + ".gz")
    with gz.open("wb") as out:
        run(["bgzip", "-c", str(raw)], stdout=out)
    run(["tabix", "-f", "-p", "vcf", str(gz)])
    if gz != path:
        if path.exists():
            path.unlink()
        gz.replace(path)
        tbi = Path(str(gz) + ".tbi")
        tbi.replace(Path(str(path) + ".tbi"))
    raw.unlink()


# ---------------------------------------------------------------------------
# Manifest / README
# ---------------------------------------------------------------------------
def write_docs(out: Path, sites: List[Site], bucket: Optional[str]) -> None:
    prefix = (bucket.rstrip("/") + "/") if bucket else "<gs://BUCKET/genomeshader/testdata/>"
    features = []
    for s in sites:
        features.append({
            "id": s.sid,
            "locus": f"{s.chrom}:{s.pos}",
            "end": s.end,
            "kind": s.kind,
            "ref": s.ref[:40] + ("…" if len(s.ref) > 40 else ""),
            "alts": [a if len(a) <= 40 else a[:40] + "…" for a in s.alts],
            "phased": s.phased and s.kind != "tr",
            "filter": s.filt,
            "phase_set": s.phase_set if s.phased else None,
            "genotypes": {
                samp: gt_field(
                    gt,
                    phased=bool(s.phased) and not (gt[0] is None and gt[1] is None),
                )
                for samp, gt in list(zip(SAMPLES, s.gts)) + list(s.extra_gts.items())
            },
            "note": s.note,
        })
    sample_mapping = {
        s: [
            f"{prefix}long_reads/{s}.bam",
            f"{prefix}short_reads/{s}.cram",
        ]
        for s in SAMPLES
    }
    sample_mapping["HG001"].extend([
        f"{prefix}long_reads/HG001_fc2.bam",
        f"{prefix}long_reads/HG001.nomd.bam",
    ])
    sample_mapping[ORPHAN_SAMPLE] = [f"{prefix}long_reads/{ORPHAN_SAMPLE}.bam"]
    manifest = {
        "name": "genomeshader-fake-testdata",
        "genome_build": GENOME_BUILD,
        "contig": CONTIG,
        "region": f"{CONTIG}:{ORIGIN}-{REGION_END}",
        "default_locus": f"{CONTIG3}:{SHOWCASE3[0]}-{SHOWCASE3[1]}",
        "chr20_locus": f"{CONTIG}:{SHOWCASE[0]}-{SHOWCASE[1]}",
        "sv_locus": f"{CONTIG}:{ORIGIN + 7_800}-{ORIGIN + 18_500}",
        "trgt_locus": f"{CONTIG}:{ORIGIN + 6_700}-{ORIGIN + 11_200}",
        "samples": list(VCF_SAMPLES),
        "read_samples": list(SAMPLES),
        "vcf_only_samples": [VCF_ONLY_SAMPLE],
        "reads_only_samples": [ORPHAN_SAMPLE],
        "phase_set": PHASE_SET,
        "phase_set_2": PHASE_SET_2,
        "phase_set_14": PHASE_SET_14,
        "seed": SEED,
        "coverage_gap": f"{CONTIG}:{COVERAGE_GAP[0]}-{COVERAGE_GAP[1]}",
        "chr21_locus": f"{CONTIG2}:{SHOWCASE2[0]}-{SHOWCASE2[1]}",
        "chr14_locus": f"{CONTIG3}:{SHOWCASE3[0]}-{SHOWCASE3[1]}",
        "chr14_region": f"{CONTIG3}:{ORIGIN3}-{REGION3_END}",
        "files": {
            "phased_vcf": "variants/phased.snv_indel_sv.vcf.gz",
            "trgt_vcfs": [f"trgt/{s}.trgt.vcf.gz" for s in SAMPLES],
            "long_reads": [f"long_reads/{s}.bam" for s in SAMPLES],
            "short_reads": [f"short_reads/{s}.cram" for s in SAMPLES],
            "extra_long_reads": [
                "long_reads/HG001_fc2.bam",
                "long_reads/HG001.nomd.bam",
                f"long_reads/{ORPHAN_SAMPLE}.bam",
            ],
            "tracks": [
                "tracks/coverage.tsv",
                "tracks/peaks.bed",
                "tracks/snv_af.tsv",
            ],
            "reference_slice": f"reference/{CONTIG}_{ORIGIN}_{REGION_END}.fa",
            "reference_chr21": f"reference/{CONTIG2}_{ORIGIN2}_{REGION2_END}.fa",
            "reference_chr14": f"reference/{CONTIG3}_{ORIGIN3}_{REGION3_END}.fa",
        },
        "sample_mapping": sample_mapping,
        "features": features,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")

    rows = []
    for s in sites:
        gts_shown = list(zip(SAMPLES, s.gts))
        if s.extra_gts:
            gts_shown.extend(s.extra_gts.items())
        g = " ".join(
            f"{samp}={gt_field(gt, phased=bool(s.phased))}"
            for samp, gt in gts_shown
        )
        rows.append(
            f"| `{s.sid}` | `{s.chrom}:{s.pos}` | {s.kind} | `{g}` | {s.note} |"
        )

    readme = f"""# GenomeShader fake test dataset

Synthetic files for exercising GenomeShader display features. The sequence is a
real hg38 slice (so UCSC gene / repeat / reference tracks match the alleles),
but every read, haplotag, and genotype is planted. The gene-rich default
window is **{CONTIG3}:{ORIGIN3}-{REGION3_END}** (ARHGAP5). The planted-feature
catalog lives at **{CONTIG}:{ORIGIN}-{REGION_END}**.

## What's in the bucket

| Path | What it is |
|------|------------|
| `long_reads/HG00{{1-4}}.bam` | PacBio-like **~17 kb (12–22 kb)** reads at **~15×**, **HP:i:1 / HP:i:2** haplotags, MD tags, mixed strand, soft-clips, chimeric/secondary |
| `long_reads/HG001_fc2.bam` | Extra flowcell of HG001 (`@RG ID=pacbio2`); tests multi-file per sample |
| `long_reads/HG001.nomd.bam` | Same reads with MD stripped — pileup should still work via CIGAR |
| `long_reads/{ORPHAN_SAMPLE}.bam` | Reads-only sample (not in any VCF) |
| `short_reads/HG00{{1-4}}.cram` | Illumina-like 151 bp paired reads at **~35×**, **no HP tag**, CRAM `no_ref` |
| `variants/phased.snv_indel_sv.vcf.gz` | Joint callset: SNVs, MNPs, delins, SVs, BND, `*`, two phase sets, **{VCF_ONLY_SAMPLE}** VCF-only |
| `trgt/HG00{{1-4}}.trgt.vcf.gz` | Per-sample TRGT-style tandem-repeat VCFs, **unphased** (`0/1`, no PS) |
| `tracks/coverage.tsv` | 10 bp binned HiFi depth (`value`, `max_depth`) for `attach_data` |
| `tracks/peaks.bed` | Interval track over the showcase / SV / gap / chr14 / chr21 windows |
| `tracks/snv_af.tsv` | Per-SNV allele frequency points for a scatter overlay |
| `reference/` | The chr14 266 kb + chr20 20 kb + chr21 5 kb slices used to simulate reads |

Samples with reads: **{', '.join(SAMPLES)}**. VCF-only: **{VCF_ONLY_SAMPLE}**. Reads-only: **{ORPHAN_SAMPLE}**.
`@RG SM` matches the VCF sample names. Extra BAMs (`HG001_fc2`, `HG001.nomd`) also
have `@RG SM:HG001`, so they join the same sample without `set_sample_mapping`.

## Load (GCS)

```python
import pandas as pd
import genomeshader as gs

BUCKET = "{prefix.rstrip('/')}"
s = gs.GenomeShader(genome_build="{GENOME_BUILD}",
                    gcs_session_dir=BUCKET + "/sessions")
s.attach_variants("phased", f"{{BUCKET}}/variants/phased.snv_indel_sv.vcf.gz")
s.attach_variants("TRGT", f"{{BUCKET}}/trgt/")          # unphased; ribbons off
s.attach_reads("pacbio", f"{{BUCKET}}/long_reads/")
s.attach_reads("illumina", f"{{BUCKET}}/short_reads/")
cov = pd.read_csv(f"{{BUCKET}}/tracks/coverage.tsv", sep="\\t")
peaks = pd.read_csv(f"{{BUCKET}}/tracks/peaks.bed", sep="\\t")
s.attach_data("coverage", cov,
              chrom_col="chrom", start_col="start", value_col=["value", "max_depth"])
s.attach_data("peaks", peaks, style="interval",
              chrom_col="chrom", start_col="start", end_col="end",
              label_col="name", value_col=None)
s.attach_loci("{CONTIG3}:{SHOWCASE3[0]}-{SHOWCASE3[1]}")
s.show()
```

Attach only `long_reads/` to inspect haplotag coloring, or only `short_reads/`
for untagged pileups. Attaching both maps each VCF sample to both files.

## Loci to try

| View | Locus | What you should see |
|------|--------|---------------------|
| Genes (default) | `{CONTIG3}:{SHOWCASE3[0]}-{SHOWCASE3[1]}` | ARHGAP5 5' haplotype block (~2.8 kb); UCSC genes populated |
| ARHGAP5 + INS | `{CONTIG3}:{SHOWCASE3_GENES[0]}-{SHOWCASE3_GENES[1]}` | ARHGAP5-AS1 + 8 bp INS + 12 bp DEL just off the right edge |
| Full chr14 window | `{CONTIG3}:{ORIGIN3}-{REGION3_END}` | LOC105370440, ARHGAP5, RNU6-7/8 over 266 kb |
| Showcase (planted catalog) | `{CONTIG}:{SHOWCASE[0]}-{SHOWCASE[1]}` | SNVs, 1bp+12bp+40bp insertions, small dels, compound-het, missing GT, CAG TR |
| Haplotype block | `{CONTIG}:{ORIGIN + 5290}-{ORIGIN + 5320}` | Three consecutive phased SNVs; ribbons stay in phase |
| Second phase set | `{CONTIG}:{ORIGIN + 6_870}-{ORIGIN + 6_940}` | Six dense SNVs with `PS={PHASE_SET_2}`; ribbons should not jump to the main block |
| Unphased / half-call | `{CONTIG}:{ORIGIN + 6_320}-{ORIGIN + 7_080}` | `unphased_het` (`0/1`) + `snv_halfcall` (`0|.`) in an otherwise-phased VCF |
| Sequence-resolved SVs | `{CONTIG}:{ORIGIN + 7900}-{ORIGIN + 10000}` | 180 bp DEL + 90 bp INS; discordant Illumina pairs around the DEL |
| Coverage gap | `{CONTIG}:{COVERAGE_GAP[0]}-{COVERAGE_GAP[1]}` | No reads; `peaks.bed` still marks the interval |
| Deep pileup | `{CONTIG}:{DEEP_PILEUP[0]}-{DEEP_PILEUP[1]}` | Extra Illumina depth on top of the ~35× background |
| Symbolic / BND | `{CONTIG}:{ORIGIN + 10400}-{ORIGIN + 18500}` | `<DEL>` `<DUP>` `<INV>` `<INS>` `<CNV>` + `BND` |
| Both TRs | `{CONTIG}:{ORIGIN + 6700}-{ORIGIN + 11200}` | Phased track + unphased TRGT track at the same loci |
| Second contig | `{CONTIG2}:{SHOWCASE2[0]}-{SHOWCASE2[1]}` | Contig switch: two SNVs + a 6 bp INS on chr21 |

## Planted sites

| ID | Pos | Kind | Genotypes | Why it's here |
|----|-----|------|-----------|---------------|
{os.linesep.join(rows)}

GT convention: `0` = REF, `1`/`2` = ALT1/ALT2, `|` = phased, `/` = unphased,
`.` = missing. Long-read `HP:i:1` carries hap1 alleles, `HP:i:2` carries hap2.

## Display checklist

- [ ] Phased track draws ribbons; TRGT track does not (`variants_phased` follows `|` vs `/`)
- [ ] Load HG001 long reads: ~17 kb molecules, ~15×, two haplotype colours + a few untagged (HP=0) reads
- [ ] Load HG001 short reads: ~35×, no haplotype colour, paired-end SNPs/indels at the same sites
- [ ] Expand `ins_12bp` / `ins_40bp` / `ins_200bp` lollipops; insertion tiles match the ALT sequence
- [ ] Soft-clips visible on some HiFi reads; reverse-strand arrows mixed in
- [ ] Chimeric HiFi read (`SA` tag) with a supplementary alignment on chr21; one secondary (FLAG=256) + MAPQ=0 alignment
- [ ] Illumina duplicate pair (FLAG=1024) and MAPQ=0 pair in the showcase
- [ ] Compound-het: HG001 `compound_a` on hap1 and `compound_b` on hap2
- [ ] `snv_multi` / `ins_multi` show two ALT alleles in the flow
- [ ] `snv_lowqual` has FILTER=LowQual; `snv_vqsr` has FILTER=VQSRTranche99.90
- [ ] `snv_missing` is `./.` in HG004; `snv_halfcall` is `0|.` in HG001
- [ ] `unphased_het` is `0/1` (no ribbon) next to fully phased neighbors
- [ ] `mnp_3bp` is a 3 bp substitution; `delins` is a mixed delins (5bp→2bp)
- [ ] Two phase sets on chr20: `dense_1`–`dense_6` use PS={PHASE_SET_2}; chr14 ARHGAP5 SNVs use PS={PHASE_SET_14}
- [ ] Symbolic SVs show `<DEL>`/`<DUP>`/`<INV>`/`<INS>`/`<CNV>` labels; `bnd_breakend` is a breakend
- [ ] `{VCF_ONLY_SAMPLE}` appears in the phased VCF genotype table with no read pileup
- [ ] `{ORPHAN_SAMPLE}` has reads but no VCF column
- [ ] `HG001.nomd.bam` still pileups (CIGAR-only)
- [ ] Coverage track dips to zero in the gap; peaks BED highlights the named intervals
- [ ] Default chr14 locus shows UCSC genes (ARHGAP5-AS1 / ARHGAP5) plus planted SNVs/indels
- [ ] Switching the locus to chr21 still shows genes/repeats + the planted SNVs
- [ ] `snv_clinvar` INFO has CLNSIG / CSQ / SOMATIC; `snv_singleton` is het only in HG001
- [ ] `snv_homref` is 0|0 in every sample; `snv_noqual` has QUAL=.

## Regenerating

From the genomeshader repo (needs `samtools`, `bgzip`, `tabix`):

```bash
python scripts/generate_test_dataset.py -o scratch/testdata
# optional:
python scripts/generate_test_dataset.py -o scratch/testdata \\
    --upload gs://YOUR-BUCKET/genomeshader/testdata/
```

The generator is deterministic (`seed={SEED}`).
"""
    (out / "README.md").write_text(readme)


def upload(out: Path, dest: str) -> None:
    dest = dest.rstrip("/")
    print(f"uploading {out} → {dest}/ …")
    run(["gsutil", "-m", "rsync", "-r", "-x", r"(^|/)\.", str(out), dest])
    print(f"uploaded to {dest}/")


# ---------------------------------------------------------------------------
# Tracks
# ---------------------------------------------------------------------------
def write_tracks(out: Path, sites: List[Site]) -> None:
    """Coverage (from HG001 HiFi) + fake interval peaks + SNV AF scatter."""
    tracks = out / "tracks"
    tracks.mkdir(exist_ok=True)
    bam = out / "long_reads" / "HG001.bam"
    cov = tracks / "coverage.tsv"
    with cov.open("w") as fh:
        fh.write("chrom\tstart\tvalue\tmax_depth\n")
        for chrom, origin, end in (
            (CONTIG, ORIGIN, REGION_END),
            (CONTIG2, ORIGIN2, REGION2_END),
            (CONTIG3, ORIGIN3, REGION3_END),
        ):
            proc = subprocess.run(
                ["samtools", "depth", "-aa", "-r", f"{chrom}:{origin}-{end}", str(bam)],
                check=True, capture_output=True, text=True,
            )
            bucket: List[int] = []
            last_pos = origin
            last_chrom = chrom
            for line in proc.stdout.splitlines():
                c, pos, d = line.split("\t")
                bucket.append(int(d))
                last_pos = int(pos)
                last_chrom = c
                if len(bucket) == 10:
                    fh.write(
                        f"{c}\t{int(pos) - 9}\t{sum(bucket) / 10:.2f}\t{max(bucket)}\n"
                    )
                    bucket = []
            if bucket:
                fh.write(
                    f"{last_chrom}\t{last_pos - len(bucket) + 1}\t"
                    f"{sum(bucket) / len(bucket):.2f}\t{max(bucket)}\n"
                )
    peaks = tracks / "peaks.bed"
    with peaks.open("w") as fh:
        fh.write("chrom\tstart\tend\tname\n")
        for chrom, name, start, end in (
            (CONTIG, "amplicon_A", SHOWCASE[0], SHOWCASE[1]),
            (CONTIG, "del_flank", ORIGIN + 7_900, ORIGIN + 8_200),
            (CONTIG2, "chr21_peak", SHOWCASE2[0], SHOWCASE2[1]),
            (CONTIG, "coverage_gap", COVERAGE_GAP[0], COVERAGE_GAP[1]),
            (CONTIG3, "ARHGAP5_5p", SHOWCASE3_GENES[0], SHOWCASE3_GENES[1]),
            (CONTIG3, "ARHGAP5_body", 32_077_304, 32_159_728),
        ):
            fh.write(f"{chrom}\t{start}\t{end}\t{name}\n")
    af_path = tracks / "snv_af.tsv"
    with af_path.open("w") as fh:
        fh.write("chrom\tstart\tvalue\tlabel\n")
        for s in sites:
            if s.kind != "snv":
                continue
            n_alt = 0
            n_called = 0
            for gt in list(s.gts) + list(s.extra_gts.values()):
                for a in gt:
                    if a is None:
                        continue
                    n_called += 1
                    if a:
                        n_alt += 1
            af = (n_alt / n_called) if n_called else 0.0
            fh.write(f"{s.chrom}\t{s.pos}\t{af:.4f}\t{s.sid}\n")
    (tracks / "README.md").write_text(
        "TSV/BED for GenomeShader.attach_data() (load with pandas, then attach_data).\n"
        "coverage.tsv: line/bar overlay of mean + max HiFi depth (10 bp bins).\n"
        "peaks.bed: interval track. snv_af.tsv: scatter of planted SNV allele frequencies.\n"
    )


def validate(out: Path) -> None:
    import pysam

    bam = pysam.AlignmentFile(out / "long_reads" / "HG001.bam", "rb")
    hps = []
    n = 0
    n_md = 0
    n_rev = 0
    n_soft = 0
    for r in bam.fetch(CONTIG, ORIGIN - 1, REGION_END):
        n += 1
        hps.append(r.get_tag("HP") if r.has_tag("HP") else 0)
        n_md += int(r.has_tag("MD"))
        n_rev += int(bool(r.is_reverse))
        n_soft += int(any(op == 4 for op, _ in r.cigartuples or []))
    bam.close()
    hp_set = sorted(set(hps))
    print(f"  long HG001: {n} reads, HP tags {hp_set}, MD={n_md}/{n}, "
          f"reverse={n_rev}, softclip_reads={n_soft}")
    if 1 not in hp_set or 2 not in hp_set:
        sys.exit(f"expected HP 1 and 2 in long BAM, got {hp_set}")
    if 0 not in hp_set:
        sys.exit("expected some untagged (HP=0) long reads")

    lens = []
    interior = []
    bam = pysam.AlignmentFile(out / "long_reads" / "HG001.bam", "rb")
    for r in bam.fetch(CONTIG, SHOWCASE[0] - 1, SHOWCASE[1]):
        if r.is_secondary or r.is_supplementary:
            continue
        lens.append(r.query_length)
        if (r.reference_start + 1) > ORIGIN + 200:
            interior.append(r.query_length)
    bam.close()
    mean_len = (sum(lens) / len(lens)) if lens else 0
    mean_int = (sum(interior) / len(interior)) if interior else 0
    print(f"  long HG001 showcase: {len(lens)} reads, mean length {mean_len:.0f} bp "
          f"(interior-start mean {mean_int:.0f} bp)")
    if mean_int < 12_000 or mean_int > 22_000:
        sys.exit(f"expected ~17 kb long reads, interior-start mean {mean_int:.0f}")

    long_cov = mean_depth(out / "long_reads" / "HG001.bam",
                           f"{CONTIG}:{SHOWCASE[0]}-{SHOWCASE[1]}")
    print(f"  long HG001 showcase coverage: {long_cov:.1f}x")
    if not (11 <= long_cov <= 22):
        sys.exit(f"expected ~{LONG_READ_COVERAGE}x long-read coverage, got {long_cov:.1f}x")

    # HG001 is 0|1 at snv_common (chr20:32005120): HP=1 matches REF, HP=2 carries ALT.
    # The site must show up as an MD mismatch, not a 1D1I delins.
    snv_pos = ORIGIN + 5_120  # snv_common
    bam = pysam.AlignmentFile(out / "long_reads" / "HG001.bam", "rb")
    saw_hp1 = saw_hp2_mm = False
    for r in bam.fetch(CONTIG, snv_pos - 1, snv_pos):
        hp = r.get_tag("HP") if r.has_tag("HP") else 0
        cig = r.cigarstring or ""
        if "1D1I" in cig or "1I1D" in cig:
            sys.exit(f"SNVs encoded as delins in {r.query_name}: {cig}")
        ref_pos = r.reference_start + 1  # 1-based
        qpos = 0
        for op, n in r.cigartuples or []:
            if op == 0:  # M
                if ref_pos <= snv_pos < ref_pos + n:
                    qoff = snv_pos - ref_pos
                    qbase = r.query_sequence[qpos + qoff].upper()
                    if hp == 1:
                        saw_hp1 = True
                    if hp == 2:
                        saw_hp2_mm = True
                        if qbase == "G":
                            sys.exit(f"HP2 read {r.query_name} still has REF at snv_common")
                ref_pos += n
                qpos += n
            elif op == 1:  # I
                qpos += n
            elif op in (2, 3):  # D/N
                ref_pos += n
            elif op == 4:  # S
                qpos += n
    bam.close()
    if not saw_hp1 or not saw_hp2_mm:
        sys.exit(f"snv_common not covered by both haplotypes (hp1={saw_hp1}, hp2={saw_hp2_mm})")

    cram = pysam.AlignmentFile(out / "short_reads" / "HG001.cram", "rc")
    n = 0
    tagged = 0
    paired = 0
    for r in cram.fetch(CONTIG, SHOWCASE[0] - 1, SHOWCASE[1]):
        n += 1
        tagged += int(r.has_tag("HP"))
        paired += int(r.is_paired)
    cram.close()
    print(f"  short HG001: {n} reads in showcase, HP-tagged={tagged}, paired={paired}")
    if tagged:
        sys.exit("short CRAM should have no HP tags")
    if n < 20:
        sys.exit(f"too few short reads in showcase ({n})")
    short_cov = mean_depth(out / "short_reads" / "HG001.cram",
                            f"{CONTIG}:{SHOWCASE[0]}-{SHOWCASE[1]}")
    print(f"  short HG001 showcase coverage: {short_cov:.1f}x")
    if not (25 <= short_cov <= 55):
        sys.exit(f"expected ~{SHORT_READ_COVERAGE}x short-read coverage, got {short_cov:.1f}x")

    vcf = pysam.VariantFile(out / "variants" / "phased.snv_indel_sv.vcf.gz")
    n_phased = n_unphased = 0
    kinds = set()
    for rec in vcf.fetch(CONTIG, ORIGIN - 1, REGION_END):
        kinds.add(rec.id)
        for samp in SAMPLES:
            gt = rec.samples[samp]
            if gt.phased:
                n_phased += 1
            else:
                n_unphased += 1
    vcf.close()
    print(f"  joint VCF: {len(kinds)} sites, phased sample-GTs={n_phased}, "
          f"unphased/missing={n_unphased}")
    if n_phased < 10:
        sys.exit("joint VCF expected statistically phased GTs")

    tr = pysam.VariantFile(out / "trgt" / "HG001.trgt.vcf.gz")
    recs = list(tr.fetch())
    tr.close()
    print(f"  TRGT HG001: {len(recs)} records")
    for rec in recs:
        gt = rec.samples["HG001"]
        if gt.phased:
            sys.exit(f"TRGT {rec.id} should be unphased, got phased {gt['GT']}")

    vcf = pysam.VariantFile(out / "variants" / "phased.snv_indel_sv.vcf.gz")
    samples = list(vcf.header.samples)
    if list(VCF_SAMPLES) != samples:
        sys.exit(f"VCF samples {samples} != {list(VCF_SAMPLES)}")
    by_id = {rec.id: rec for rec in vcf.fetch()}
    required = {
        "mnp_3bp", "delins", "ins_multi", "unphased_het", "snv_halfcall",
        "ins_200bp", "snv_vqsr", "snv_clinvar", "star_overlap", "bnd_breakend",
        "cnv_cn",         "chr21_snv_a", "chr21_ins", "dense_1", "dense_6",
        "snv_homref", "snv_noqual",
        "chr14_loc_snv", "chr14_arhgap5_snv", "chr14_block_1", "chr14_block_12",
        "chr14_arhgap5_ins",
        "chr14_arhgap5_del", "chr14_rnu6",
    }
    missing = required - set(by_id)
    if missing:
        sys.exit(f"missing VCF records: {sorted(missing)}")
    if not by_id["unphased_het"].samples["HG001"].phased:
        pass
    else:
        sys.exit("unphased_het should not be statistically phased")
    half = by_id["snv_halfcall"].samples["HG001"]
    if half["GT"] != (0, None):
        sys.exit(f"snv_halfcall HG001 GT={half['GT']}, expected (0, None)")
    if not half.phased:
        sys.exit("snv_halfcall should keep the phase bit (0|.)")
    if by_id["snv_clinvar"].samples[VCF_ONLY_SAMPLE]["GT"] != (0, 1):
        sys.exit("HG005 should be 0|1 at snv_clinvar")
    if "SOMATIC" not in by_id["snv_clinvar"].info:
        sys.exit("snv_clinvar missing SOMATIC flag")
    if by_id["snv_noqual"].qual is not None:
        sys.exit(f"snv_noqual QUAL={by_id['snv_noqual'].qual}, expected missing")
    if by_id["mnp_3bp"].alts is None or len(by_id["mnp_3bp"].ref) != 3:
        sys.exit("mnp_3bp should be a 3bp REF")
    if "*" not in (by_id["star_overlap"].alts or ()):
        sys.exit("star_overlap should have ALT=*")
    ps_values = set()
    for rec in by_id.values():
        ps = rec.samples["HG001"].get("PS")
        if ps not in (None, "."):
            ps_values.add(ps)
    if PHASE_SET not in ps_values or PHASE_SET_2 not in ps_values or PHASE_SET_14 not in ps_values:
        sys.exit(f"expected both phase sets plus chr14 PS, got {ps_values}")
    if by_id["chr14_arhgap5_snv"].samples[VCF_ONLY_SAMPLE]["GT"] != (0, 1):
        sys.exit("HG005 should be 0|1 at chr14_arhgap5_snv")
    vcf.close()
    print(f"  VCF extras: {len(by_id)} records, PS={sorted(ps_values)}, "
          f"HG005 present, chr21+MNP/delins/BND/star ok")

    bam = pysam.AlignmentFile(out / "long_reads" / "HG001.bam", "rb")
    n14 = sum(1 for _ in bam.fetch(CONTIG3, ORIGIN3 - 1, REGION3_END))
    n21 = sum(1 for _ in bam.fetch(CONTIG2, ORIGIN2 - 1, REGION2_END))
    n_gap = sum(1 for _ in bam.fetch(CONTIG, COVERAGE_GAP[0] - 1, COVERAGE_GAP[1]))
    n_sa = n_sec = n_mapq0 = 0
    rgs = set()
    for r in bam.fetch(CONTIG, ORIGIN - 1, REGION_END):
        if r.has_tag("SA"):
            n_sa += 1
        if r.is_secondary:
            n_sec += 1
        if r.mapping_quality == 0:
            n_mapq0 += 1
        if r.has_tag("RG"):
            rgs.add(r.get_tag("RG"))
    bam.close()
    print(f"  long extras: chr14={n14}, chr21={n21}, gap_overlap={n_gap}, SA={n_sa}, "
          f"secondary={n_sec}, MAPQ0={n_mapq0}, RG={sorted(rgs)}")
    if n14 < 20:
        sys.exit(f"expected chr14 long reads, got {n14}")
    if n21 < 2:
        sys.exit(f"expected chr21 long reads, got {n21}")
    if n_gap:
        sys.exit(f"coverage gap should be empty, got {n_gap} overlapping reads")
    if not n_sa:
        sys.exit("expected a chimeric read with SA")
    if not n_sec:
        sys.exit("expected a secondary alignment")
    if "HG001.pacbio2" not in rgs:
        sys.exit(f"expected RG HG001.pacbio2, got {rgs}")

    cram = pysam.AlignmentFile(out / "short_reads" / "HG001.cram", "rc")
    n_dup = n_mq0 = n_disc = 0
    for r in cram.fetch(CONTIG, ORIGIN - 1, REGION_END):
        n_dup += int(r.is_duplicate)
        n_mq0 += int(r.mapping_quality == 0)
        n_disc += int(not r.is_proper_pair and r.is_paired)
    cram.close()
    print(f"  short extras: duplicate={n_dup}, MAPQ0={n_mq0}, discordant={n_disc}")
    if not n_dup:
        sys.exit("expected a duplicate Illumina pair")
    if not n_mq0:
        sys.exit("expected MAPQ=0 Illumina reads")
    if not n_disc:
        sys.exit("expected discordant Illumina pairs around the 180bp DEL")

    nomd = pysam.AlignmentFile(out / "long_reads" / "HG001.nomd.bam", "rb")
    n = n_md = 0
    for r in nomd.fetch(CONTIG, SHOWCASE[0] - 1, SHOWCASE[1]):
        n += 1
        n_md += int(r.has_tag("MD"))
    nomd.close()
    if n == 0:
        sys.exit("HG001.nomd.bam is empty in the showcase")
    if n_md:
        sys.exit(f"HG001.nomd.bam still has {n_md} MD tags")

    orphan = out / "long_reads" / f"{ORPHAN_SAMPLE}.bam"
    if not orphan.is_file():
        sys.exit(f"missing {orphan}")
    if not (out / "long_reads" / "HG001_fc2.bam").is_file():
        sys.exit("missing HG001_fc2.bam")
    for rel in ("tracks/coverage.tsv", "tracks/peaks.bed", "tracks/snv_af.tsv"):
        if not (out / rel).is_file():
            sys.exit(f"missing {rel}")
    print("  validation ok")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def generate(out: Path, bucket: Optional[str], do_upload: bool) -> None:
    require_tools()
    rng = random.Random(SEED)
    out.mkdir(parents=True, exist_ok=True)

    seq20 = fetch_hg38_slice(out / "reference" / ".chr20_slice.txt", CONTIG, ORIGIN, SPAN)
    seq21 = fetch_hg38_slice(out / "reference" / ".chr21_slice.txt", CONTIG2, ORIGIN2, SPAN2)
    seq14 = fetch_hg38_slice(out / "reference" / ".chr14_slice.txt", CONTIG3, ORIGIN3, SPAN3)
    write_fasta(out / "reference" / f"{CONTIG}_{ORIGIN}_{REGION_END}.fa", CONTIG, ORIGIN, seq20)
    write_fasta(out / "reference" / f"{CONTIG2}_{ORIGIN2}_{REGION2_END}.fa", CONTIG2, ORIGIN2, seq21)
    write_fasta(out / "reference" / f"{CONTIG3}_{ORIGIN3}_{REGION3_END}.fa", CONTIG3, ORIGIN3, seq14)

    sites = catalog(rng)
    fill_alleles(sites, {
        CONTIG: (ORIGIN, seq20),
        CONTIG2: (ORIGIN2, seq21),
        CONTIG3: (ORIGIN3, seq14),
    }, rng)

    write_phased_vcf(out / "variants" / "phased.snv_indel_sv.vcf.gz", sites)
    for i, sample in enumerate(SAMPLES):
        write_trgt_vcf(out / "trgt" / f"{sample}.trgt.vcf.gz", sample, i, sites)

    tmp = out / ".tmp_sam"
    tmp.mkdir(exist_ok=True)
    for i, sample in enumerate(SAMPLES):
        print(f"  simulating {sample} long reads…")
        sam = tmp / f"{sample}.hifi.sam"
        with sam.open("w") as fh:
            fh.write(sam_header(sample, "pacbio", [f"{sample}.pacbio", f"{sample}.pacbio2"]))
            n = emit_long_reads(
                fh, sample, i, seq20, sites, rng,
                contig=CONTIG, origin=ORIGIN, rg=f"{sample}.pacbio",
                name_prefix=f"{sample}:hifi", skip_gap=True, extra_stutter=True,
            )
            n += emit_long_reads(
                fh, sample, i, seq21, sites, rng,
                contig=CONTIG2, origin=ORIGIN2, rg=f"{sample}.pacbio",
                name_prefix=f"{sample}:hifi:{CONTIG2}",
            )
            n += emit_long_reads(
                fh, sample, i, seq14, sites, rng,
                contig=CONTIG3, origin=ORIGIN3, rg=f"{sample}.pacbio",
                name_prefix=f"{sample}:hifi:{CONTIG3}",
            )
            if sample == "HG001":
                n += emit_long_reads(
                    fh, sample, i, seq20, sites, rng,
                    contig=CONTIG, origin=ORIGIN, rg=f"{sample}.pacbio2",
                    name_prefix=f"{sample}:hifi:fc2", skip_gap=True,
                    untagged=0, max_reads=4,
                )
        print(f"    {n} long records")
        sam_to_bam(sam, out / "long_reads" / f"{sample}.bam")

        print(f"  simulating {sample} short reads…")
        sam = tmp / f"{sample}.illumina.sam"
        with sam.open("w") as fh:
            fh.write(sam_header(sample, "illumina", [f"{sample}.illumina"]))
            n = emit_short_reads(
                fh, sample, i, seq20, sites, rng,
                contig=CONTIG, origin=ORIGIN, span=SPAN,
                showcase=SHOWCASE, deep=DEEP_PILEUP, skip_gap=True,
            )
            n += emit_short_reads(
                fh, sample, i, seq21, sites, rng,
                contig=CONTIG2, origin=ORIGIN2, span=SPAN2,
                showcase=SHOWCASE2,
            )
            n += emit_short_reads(
                fh, sample, i, seq14, sites, rng,
                contig=CONTIG3, origin=ORIGIN3, span=SPAN3,
                showcase=SHOWCASE3,
            )
        print(f"    {n} short records")
        bam = tmp / f"{sample}.illumina.bam"
        sam_to_bam(sam, bam)
        bam_to_cram(bam, out / "short_reads" / f"{sample}.cram")

    # Second flowcell for HG001 (same SM, different filename).
    print("  simulating HG001 flowcell 2…")
    sam = tmp / "HG001_fc2.sam"
    with sam.open("w") as fh:
        fh.write(sam_header("HG001", "pacbio", ["HG001.pacbio2"]))
        emit_long_reads(
            fh, "HG001", 0, seq20, sites, rng,
            contig=CONTIG, origin=ORIGIN, rg="HG001.pacbio2",
            name_prefix="HG001:hifi:fc2file", skip_gap=True,
            coverage=8, untagged=1,
        )
    sam_to_bam(sam, out / "long_reads" / "HG001_fc2.bam")

    # MD-stripped copy of HG001 — "SNPs unavailable" warning when loaded alone.
    nomd = out / "long_reads" / "HG001.nomd.bam"
    run(["samtools", "view", "-x", "MD", "-b", "-o", str(nomd),
         str(out / "long_reads" / "HG001.bam")])
    run(["samtools", "index", str(nomd)])

    # Reads-only sample, not in any VCF.
    print("  simulating reads-only orphan…")
    sam = tmp / "orphan.sam"
    with sam.open("w") as fh:
        fh.write(sam_header(ORPHAN_SAMPLE, "pacbio", [f"{ORPHAN_SAMPLE}.pacbio"]))
        emit_long_reads(
            fh, ORPHAN_SAMPLE, -1, seq20, sites, rng,
            contig=CONTIG, origin=ORIGIN, rg=f"{ORPHAN_SAMPLE}.pacbio",
            name_prefix=f"{ORPHAN_SAMPLE}:hifi", skip_gap=True,
        )
    sam_to_bam(sam, out / "long_reads" / f"{ORPHAN_SAMPLE}.bam")

    write_tracks(out, sites)
    shutil.rmtree(tmp, ignore_errors=True)
    write_docs(out, sites, bucket)

    print("validating…")
    try:
        validate(out)
    except ImportError:
        print("  pysam not installed; skipped deep validation (files were indexed)")

    print()
    print(f"dataset: {out.resolve()}")
    print(f"default locus: {CONTIG3}:{SHOWCASE3[0]}-{SHOWCASE3[1]}")
    print(f"chr20 locus:    {CONTIG}:{SHOWCASE[0]}-{SHOWCASE[1]}")
    print(f"chr21 locus:    {CONTIG2}:{SHOWCASE2[0]}-{SHOWCASE2[1]}")
    if do_upload and bucket:
        upload(out, bucket)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("-o", "--output", type=Path, default=Path("scratch/testdata"),
                   help="output directory (default: scratch/testdata)")
    p.add_argument("--upload", metavar="GS_URI", default=None,
                   help="gs:// URI to rsync the dataset to after generation")
    p.add_argument("--bucket", default=None,
                   help="gs:// prefix to bake into README sample_mapping "
                        "(defaults to --upload if set)")
    args = p.parse_args()
    bucket = args.bucket or args.upload
    generate(args.output, bucket=bucket, do_upload=bool(args.upload))


if __name__ == "__main__":
    main()
