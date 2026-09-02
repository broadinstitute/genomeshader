"""Tests for PlasmoDB / VEuPathDB annotation staging (genomeshader.plasmodb).

Two layers:
  * pure parser tests (read_fasta / parse_gff_genes / helpers) — no session
  * integration through the real GenomeShader, with gs._init mocked and the
    cache pointed at a temp dir, proving stage_plasmodb output is served by
    the actual ideogram/genes/reference methods with the UCSC API off.

All inputs are synthetic — no network, no PlasmoDB download required.
"""
import os
import sys
import textwrap
from unittest.mock import Mock, patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# The genomeshader package imports its native extension at load time; skip the
# whole module cleanly if it hasn't been built, matching the rest of the suite.
pytest.importorskip("genomeshader.genomeshader")

from genomeshader.plasmodb import (
    stage_plasmodb,
    stage_reference,
    read_fasta,
    parse_gff_genes,
    _fetch_to_local,
    _merge_intervals,
    _assign_lanes,
)
from genomeshader.view import GenomeShader


# --------------------------------------------------------------------------- #
# fixtures                                                                     #
# --------------------------------------------------------------------------- #

FASTA = ">Pf3D7_01_v3 some description\n" + "ACGT" * 25 + "\n" + \
        ">Pf3D7_02_v3\n" + "TTTTGGGGCCCC" + "\n"

GFF = textwrap.dedent("""\
    ##gff-version 3
    ##sequence-region Pf3D7_01_v3 1 100
    Pf3D7_01_v3\tPlasmoDB\tprotein_coding_gene\t10\t40\t.\t+\t.\tID=g1;Name=PF1
    Pf3D7_01_v3\tPlasmoDB\tmRNA\t10\t40\t.\t+\t.\tID=g1.1;Parent=g1
    Pf3D7_01_v3\tPlasmoDB\texon\t10\t20\t.\t+\t.\tID=e1;Parent=g1.1
    Pf3D7_01_v3\tPlasmoDB\texon\t30\t40\t.\t+\t.\tID=e2;Parent=g1.1
    Pf3D7_01_v3\tPlasmoDB\tmRNA\t10\t40\t.\t+\t.\tID=g1.2;Parent=g1
    Pf3D7_01_v3\tPlasmoDB\texon\t10\t25\t.\t+\t.\tID=e3;Parent=g1.2
    Pf3D7_01_v3\tPlasmoDB\tncRNA_gene\t12\t18\t.\t-\t.\tID=g2;Name=PF2
    Pf3D7_01_v3\tPlasmoDB\tncRNA\t12\t18\t.\t-\t.\tID=g2.1;Parent=g2
    Pf3D7_01_v3\tPlasmoDB\texon\t12\t18\t.\t-\t.\tID=e4;Parent=g2.1
    Pf3D7_02_v3\tPlasmoDB\tprotein_coding_gene\t2\t9\t.\t+\t.\tID=g3;Name=PF3
    Pf3D7_02_v3\tPlasmoDB\tmRNA\t2\t9\t.\t+\t.\tID=g3.1;Parent=g3
    Pf3D7_02_v3\tPlasmoDB\tCDS\t2\t9\t.\t+\t.\tID=c1;Parent=g3.1
    Pf3D7_02_v3\tPlasmoDB\tncRNA_gene\t11\t12\t.\t+\t.\tID=g4;Name=PF4
    ##FASTA
    >Pf3D7_01_v3
    ACGTACGTACGT
    """)


@pytest.fixture
def genome_files(tmp_path):
    fa = tmp_path / "pf.fasta"
    gff = tmp_path / "pf.gff"
    fa.write_text(FASTA)
    gff.write_text(GFF)
    return str(fa), str(gff)


