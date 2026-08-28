# plasmodb.py: stage PlasmoDB / VEuPathDB genome annotations into the
# genomeshader cache so the viewer can render non-UCSC genomes (e.g.
# Plasmodium falciparum 3D7, PlasmoDB-61) offline.
#
# genomeshader normally pulls ideogram/genes/reference tracks from the UCSC
# REST API, keyed on `genome_build`, and caches each result as JSON under
# `{gcs_session_dir}/cache/ucsc/...`. PlasmoDB genomes are not in UCSC. This
# module pre-computes the exact same cache blobs straight from the PlasmoDB
# genome FASTA + GFF3, and registers them in the cache interval index. With
# GENOMESHADER_ALLOW_UCSC_API unset, GenomeShader.ideogram/genes/reference then
# serve these blobs and never touch the network.
#
# Files (PlasmoDB-61 P. falciparum 3D7) come from:
#   https://plasmodb.org/common/downloads/release-61/Pfalciparum3D7/
#     fasta/data/PlasmoDB-61_Pfalciparum3D7_Genome.fasta
#     gff/data/PlasmoDB-61_Pfalciparum3D7.gff
#
# Usage:
#   from genomeshader.view import GenomeShader
#   from genomeshader.plasmodb import stage_plasmodb
#   session = GenomeShader(genome_build="PlasmoDB-61_Pfalciparum3D7",
#                          gcs_session_dir="gs://my-bucket/genomeshader")
#   stage_plasmodb(session,
#                  fasta_path="PlasmoDB-61_Pfalciparum3D7_Genome.fasta",
#                  gff_path="PlasmoDB-61_Pfalciparum3D7.gff")
#   # then, as usual:  session.render("Pf3D7_01_v3:100000-101000"); session.show()
#
# Contig naming: PlasmoDB uses names like "Pf3D7_01_v3". Your BAMs/VCFs must use
# the same names, or pass `contig_rename` to map PlasmoDB names -> your names.

import gzip
import os
import subprocess
import tempfile
import urllib.parse
from typing import Callable, Dict, List, Optional, Union

# A neutral chromosome-body shade; PlasmoDB chromosomes have no Giemsa banding,
# so the ideogram is a single flat band per contig.
_IDEO_BAND_COLOR = "#e8e8e8"


def _open_text(path: str):
    """Open a plain or gzipped text file."""
    if path.endswith(".gz"):
        return gzip.open(path, "rt")
    return open(path, "r")


def _s3_cp(src: str, dst: str) -> bool:
    """Copy s3://... -> local via the aws CLI, mirroring view._gcs_cp."""
    try:
        rc = subprocess.run(
            ["aws", "s3", "cp", src, dst],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        ).returncode
        return rc == 0
    except FileNotFoundError:
        raise RuntimeError(
            "aws CLI not found; install awscli to fetch s3:// references"
        )


def _fetch_to_local(session, uri: Optional[str], tmpdir: str) -> Optional[str]:
    """Resolve a reference field to a local path, downloading if remote.

    Scheme-aware: local/file:// pass through; gs:// reuses session._gcs_cp;
    s3:// shells out to aws; http(s):// streams via requests. Returns None for
    None (optional fields). Raises on unknown scheme or failed transfer.
    """
    if uri is None:
        return None
    if "://" not in uri:
        return uri
    if uri.startswith("file://"):
        return uri[len("file://"):]

    scheme = uri.split("://", 1)[0]
    dst = os.path.join(tmpdir, os.path.basename(uri.split("?", 1)[0]))

    if scheme == "gs":
        if not session._gcs_cp(uri, dst):
            raise RuntimeError(f"failed to fetch {uri} (gcloud/gsutil)")
    elif scheme == "s3":
        if not _s3_cp(uri, dst):
            raise RuntimeError(f"failed to fetch {uri} (aws s3 cp)")
    elif scheme in ("http", "https"):
        import requests
        with requests.get(uri, stream=True) as r:
            if r.status_code != 200:
                raise RuntimeError(f"failed to fetch {uri} (HTTP {r.status_code})")
            with open(dst, "wb") as fh:
                for chunk in r.iter_content(chunk_size=1 << 16):
                    fh.write(chunk)
    else:
        raise ValueError(f"unsupported scheme in reference path: {uri}")
    return dst


