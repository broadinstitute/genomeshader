"""Dossier batch driver: case/control carrier selection and the manifest."""
import contextlib
import csv
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
pytest.importorskip("genomeshader.genomeshader")

from genomeshader import dossier as D  # noqa: E402

LOCI = [
    {"locus_id": "MS_718__chr1_4642733", "phenotype": "MS_718", "chrom": "1", "pos": "4642733",
     "lead_arm": "main", "window_start": "4392733", "window_end": "4892733"},
    {"locus_id": "DE_660_12__chr1_19786242", "phenotype": "DE_660.12", "chrom": "1", "pos": "19786242",
     "lead_arm": "main", "window_start": "19536242", "window_end": "20036242"},
    {"locus_id": "NOLEAD__chr2_1", "phenotype": "MS_718", "chrom": "2", "pos": "1",
     "lead_arm": "main", "window_start": "1", "window_end": "100"},
]
LEADS = [
    {"locus_id": "MS_718__chr1_4642733", "arm": "main", "CHR": "chr1", "POS": "4642733",
     "MarkerID": "chr1_4642733_C_T_C_T", "Allele1": "C", "Allele2": "T"},
    {"locus_id": "DE_660_12__chr1_19786242", "arm": "main", "CHR": "chr1", "POS": "19786242",
     "MarkerID": "chr1_19786242_C_G_C_G", "Allele1": "C", "Allele2": "G"},
]
SAMPLES = [f"S{i:02d}" for i in range(30)]


def _pheno_rows():
    rows = []
    for i, s in enumerate(SAMPLES):
        rows.append({"ID": s, "age": "50", "MS_718": "1" if i < 10 else ("NA" if i >= 25 else "0"),
                     "DE_660.12": "1" if i % 3 == 0 else "0"})
    return rows


def _write(path, rows):
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]), delimiter="\t")
        w.writeheader()
        w.writerows(rows)
    return path


def test_case_control_status_skips_na():
    st = D.case_control_status(_pheno_rows(), "MS_718")
    assert st["S00"] == D.CASE and st["S10"] == D.CONTROL and "S27" not in st
    assert D.case_control_status(_pheno_rows(), "NOT_A_COLUMN") == {}


def test_select_balanced_is_seeded_and_balanced():
    levels = {D.CASE: SAMPLES[:10], D.CONTROL: SAMPLES[10:]}
    a = D.select_balanced(levels, 4, seed="locus_a")
    assert a == D.select_balanced(levels, 4, seed="locus_a")
    assert a[:4] and set(a[:4]) <= set(SAMPLES[:10]) and set(a[4:]) <= set(SAMPLES[10:])
    assert len(a) == 8
    assert a != D.select_balanced(levels, 4, seed="locus_b")
    # Input order must not matter (carriers come back in VCF order).
    rev = {k: list(reversed(v)) for k, v in levels.items()}
    assert D.select_balanced(rev, 4, seed="locus_a") == a


def test_select_balanced_backfills_short_level():
    out = D.select_balanced({D.CASE: ["C1"], D.CONTROL: [f"K{i}" for i in range(10)]}, 4, seed="s")
    assert out[0] == "C1" and len(out) == 8 and len(set(out)) == 8


def test_lead_variant_and_region():
    leads = {(r["locus_id"], r["arm"]): r for r in LEADS}
    lead = D.lead_variant(LOCI[0], leads)
    assert lead == {"contig": "chr1", "pos": 4642733, "ref": "C", "alt": "T",
                    "marker": "chr1_4642733_C_T_C_T"}
    assert D._region(LOCI[0], lead, None) == "chr1:4392733-4892733"
    assert D._region(LOCI[0], lead, 5000) == "chr1:4637733-4647733"
    assert D.lead_variant(LOCI[2], leads) is None


class _Shader:
    def __init__(self):
        self.carrier_calls = []

    def _samples_with_reads(self):
        return SAMPLES[:28]

    def fetch_carriers(self, contig, pos, ref, allele, strategy="random", n=200):
        self.carrier_calls.append((contig, pos, ref, allele, strategy, n))
        if pos == 19786242:
            raise RuntimeError("VCF unreachable")
        return list(reversed(SAMPLES))  # every sample carries; reversed VCF order


@contextlib.contextmanager
def _fake_playwright():
    class _B:
        def close(self):
            pass

    class _PW:
        class chromium:
            @staticmethod
            def launch(**kw):
                return _B()

    yield _PW()