@pytest.fixture
def staged_session(tmp_path, monkeypatch, genome_files):
    """A GenomeShader with a temp local cache, primed with the synthetic genome."""
    monkeypatch.setenv("GENOMESHADER_LOCAL_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.delenv("GENOMESHADER_ALLOW_UCSC_API", raising=False)
    fa, gff = genome_files
    with patch("genomeshader.view.gs._init", return_value=Mock()):
        s = GenomeShader(genome_build="PlasmoDB-61_Pfalciparum3D7",
                         gcs_session_dir="gs://test-bucket/genomeshader")
        stage_plasmodb(s, fa, gff, verbose=False)

        # Fresh instance -> forces the cache interval index to reload from disk
        # rather than reuse in-memory state, exercising the persistence path.
        s2 = GenomeShader(genome_build="PlasmoDB-61_Pfalciparum3D7",
                          gcs_session_dir="gs://test-bucket/genomeshader")
    return s2


# --------------------------------------------------------------------------- #
# pure parser                                                                  #
# --------------------------------------------------------------------------- #

def test_read_fasta_multicontig_and_wrapping(genome_files):
    fa, _ = genome_files
    seqs = read_fasta(fa)
    assert set(seqs) == {"Pf3D7_01_v3", "Pf3D7_02_v3"}
    assert seqs["Pf3D7_01_v3"] == "ACGT" * 25          # header desc stripped
    assert len(seqs["Pf3D7_01_v3"]) == 100
    assert seqs["Pf3D7_02_v3"] == "TTTTGGGGCCCC"


def test_read_fasta_uppercases_and_renames(tmp_path):
    p = tmp_path / "l.fa"
    p.write_text(">c1\nacgt\n")
    seqs = read_fasta(str(p), rename={"c1": "chr1"}.get)
    assert seqs == {"chr1": "ACGT"}


def test_read_fasta_rejects_empty_header(tmp_path):
    # A header with no seqid must raise, not crash with IndexError.
    p = tmp_path / "bad.fa"
    p.write_text(">   \nACGT\n")
    with pytest.raises(ValueError):
        read_fasta(str(p))


def test_exon_union_across_transcripts(genome_files):
    _, gff = genome_files
    genes = {g["name"]: g for g in parse_gff_genes(gff)["Pf3D7_01_v3"]}
    # g1 exons: t1 [10-20],[30-40]; t2 [10-25] -> union [10-25],[30-40]
    assert genes["PF1"]["exons"] == [[10, 25, True], [30, 40, True]]
    assert genes["PF1"]["start"] == 10 and genes["PF1"]["end"] == 40
    assert genes["PF1"]["strand"] == "+"


def test_cds_fallback_when_no_exon(genome_files):
    _, gff = genome_files
    genes = {g["name"]: g for g in parse_gff_genes(gff)["Pf3D7_02_v3"]}
    assert genes["PF3"]["exons"] == [[2, 9, True]]      # from CDS, no exon feature


def test_gene_span_fallback_when_no_exon_or_cds(genome_files):
    _, gff = genome_files
    genes = {g["name"]: g for g in parse_gff_genes(gff)["Pf3D7_02_v3"]}
    assert genes["PF4"]["exons"] == [[11, 12, True]]    # bare gene span


def test_overlapping_genes_get_distinct_lanes(genome_files):
    _, gff = genome_files
    genes = {g["name"]: g for g in parse_gff_genes(gff)["Pf3D7_01_v3"]}
    # PF2 (12-18) sits inside PF1 (10-40) -> must not share a lane.
    assert genes["PF1"]["lane"] != genes["PF2"]["lane"]


def test_fasta_directive_stops_gff_parsing(tmp_path):
    # Sequence lines after ##FASTA must not be parsed as (bogus) features.
    gff = tmp_path / "x.gff"
    gff.write_text("chr1\tX\tprotein_coding_gene\t1\t5\t.\t+\t.\tID=g;Name=G\n"
                   "chr1\tX\texon\t1\t5\t.\t+\t.\tID=e;Parent=g\n"
                   "##FASTA\n>chr1\nACGTNNNN\n")
    genes = parse_gff_genes(str(gff))
    assert list(genes) == ["chr1"] and len(genes["chr1"]) == 1


def test_contig_rename_applies_to_genes(genome_files):
    _, gff = genome_files
    genes = parse_gff_genes(gff, rename={"Pf3D7_01_v3": "chr1"}.get)
    assert "chr1" in genes and "Pf3D7_01_v3" not in genes


def test_merge_intervals():
    assert _merge_intervals([[1, 4], [3, 6], [10, 12]]) == [[1, 6], [10, 12]]
    assert _merge_intervals([[5, 6], [1, 2]]) == [[1, 2], [5, 6]]   # sorts
    assert _merge_intervals([[1, 2], [3, 4]]) == [[1, 4]]           # adjacent merge
    assert _merge_intervals([]) == []


def test_assign_lanes_packs_nonoverlapping_together():
    models = [{"start": 1, "end": 5}, {"start": 10, "end": 15}, {"start": 3, "end": 12}]
    _assign_lanes(models)
    by = {(m["start"], m["end"]): m["lane"] for m in models}
    assert by[(1, 5)] == by[(10, 15)]          # disjoint -> same lane
    assert by[(3, 12)] != by[(1, 5)]           # overlaps both -> different lane


# --------------------------------------------------------------------------- #
# integration through the real GenomeShader                                    #
# --------------------------------------------------------------------------- #

def test_reference_slice(staged_session):
    assert staged_session.reference("Pf3D7_01_v3", 0, 8) == "ACGTACGT"
    assert staged_session.reference("Pf3D7_01_v3", 96, 100) == "ACGT"


def test_genes_served_and_windowed(staged_session):
    genes = staged_session.genes("Pf3D7_01_v3", 25, 35)   # overlaps PF1 only
    names = [g["name"] for g in genes]
    assert "PF1" in names
    assert staged_session.genes("Pf3D7_01_v3", 50, 90) == []   # empty region


def test_cds_gene_served(staged_session):
    genes = staged_session.genes("Pf3D7_02_v3", 1, 12)
    assert any(g["name"] == "PF3" and g["exons"] == [[2, 9, True]] for g in genes)


def test_ideogram_single_band(staged_session):
    ideo = staged_session.ideogram("Pf3D7_01_v3")
    rows = ideo.to_dicts() if hasattr(ideo, "to_dicts") else ideo
    assert len(rows) == 1
    assert int(rows[0]["chromEnd"]) == 100


def test_chrom_sizes_for_render_config(staged_session):
    # This is exactly what render() injects as window.GENOMESHADER_CONFIG.chrom_lengths
    assert staged_session._chrom_sizes() == {"Pf3D7_01_v3": 100, "Pf3D7_02_v3": 12}


# --------------------------------------------------------------------------- #
# scheme-aware fetch layer                                                     #
# --------------------------------------------------------------------------- #

def test_fetch_local_passthrough(tmp_path):
    p = tmp_path / "ref.fa"
    p.write_text(">c\nACGT\n")
    assert _fetch_to_local(None, str(p), str(tmp_path)) == str(p)
    assert _fetch_to_local(None, None, str(tmp_path)) is None


def test_fetch_file_uri_strips_scheme(tmp_path):
    assert _fetch_to_local(None, "file:///abs/ref.fa", str(tmp_path)) == "/abs/ref.fa"


def test_fetch_unknown_scheme_raises(tmp_path):
    with pytest.raises(ValueError):
        _fetch_to_local(None, "ftp://host/ref.fa", str(tmp_path))


def test_fetch_gs_uses_session_cp(tmp_path):
    srcdir = tmp_path / "remote"; srcdir.mkdir()
    src = srcdir / "src.fa"
    src.write_text("DATA")
    sess = Mock()
    def fake_cp(uri, dst):
        with open(dst, "w") as fh:
            fh.write(src.read_text())
        return True
    sess._gcs_cp.side_effect = fake_cp
    out = _fetch_to_local(sess, "gs://bucket/src.fa", str(tmp_path))
    assert os.path.basename(out) == "src.fa" and open(out).read() == "DATA"


def test_fetch_gs_falls_back_to_public_https(tmp_path, monkeypatch):
    # gcloud/gsutil fail (unauthenticated or missing) -> the anonymous public
    # HTTPS endpoint serves the object, so staging a public reference still works.
    sess = Mock()
    sess._gcs_cp.return_value = False
    seen = {}
    def fake_dl(url, dst):
        seen["url"] = url
        with open(dst, "w") as fh:
            fh.write("PUB")
    monkeypatch.setattr("genomeshader.plasmodb._http_download", fake_dl)
    out = _fetch_to_local(sess, "gs://broad-malaria-public/ref.fa", str(tmp_path))
    assert open(out).read() == "PUB"
    assert seen["url"] == "https://storage.googleapis.com/broad-malaria-public/ref.fa"


def test_fetch_gs_total_failure_reports_reason(tmp_path, monkeypatch):
    # Both gcloud/gsutil and the HTTPS fallback fail -> the error must surface the
    # real reason, not a bare "failed to fetch".
    sess = Mock()
    sess._gcs_cp.return_value = False
    def boom(url, dst):
        raise RuntimeError("HTTP 403")
    monkeypatch.setattr("genomeshader.plasmodb._http_download", boom)
    monkeypatch.setattr("genomeshader.plasmodb._run_capture",
                        lambda cmd: (127, "gcloud: command not found"))
    with pytest.raises(RuntimeError) as ei:
        _fetch_to_local(sess, "gs://private/ref.fa", str(tmp_path))
    msg = str(ei.value)
    assert "HTTP 403" in msg and "gcloud" in msg and "gcloud auth login" in msg


def test_fetch_http_streams(tmp_path, monkeypatch):
    class FakeResp:
        status_code = 200
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def iter_content(self, chunk_size=0): yield b"HELLO"
    monkeypatch.setattr("requests.get", lambda uri, stream=False: FakeResp())
    out = _fetch_to_local(None, "http://host/ref.fa?token=x", str(tmp_path))
    assert os.path.basename(out) == "ref.fa" and open(out, "rb").read() == b"HELLO"


def test_fetch_s3_shells_out(tmp_path, monkeypatch):
    srcdir = tmp_path / "remote"; srcdir.mkdir()
    src = srcdir / "s.fa"
    src.write_text("S3DATA")
    def fake_run(cmd, **kw):
        # cmd == ["aws","s3","cp", uri, dst]
        with open(cmd[4], "w") as fh:
            fh.write(src.read_text())
        return Mock(returncode=0)
    monkeypatch.setattr("genomeshader.plasmodb.subprocess.run", fake_run)
    out = _fetch_to_local(None, "s3://bucket/s.fa", str(tmp_path))
    assert open(out).read() == "S3DATA"


# --------------------------------------------------------------------------- #
# stage_reference (fasta-only) + back-compat                                   #
# --------------------------------------------------------------------------- #

@pytest.fixture
def staged_fasta_only(tmp_path, monkeypatch, genome_files):
    monkeypatch.setenv("GENOMESHADER_LOCAL_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.delenv("GENOMESHADER_ALLOW_UCSC_API", raising=False)
    fa, _ = genome_files
    with patch("genomeshader.view.gs._init", return_value=Mock()):
        s = GenomeShader(genome_build="PlasmoDB-61_Pfalciparum3D7",
                         gcs_session_dir="gs://test-bucket/genomeshader")
        stage_reference(s, fa, verbose=False)          # no gff
        s2 = GenomeShader(genome_build="PlasmoDB-61_Pfalciparum3D7",
                          gcs_session_dir="gs://test-bucket/genomeshader")
    return s2


def test_stage_reference_fasta_only(staged_fasta_only):
    s = staged_fasta_only
    assert s.reference("Pf3D7_01_v3", 0, 8) == "ACGTACGT"     # reference served
    assert s._chrom_sizes() == {"Pf3D7_01_v3": 100, "Pf3D7_02_v3": 12}
    ideo = s.ideogram("Pf3D7_01_v3")
    rows = ideo.to_dicts() if hasattr(ideo, "to_dicts") else ideo
    assert len(rows) == 1                                     # ideogram served
    assert s.genes("Pf3D7_01_v3", 0, 100) == []              # no genes without gff


def test_stage_reference_skips_when_already_staged(tmp_path, monkeypatch, genome_files):
    import genomeshader.plasmodb as P
    monkeypatch.setenv("GENOMESHADER_LOCAL_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.delenv("GENOMESHADER_ALLOW_UCSC_API", raising=False)
    fa, gff = genome_files
    with patch("genomeshader.view.gs._init", return_value=Mock()):
        s = GenomeShader(genome_build="PlasmoDB-61_Pfalciparum3D7",
                         gcs_session_dir="gs://test-bucket/genomeshader")
        first = stage_reference(s, fa, gff=gff, verbose=False)
        assert first == {"Pf3D7_01_v3": 100, "Pf3D7_02_v3": 12}

        # A fresh session must reuse the cache, NOT re-parse the FASTA.
        s2 = GenomeShader(genome_build="PlasmoDB-61_Pfalciparum3D7",
                          gcs_session_dir="gs://test-bucket/genomeshader")
        with patch.object(P, "read_fasta", side_effect=AssertionError("re-parsed a cached reference")):
            again = stage_reference(s2, fa, gff=gff, verbose=False)
        assert again == first

        # force=True bypasses the cache and re-stages (read_fasta runs).
        calls = []
        orig = P.read_fasta
        with patch.object(P, "read_fasta", side_effect=lambda *a, **k: (calls.append(1), orig(*a, **k))[1]):
            forced = stage_reference(s2, fa, gff=gff, verbose=False, force=True)
        assert forced == first and calls


def test_stage_plasmodb_delegates(tmp_path, monkeypatch, genome_files):
    monkeypatch.setenv("GENOMESHADER_LOCAL_CACHE_DIR", str(tmp_path / "c"))
    monkeypatch.delenv("GENOMESHADER_ALLOW_UCSC_API", raising=False)
    fa, gff = genome_files
    with patch("genomeshader.view.gs._init", return_value=Mock()):
        s = GenomeShader(genome_build="PlasmoDB-61_Pfalciparum3D7",
                         gcs_session_dir="gs://test-bucket/genomeshader")
        via_wrapper = stage_plasmodb(s, fa, gff, verbose=False)
        via_direct = stage_reference(s, fa, gff=gff, verbose=False)
    assert via_wrapper == via_direct                          # same {contig: length}