def _make_renamer(contig_rename: Optional[Union[Dict[str, str], Callable[[str], str]]]):
    if contig_rename is None:
        return lambda c: c
    if callable(contig_rename):
        return contig_rename
    return lambda c: contig_rename.get(c, c)


def read_fasta(fasta_path: str, rename=lambda c: c) -> Dict[str, str]:
    """Read a (possibly gzipped) FASTA into {contig: uppercased sequence}."""
    seqs: Dict[str, List[str]] = {}
    cur = None
    with _open_text(fasta_path) as fh:
        for line in fh:
            if line.startswith(">"):
                # Header up to first whitespace is the seqid.
                cur = rename(line[1:].split()[0])
                seqs[cur] = []
            elif cur is not None:
                seqs[cur].append(line.strip())
    return {c: "".join(parts).upper() for c, parts in seqs.items()}


def _parse_attrs(field: str) -> Dict[str, str]:
    out = {}
    for kv in field.strip().split(";"):
        if "=" in kv:
            k, v = kv.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def parse_gff_genes(gff_path: str, rename=lambda c: c) -> Dict[str, List[dict]]:
    """Parse a GFF3 into per-contig gene models matching GenomeShader.genes().

    Each gene model: {name, strand, start, end, exons:[[s,e,universal], ...], lane}
    with 1-based inclusive coordinates. Exons of all transcripts of a gene are
    merged into a single union; `universal` is True for every merged exon.

    ponytail: single merged model per gene, no per-transcript "partial" exon
    shading. Track transcript membership here if alt-splicing display matters.
    """
    # First pass: record every feature's parent chain so an exon can be
    # resolved up to its top-level gene, regardless of the intermediate
    # (mRNA / rRNA / pseudogenic_transcript / ...) feature types PlasmoDB uses.
    parent_of: Dict[str, str] = {}
    feat: Dict[str, dict] = {}          # id -> {contig, strand, name, start, end}
    exons_by_parent: Dict[str, List[List[int]]] = {}
    cds_by_parent: Dict[str, List[List[int]]] = {}
    gene_ids: List[str] = []            # top-level *_gene features, for span fallback

    with _open_text(gff_path) as fh:
        for line in fh:
            # PlasmoDB ships a combined GFF with the genome FASTA appended after
            # a `##FASTA` directive — stop before we start parsing sequence.
            if line.startswith("##FASTA"):
                break
            if not line.strip() or line.startswith("#"):
                continue
            cols = line.rstrip("\n").split("\t")
            if len(cols) < 9:
                continue
            seqid, _src, ftype, start, end, _score, strand, _phase, attrs = cols[:9]
            a = _parse_attrs(attrs)
            fid = a.get("ID")
            parent = a.get("Parent", "").split(",")[0]  # take first parent
            if fid:
                feat[fid] = {
                    "contig": rename(seqid),
                    "strand": strand if strand in ("+", "-") else "+",
                    "name": a.get("Name") or a.get("gene") or fid,
                    "start": int(start),
                    "end": int(end),
                    # GFF description (PlasmoDB uses URL-encoded `description=`);
                    # shown verbatim in the Genes panel. Empty if absent.
                    "description": urllib.parse.unquote_plus(
                        a.get("description") or a.get("Note") or a.get("product") or ""
                    ),
                }
                if parent:
                    parent_of[fid] = parent
                if ftype.endswith("gene"):   # gene, protein_coding_gene, ncRNA_gene, pseudogene...
                    gene_ids.append(fid)
            if not parent:
                continue
            if ftype == "exon":
                exons_by_parent.setdefault(parent, []).append([int(start), int(end)])
            elif ftype == "CDS":
                cds_by_parent.setdefault(parent, []).append([int(start), int(end)])

    def root(fid: str) -> str:
        seen = set()
        while fid in parent_of and fid not in seen:
            seen.add(fid)
            fid = parent_of[fid]
        return fid

    # Group exons (preferred) then CDS by root gene.
    exons_by_gene: Dict[str, List[List[int]]] = {}
    for parent_id, exons in exons_by_parent.items():
        exons_by_gene.setdefault(root(parent_id), []).extend(exons)
    for parent_id, cds in cds_by_parent.items():
        gene_id = root(parent_id)
        if gene_id not in exons_by_gene:     # only when no explicit exons exist
            exons_by_gene.setdefault(gene_id, []).extend(cds)
    # Genes with neither exon nor CDS children (e.g. some ncRNA): use gene span,
    # mirroring genes()'s single-exon fallback.
    for gid in gene_ids:
        if gid not in exons_by_gene:
            exons_by_gene[gid] = [[feat[gid]["start"], feat[gid]["end"]]]

    # Per-transcript detail (id + its exons) for the Genes panel enumeration.
    # The immediate exon/CDS parent IS the transcript; root() maps it to the
    # gene. CDS-only transcripts (no explicit exon feature) fall back to CDS.
    transcripts_by_gene: Dict[str, List[dict]] = {}

    def _add_transcript(parent_id: str, intervals: List[List[int]]) -> None:
        ex = sorted(([int(s), int(e)] for s, e in intervals), key=lambda p: p[0])
        if not ex:
            return
        transcripts_by_gene.setdefault(root(parent_id), []).append({
            "id": parent_id,
            "start": ex[0][0],
            "end": max(e for _, e in ex),
            "exons": ex,
        })

    for parent_id, exons in exons_by_parent.items():
        _add_transcript(parent_id, exons)
    for parent_id, cds in cds_by_parent.items():
        if parent_id not in exons_by_parent:   # CDS-only transcript
            _add_transcript(parent_id, cds)
    for gene_id, txs in transcripts_by_gene.items():
        txs.sort(key=lambda t: (t["start"], t["id"]))

    # Build gene models, grouped by contig.
    by_contig: Dict[str, List[dict]] = {}
    for gene_id, exons in exons_by_gene.items():
        info = feat.get(gene_id) or feat.get(root(gene_id)) or {}
        contig = info.get("contig")
        if contig is None:
            continue
        merged = _merge_intervals(exons)
        model = {
            "name": info.get("name", gene_id),
            "id": gene_id,
            "strand": info.get("strand", "+"),
            "start": merged[0][0],
            "end": merged[-1][1],
            "exons": [[s, e, True] for s, e in merged],
            "description": info.get("description", ""),
            "transcripts": transcripts_by_gene.get(gene_id, []),
        }
        by_contig.setdefault(contig, []).append(model)

    for contig, models in by_contig.items():
        _assign_lanes(models)
    return by_contig


