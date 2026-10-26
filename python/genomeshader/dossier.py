# dossier.py: one static PNG per GWAS hit for the FELIX hit dossier.
#
# Inputs are the dossier tables (felix_dossier_loci.tsv, felix_dossier_leads.tsv)
# and FELIX's pheno_cov.tsv (ID, covariates, then one 1/0/NA column per
# phenotype). For each locus the page shows carriers of the lead allele split
# case/control, n_per_group of each, chosen from ALL carriers (not a capped
# prefix) with a shuffle seeded by locus_id: rerunning reproduces every page.
import csv
import random
import threading
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence

CASE, CONTROL = "case", "control"

# Pages zoom on the lead variant: the dossier's 500 kb association window is
# ~300 bp/pixel at figure width, too coarse to read individual alignments.
DEFAULT_FLANK_BP = 5000

MANIFEST_FIELDS = [
    "locus_id", "phenotype", "region", "lead", "status", "png",
    "n_carriers", "n_case_carriers", "n_control_carriers", "samples", "tracks_without_reads", "error",
]


def read_tsv(path) -> List[dict]:
    with open(path, newline="") as f:
        return list(csv.DictReader(f, delimiter="\t"))


def case_control_status(pheno_cov_rows: Sequence[dict], phenotype: str,
                        id_col: str = "ID") -> Dict[str, str]:
    """sample -> 'case' | 'control' for one phenotype column; NA/blank are left out."""
    out = {}
    for row in pheno_cov_rows:
        v = (row.get(phenotype) or "").strip()
        if v in ("1", "1.0", "TRUE", "True", "true"):
            out[str(row[id_col])] = CASE
        elif v in ("0", "0.0", "FALSE", "False", "false"):
            out[str(row[id_col])] = CONTROL
    return out


def select_balanced(by_level: Dict[str, Sequence[str]], n_per_level: int, seed: str,
                    levels: Sequence[str] = (CASE, CONTROL)) -> List[str]:
    """Up to n_per_level samples from each level, in `levels` order. A short
    level is backfilled from the others so the page keeps its track count.
    Each level's pool is shuffled by a seed derived from `seed` and the level,
    so the choice is reproducible and independent across loci."""
    pools = {}
    for level in levels:
        pool = sorted(set(by_level.get(level, ())))
        random.Random(f"{seed}|{level}").shuffle(pool)
        pools[level] = pool
    total = n_per_level * len(levels)
    picked = {level: [] for level in levels}
    count, progressed = 0, True
    while count < total and progressed:
        progressed = False
        for level in levels:
            if count >= total:
                break
            got, pool = picked[level], pools[level]
            if len(got) < len(pool):
                got.append(pool[len(got)])
                count += 1
                progressed = True
    return [s for level in levels for s in picked[level]]


def lead_variant(locus: dict, leads_by_key: Dict[tuple, dict]) -> Optional[dict]:
    """The lead arm's row in felix_dossier_leads.tsv: contig, pos, ref, alt."""
    row = leads_by_key.get((locus["locus_id"], locus.get("lead_arm") or "main"))
    if row is None:
        return None
    contig = str(row.get("CHR") or locus["chrom"])
    if not contig.startswith("chr"):
        contig = "chr" + contig
    return {"contig": contig, "pos": int(row["POS"]),
            "ref": row["Allele1"], "alt": row["Allele2"], "marker": row.get("MarkerID", "")}


def _region(locus: dict, lead: dict, flank_bp: Optional[int]) -> str:
    if flank_bp:
        return f"{lead['contig']}:{max(1, lead['pos'] - flank_bp)}-{lead['pos'] + flank_bp}"
    return f"{lead['contig']}:{int(locus['window_start'])}-{int(locus['window_end'])}"