def test_export_dossier_manifest(tmp_path, monkeypatch):
    import types
    import genomeshader.export as E

    # Stand-in Playwright so the driver logic runs without it (CI's unit job
    # doesn't install it); the real browser path is covered in tests/headless.
    pw = types.ModuleType("playwright")
    pw_sync = types.ModuleType("playwright.sync_api")
    pw_sync.sync_playwright = _fake_playwright
    pw.sync_api = pw_sync
    monkeypatch.setitem(sys.modules, "playwright", pw)
    monkeypatch.setitem(sys.modules, "playwright.sync_api", pw_sync)
    exported = []

    def fake_export(shader, region, out_path, samples=(), **kw):
        exported.append((region, list(samples), kw["seed"]))
        open(out_path, "wb").write(b"png")
        return {"path": str(out_path), "page_errors": [],
                "tracks": [{"sample": s, "bam": "", "reads": 0 if s == samples[0] else 3} for s in samples]}

    monkeypatch.setattr(E, "export_locus_figure", fake_export)
    shader = _Shader()
    manifest = D.export_dossier(
        shader, _write(tmp_path / "loci.tsv", LOCI), _write(tmp_path / "leads.tsv", LEADS),
        _write(tmp_path / "pheno.tsv", _pheno_rows()), tmp_path / "out")

    rows = {r["locus_id"]: r for r in D.read_tsv(manifest)}
    ok = rows["MS_718__chr1_4642733"]
    # Default window: lead +/- 5 kb, not the 500 kb dossier window.
    assert ok["status"] == "ok" and ok["region"] == "chr1:4637733-4647733"
    assert ok["file"] == "MS_718__chr1_4642733.pdf"  # PDF by default
    assert ok["lead"] == "chr1:4642733:C>T"
    # 28 carriers with reads; MS_718: S00-S09 case, S10-S24 control, S25+ NA.
    assert (ok["n_carriers"], ok["n_case_carriers"], ok["n_control_carriers"]) == ("28", "10", "15")
    samples = ok["samples"].split(",")
    assert len(samples) == 8 and all(int(s[1:]) < 10 for s in samples[:4])
    assert all(10 <= int(s[1:]) < 25 for s in samples[4:])
    assert ok["tracks_without_reads"] == samples[0]
    assert shader.carrier_calls[0] == ("chr1", 4642733, "C", "T", "first", 10 ** 9)
    assert exported[0][2] == "MS_718__chr1_4642733"
    assert rows["DE_660_12__chr1_19786242"]["status"] == "error"
    assert "VCF unreachable" in rows["DE_660_12__chr1_19786242"]["error"]
    assert rows["NOLEAD__chr2_1"]["status"] == "error"

    # Rerun: same picks, existing PNG skipped.
    again = D.export_dossier(
        shader, tmp_path / "loci.tsv", tmp_path / "leads.tsv", tmp_path / "pheno.tsv",
        tmp_path / "out", loci=["MS_718__chr1_4642733"])
    row = D.read_tsv(again)[0]
    assert row["status"] == "skipped" and row["samples"] == ok["samples"]

    # A page whose export reports failed fetches is "partial", with the reasons.
    def failing_export(shader, region, out_path, samples=(), **kw):
        open(out_path, "wb").write(b"png")
        return {"path": str(out_path), "page_errors": [], "warnings": [],
                "tracks": [], "errors": ["no read track for S03"]}

    monkeypatch.setattr(E, "export_locus_figure", failing_export)
    part = D.export_dossier(
        shader, tmp_path / "loci.tsv", tmp_path / "leads.tsv", tmp_path / "pheno.tsv",
        tmp_path / "out_partial", loci=["MS_718__chr1_4642733"], read_set="pacbio")
    prow = D.read_tsv(part)[0]
    assert prow["status"] == "partial" and prow["error"] == "no read track for S03"
    monkeypatch.setattr(E, "export_locus_figure", fake_export)

    # flank_bp=None falls back to the dossier's own window.
    full = D.export_dossier(
        shader, tmp_path / "loci.tsv", tmp_path / "leads.tsv", tmp_path / "pheno.tsv",
        tmp_path / "out_full", flank_bp=None, loci=["MS_718__chr1_4642733"])
    assert D.read_tsv(full)[0]["region"] == "chr1:4392733-4892733"