def _merge_intervals(intervals: List[List[int]]) -> List[List[int]]:
    """Merge overlapping/adjacent [start, end] (1-based inclusive) intervals."""
    if not intervals:
        return []
    ivs = sorted(intervals, key=lambda x: x[0])
    out = [list(ivs[0])]
    for s, e in ivs[1:]:
        if s <= out[-1][1] + 1:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e])
    return out


def _assign_lanes(models: List[dict], n_lanes: int = 3) -> None:
    """Greedy 3-lane packing to avoid overlaps; mirrors GenomeShader.genes()."""
    models.sort(key=lambda g: g["start"])
    lanes: List[List[dict]] = [[] for _ in range(n_lanes)]
    for g in models:
        placed = False
        for i in range(n_lanes):
            if all(g["end"] < x["start"] or g["start"] > x["end"] for x in lanes[i]):
                g["lane"] = i
                lanes[i].append(g)
                placed = True
                break
        if not placed:
            g["lane"] = 0
            lanes[0].append(g)


def stage_reference(
    session,
    fasta: str,
    gff: Optional[str] = None,
    contig_rename: Optional[Union[Dict[str, str], Callable[[str], str]]] = None,
    verbose: bool = True,
) -> Dict[str, int]:
    """Stage any reference's FASTA (+ optional GFF3) into `session`'s cache.

    `fasta` is required; `gff` is optional (contigs without genes still get
    reference + ideogram + chrom_sizes). Each field may be a local path or a
    gs://, s3://, http(s):// URI — remote files are downloaded first. Writes
    reference / genes / ideogram blobs + a chrom_sizes file and registers them
    in the cache interval index, so `session.reference/genes/ideogram` serve
    them without UCSC. Returns {contig: length}.
    """
    rename = _make_renamer(contig_rename)
    build = session.genome_build
    base = session.gcs_session_dir.rstrip("/")

    tmpdir = tempfile.mkdtemp(prefix="genomeshader-ref-")
    fasta_path = _fetch_to_local(session, fasta, tmpdir)
    gff_path = _fetch_to_local(session, gff, tmpdir)

    seqs = read_fasta(fasta_path, rename)
    lengths = {c: len(s) for c, s in seqs.items()}
    genes_by_contig = parse_gff_genes(gff_path, rename) if gff_path else {}

    # chrom sizes (consumed by _chrom_sizes() -> render config -> frontend clamp)
    session._write_cached_json(f"{base}/cache/ucsc/chrom_sizes/{build}.json", lengths)

    for contig, seq in seqs.items():
        length = lengths[contig]

        # reference: whole chromosome, 0-based; reader slices seq[start:end].
        ref_uri = f"{base}/cache/ucsc/reference/{build}/{contig}.json"
        session._write_cached_json(
            ref_uri, {"contig": contig, "start": 0, "end": length, "sequence": seq}
        )
        session._record_ucsc_interval("reference", {
            "genome_build": build, "track": "ncbiRefSeq", "contig": contig,
            "start": 0, "end": length, "uri": ref_uri,
        })

        # ideogram: single flat band spanning the chromosome (no cytobands).
        ideo_uri = f"{base}/cache/ucsc/ideogram/{build}/{contig}.json"
        session._write_cached_json(ideo_uri, [{
            "chrom": contig, "chromStart": 0, "chromEnd": length,
            "name": contig, "gieStain": "gneg", "color": _IDEO_BAND_COLOR,
        }])
        session._record_ucsc_interval("ideogram", {
            "genome_build": build, "track": "cytoBandIdeo", "contig": contig,
            "start": 0, "end": 1, "uri": ideo_uri,
        })

        # genes: covering blob for the whole chromosome; reader subsets by locus.
        models = genes_by_contig.get(contig, [])
        genes_uri = f"{base}/cache/ucsc/genes/{build}/ncbiRefSeq/{contig}.json"
        session._write_cached_json(genes_uri, models)
        session._record_ucsc_interval("genes", {
            "genome_build": build, "track": "ncbiRefSeq", "contig": contig,
            "start": 0, "end": length, "uri": genes_uri,
        })

        if verbose:
            print(f"  staged {contig}: {length:,} bp, {len(models)} genes")

    if verbose:
        print(f"Staged {len(seqs)} contigs for genome build '{build}'.")
    return lengths


