"""Sample metadata for Grouping (phenotype / population / cohort columns).

Accepts a table keyed by VCF sample name, derives grouping-eligible columns
(2..32 distinct values), and builds the compact config summary shipped to JS.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence, Tuple, Union

import polars as pl

from . import data_tracks as _data_tracks

UNLABELED = "(unlabeled)"
MIN_GROUP_CARDINALITY = 2
MAX_GROUP_CARDINALITY = 32

DataLike = Union[dict, "pl.DataFrame", Any]


def _stringify_value(v: Any) -> str:
    if v is None:
        return UNLABELED
    if isinstance(v, float) and v != v:  # NaN
        return UNLABELED
    s = str(v).strip()
    return s if s else UNLABELED


def coerce_sample_metadata_table(
    table: DataLike,
    sample_col: str = "sample",
) -> pl.DataFrame:
    """Normalize input into a polars DataFrame with a string sample-id column.

    Accepts:
      - polars / pandas DataFrame with a sample column
      - column-oriented dict (same as attach_data)
      - row map ``{sample_id: {col: value, ...}}``
    """
    if isinstance(table, dict) and table and all(
        isinstance(k, str) and isinstance(v, dict) for k, v in table.items()
    ):
        # {sample_id: {col: value}}
        rows = []
        for sid, attrs in table.items():
            row = {sample_col: sid}
            row.update(attrs)
            rows.append(row)
        df = pl.DataFrame(rows)
    else:
        df = _data_tracks.coerce_to_dataframe(table)

    if sample_col not in df.columns:
        raise ValueError(
            f"attach_metadata: sample column {sample_col!r} not found; "
            f"available: {list(df.columns)}"
        )

    # Dedup on sample id (last wins); stringify the id column.
    out = df.with_columns(pl.col(sample_col).cast(pl.Utf8).alias(sample_col))
    out = out.unique(subset=[sample_col], keep="last")
    return out


def grouping_eligible_columns(
    df: pl.DataFrame,
    sample_col: str = "sample",
) -> List[str]:
    """Columns with 2..32 distinct non-null string values (excluding sample_col)."""
    eligible = []
    for col in df.columns:
        if col == sample_col:
            continue
        vals = set()
        for v in df[col].to_list():
            vals.add(_stringify_value(v))
        n = len(vals)
        if MIN_GROUP_CARDINALITY <= n <= MAX_GROUP_CARDINALITY:
            eligible.append(col)
    return eligible


def sample_group_lookup(
    df: pl.DataFrame,
    column: str,
    sample_col: str = "sample",
) -> Dict[str, str]:
    """sample_id -> group label for one column (missing/null -> UNLABELED)."""
    if column not in df.columns:
        return {}
    out: Dict[str, str] = {}
    for row in df.select([sample_col, column]).iter_rows(named=True):
        sid = row.get(sample_col)
        if sid is None:
            continue
        out[str(sid)] = _stringify_value(row.get(column))
    return out


def build_config_summary(
    df: Optional[pl.DataFrame],
    *,
    sample_col: str = "sample",
    read_samples: Optional[Sequence[str]] = None,
    vcf_universe: Optional[set] = None,
) -> Optional[dict]:
    """Compact config blob for GENOMESHADER_CONFIG.sample_metadata.

    Returns None when no metadata is attached.
    """
    if df is None or not isinstance(df, pl.DataFrame) or len(df) == 0:
        return None

    eligible = grouping_eligible_columns(df, sample_col=sample_col)
    columns_out = []
    for i, col in enumerate(eligible):
        counts: Dict[str, int] = {}
        for v in df[col].to_list():
            label = _stringify_value(v)
            counts[label] = counts.get(label, 0) + 1
        # Also count samples in the VCF universe that are missing from the table
        # as unlabeled when we know the universe.
        if vcf_universe:
            present = set(str(s) for s in df[sample_col].to_list())
            missing_n = sum(1 for s in vcf_universe if str(s) not in present)
            if missing_n:
                counts[UNLABELED] = counts.get(UNLABELED, 0) + missing_n
        values = []
        for j, (val, cnt) in enumerate(sorted(counts.items(), key=lambda t: (-t[1], t[0]))):
            color = _data_tracks.DEFAULT_PALETTE[
                (i * 3 + j) % len(_data_tracks.DEFAULT_PALETTE)
            ]
            values.append({"value": val, "count": int(cnt), "color": color})
        columns_out.append({"name": col, "values": values})

    by_id: Dict[str, Dict[str, str]] = {}
    id_set = set(str(s) for s in (read_samples or []))
    if not id_set:
        # Fall back to all rows when read_samples isn't known yet.
        id_set = set(str(s) for s in df[sample_col].to_list())
    lookups = {col: sample_group_lookup(df, col, sample_col=sample_col) for col in eligible}
    for sid in sorted(id_set):
        attrs = {}
        for col in eligible:
            attrs[col] = lookups[col].get(sid, UNLABELED)
        if attrs:
            by_id[sid] = attrs

    return {"columns": columns_out, "by_id": by_id, "sample_col": sample_col}


def metadata_fingerprint(df: Optional[pl.DataFrame]) -> str:
    """Stable hash of the metadata table for region-cache invalidation."""
    import hashlib
    import json

    if df is None or not isinstance(df, pl.DataFrame) or len(df) == 0:
        return "none"
    # Compact: column names + sorted sample ids + a row count + value hash of
    # the first few eligible columns.
    payload = {
        "cols": list(df.columns),
        "n": len(df),
        "rows": df.head(500).to_dicts(),
    }
    raw = json.dumps(payload, sort_keys=True, default=str)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def tally_allele_counts_by_group(
    sample_alleles: Dict[str, set],
    allele_keys: Sequence[str],
    group_lookups: Dict[str, Dict[str, str]],
) -> Dict[str, Dict[str, Dict[str, int]]]:
    """Build alleleSampleCountsByGroup from per-sample allele-key sets.

    ``sample_alleles`` maps sample_id -> set of allele keys (., ref, a1, ...).
    ``group_lookups`` maps column -> {sample_id -> group_label}.
    """
    out: Dict[str, Dict[str, Dict[str, int]]] = {}
    for col, lookup in group_lookups.items():
        by_group: Dict[str, Dict[str, int]] = {}
        for sample_name, keys in sample_alleles.items():
            group = lookup.get(str(sample_name), UNLABELED)
            bucket = by_group.get(group)
            if bucket is None:
                bucket = {k: 0 for k in allele_keys}
                by_group[group] = bucket
            for k in keys:
                if k in bucket:
                    bucket[k] += 1
                else:
                    # Allele key not in the fixed list — still count it.
                    bucket[k] = bucket.get(k, 0) + 1
        out[col] = by_group
    return out


def pivot_aggregate_group_counts(
    rows: List[dict],
    allele_sample_counts: Dict[str, int],
    alt_alleles: Sequence[str],
) -> Dict[str, Dict[str, Dict[str, int]]]:
    """Pivot Rust ``group_counts`` JSON rows into alleleSampleCountsByGroup.

    Each aggregate row is one alt; ``group_counts`` is
    ``{column: {group: {ref, alt, missing}}}``. Shared ref/missing are taken
    from the first row; per-alt counts become a1..aN after alt sort order.
    """
    import json

    if not rows:
        return {}
    # Collect per-column / group / alt_index counts.
    # structure: col -> group -> {"ref": n, ".": n, alt_by_allele: {alt: n}}
    accum: Dict[str, Dict[str, dict]] = {}
    for r in rows:
        raw = r.get("group_counts")
        if not raw:
            continue
        if isinstance(raw, str):
            try:
                parsed = json.loads(raw)
            except (TypeError, ValueError, json.JSONDecodeError):
                continue
        elif isinstance(raw, dict):
            parsed = raw
        else:
            continue
        alt = r.get("alt_allele")
        for col, groups in parsed.items():
            if not isinstance(groups, dict):
                continue
            col_bucket = accum.setdefault(col, {})
            for group, counts in groups.items():
                if not isinstance(counts, dict):
                    continue
                g = col_bucket.setdefault(
                    group, {"ref": 0, ".": 0, "alts": {}}
                )
                # ref / missing are cohort-shared; take max across alt rows
                # (identical when Rust emits them per alt from the same scan).
                g["ref"] = max(g["ref"], int(counts.get("ref", 0) or 0))
                g["."] = max(g["."], int(counts.get("missing", 0) or 0))
                if alt is not None:
                    g["alts"][alt] = int(counts.get("alt", 0) or 0)

    out: Dict[str, Dict[str, Dict[str, int]]] = {}
    alt_key_by_allele = {a: f"a{i+1}" for i, a in enumerate(alt_alleles)}
    for col, groups in accum.items():
        by_group: Dict[str, Dict[str, int]] = {}
        for group, g in groups.items():
            bucket = {".": int(g["."]), "ref": int(g["ref"])}
            for i in range(len(alt_alleles)):
                bucket[f"a{i+1}"] = 0
            for alt, n in g["alts"].items():
                key = alt_key_by_allele.get(alt)
                if key is not None:
                    bucket[key] = n
            by_group[group] = bucket
        out[col] = by_group

    # Ensure every allele key from the cohort counts exists even if a group
    # never saw that allele (zeros already set above).
    _ = allele_sample_counts
    return out