def export_dossier(shader, loci_tsv, leads_tsv, pheno_cov_tsv, out_dir,
                   n_per_group: int = 4, flank_bp: Optional[int] = DEFAULT_FLANK_BP,
                   width: int = 1600, height: int = 1000, loci: Optional[Iterable[str]] = None,
                   skip_existing: bool = True, id_col: str = "ID",
                   timeout_s: float = 300.0) -> Path:
    """Write `<out_dir>/<locus_id>.png` for every locus plus `manifest.tsv`.

    The window is the lead position +/- flank_bp; pass flank_bp=None for the
    dossier's window_start..window_end. A locus that fails is recorded in the manifest and
    the run continues. Returns the manifest path.
    """
    from .export import chrome_launch_kwargs, export_locus_png

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    loci_rows = read_tsv(loci_tsv)
    if loci is not None:
        wanted = set(loci)
        loci_rows = [r for r in loci_rows if r["locus_id"] in wanted]
    leads_by_key = {(r["locus_id"], r.get("arm") or "main"): r for r in read_tsv(leads_tsv)}
    pheno_rows = read_tsv(pheno_cov_tsv)
    with_reads = set(str(s) for s in (shader._samples_with_reads() or []))
    status_cache: Dict[str, Dict[str, str]] = {}
    manifest_path = out_dir / "manifest.tsv"
    rows: List[dict] = []

    def _one(locus: dict, browser) -> dict:
        rec = {k: "" for k in MANIFEST_FIELDS}
        rec.update(locus_id=locus["locus_id"], phenotype=locus["phenotype"])
        png = out_dir / f"{locus['locus_id']}.png"
        rec["png"] = png.name
        lead = lead_variant(locus, leads_by_key)
        if lead is None:
            rec.update(status="error", error="no lead row in leads table")
            return rec
        rec["lead"] = f"{lead['contig']}:{lead['pos']}:{lead['ref']}>{lead['alt']}"
        rec["region"] = _region(locus, lead, flank_bp)
        if locus["phenotype"] not in status_cache:
            status_cache[locus["phenotype"]] = case_control_status(pheno_rows, locus["phenotype"], id_col)
        status = status_cache[locus["phenotype"]]
        if not status:
            rec.update(status="error", error=f"phenotype column {locus['phenotype']!r} missing or empty in pheno_cov")
            return rec
        carriers = [str(s) for s in shader.fetch_carriers(
            lead["contig"], lead["pos"], lead["ref"], lead["alt"], strategy="first", n=10 ** 9)]
        carriers = [s for s in carriers if s in with_reads] if with_reads else carriers
        by_level = {CASE: [s for s in carriers if status.get(s) == CASE],
                    CONTROL: [s for s in carriers if status.get(s) == CONTROL]}
        samples = select_balanced(by_level, n_per_group, seed=locus["locus_id"])
        rec.update(n_carriers=len(carriers), n_case_carriers=len(by_level[CASE]),
                   n_control_carriers=len(by_level[CONTROL]), samples=",".join(samples))
        if skip_existing and png.exists():
            rec["status"] = "skipped"
            return rec
        out = export_locus_png(shader, rec["region"], png, samples=samples, width=width,
                               height=height, seed=locus["locus_id"], browser=browser,
                               timeout_s=timeout_s)
        empty = sorted({t["sample"] for t in out["tracks"] if not t["reads"]})
        rec.update(status="ok", tracks_without_reads=",".join(empty))
        return rec

    def _run():
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            browser = pw.chromium.launch(**chrome_launch_kwargs())
            try:
                for locus in loci_rows:
                    try:
                        rec = _one(locus, browser)
                    except Exception as e:
                        rec = {k: "" for k in MANIFEST_FIELDS}
                        rec.update(locus_id=locus["locus_id"], phenotype=locus.get("phenotype", ""),
                                   status="error", error=f"{type(e).__name__}: {e}")
                    rows.append(rec)
                    print(f"[dossier] {rec['locus_id']}: {rec['status']}"
                          + (f" ({rec['error']})" if rec.get("error") else ""), flush=True)
            finally:
                browser.close()

    # Playwright's sync API refuses a thread that has an asyncio loop (Jupyter).
    box = {}

    def _guarded():
        try:
            _run()
        except BaseException as e:
            box["error"] = e

    t = threading.Thread(target=_guarded, name="gs-dossier", daemon=True)
    t.start()
    t.join()
    with open(manifest_path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=MANIFEST_FIELDS, delimiter="\t")
        w.writeheader()
        w.writerows(rows)
    if "error" in box:
        raise box["error"]
    return manifest_path