def stage_plasmodb(
    session,
    fasta_path: str,
    gff_path: str,
    contig_rename: Optional[Union[Dict[str, str], Callable[[str], str]]] = None,
    verbose: bool = True,
) -> Dict[str, int]:
    """Back-compat alias for :func:`stage_reference` (FASTA + required GFF)."""
    return stage_reference(session, fasta_path, gff=gff_path,
                           contig_rename=contig_rename, verbose=verbose)


def demo():
    """Self-check: FASTA + GFF3 parsing round-trips to gene models / sequence."""
    import io

    fasta = ">Pf3D7_01_v3 desc\nACGTACGTACGTACGTACGT\nACGTACGTAC\n>Pf3D7_02_v3\nTTTTGGGGCCCC\n"
    # Two genes on chr01; g1 has two transcripts sharing exons (union merge test),
    # g2 is a single-exon gene that must land in its own lane if it overlaps g1.
    gff = "\n".join([
        "##gff-version 3",
        "Pf3D7_01_v3\tPlasmoDB\tprotein_coding_gene\t1\t12\t.\t+\t.\tID=g1;Name=GENE1",
        "Pf3D7_01_v3\tPlasmoDB\tmRNA\t1\t12\t.\t+\t.\tID=g1.1;Parent=g1",
        "Pf3D7_01_v3\tPlasmoDB\texon\t1\t4\t.\t+\t.\tID=e1;Parent=g1.1",
        "Pf3D7_01_v3\tPlasmoDB\texon\t9\t12\t.\t+\t.\tID=e2;Parent=g1.1",
        "Pf3D7_01_v3\tPlasmoDB\tmRNA\t1\t12\t.\t+\t.\tID=g1.2;Parent=g1",
        "Pf3D7_01_v3\tPlasmoDB\texon\t1\t6\t.\t+\t.\tID=e3;Parent=g1.2",
        "Pf3D7_01_v3\tPlasmoDB\tncRNA_gene\t3\t7\t.\t-\t.\tID=g2;Name=GENE2",
        "Pf3D7_01_v3\tPlasmoDB\tncRNA\t3\t7\t.\t-\t.\tID=g2.1;Parent=g2",
        "Pf3D7_01_v3\tPlasmoDB\texon\t3\t7\t.\t-\t.\tID=e4;Parent=g2.1",
        # g3: CDS-only (no exon feature) -> falls back to CDS union.
        "Pf3D7_02_v3\tPlasmoDB\tprotein_coding_gene\t2\t9\t.\t+\t.\tID=g3;Name=GENE3",
        "Pf3D7_02_v3\tPlasmoDB\tmRNA\t2\t9\t.\t+\t.\tID=g3.1;Parent=g3",
        "Pf3D7_02_v3\tPlasmoDB\tCDS\t2\t9\t.\t+\t.\tID=c1;Parent=g3.1",
        # g4: bare gene span (no exon, no CDS) -> falls back to gene span.
        "Pf3D7_02_v3\tPlasmoDB\tncRNA_gene\t11\t12\t.\t+\t.\tID=g4;Name=GENE4",
        "##FASTA",
        ">ignored", "ACGT",   # must be skipped, not parsed as features
    ])

    # Monkeypatch _open_text to read from strings.
    global _open_text
    orig = _open_text
    files = {"f.fa": fasta, "f.gff": gff}
    _open_text = lambda p: io.StringIO(files[p])
    try:
        seqs = read_fasta("f.fa")
        genes = parse_gff_genes("f.gff")
    finally:
        _open_text = orig

    assert seqs["Pf3D7_01_v3"] == "ACGTACGTACGTACGTACGTACGTACGTAC", seqs["Pf3D7_01_v3"]
    assert len(seqs["Pf3D7_01_v3"]) == 30
    assert seqs["Pf3D7_02_v3"] == "TTTTGGGGCCCC"

    ch1 = {g["name"]: g for g in genes["Pf3D7_01_v3"]}
    # GENE1: union of exons [1-4],[9-12] from t1 and [1-6] from t2 -> [1-6],[9-12]
    assert ch1["GENE1"]["exons"] == [[1, 6, True], [9, 12, True]], ch1["GENE1"]["exons"]
    assert ch1["GENE1"]["start"] == 1 and ch1["GENE1"]["end"] == 12
    assert ch1["GENE1"]["strand"] == "+"
    # GENE2 overlaps GENE1 -> different lane; strand carried from feature.
    assert ch1["GENE2"]["exons"] == [[3, 7, True]]
    assert ch1["GENE2"]["strand"] == "-"
    assert ch1["GENE1"]["lane"] != ch1["GENE2"]["lane"]

    ch2 = {g["name"]: g for g in genes["Pf3D7_02_v3"]}
    assert ch2["GENE3"]["exons"] == [[2, 9, True]], ch2["GENE3"]["exons"]      # CDS fallback
    assert ch2["GENE4"]["exons"] == [[11, 12, True]], ch2["GENE4"]["exons"]    # gene-span fallback
    print("plasmodb.demo: OK")


if __name__ == "__main__":
    demo()
