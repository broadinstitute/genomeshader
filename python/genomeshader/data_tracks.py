"""Software-defined annotation / signal tracks (Phase 1).

Users hand genomeshader a dict, pandas/polars DataFrame, or a region-fetch
closure via GenomeShader.attach_data(). This module owns the TrackSpec schema,
coercion to a canonical polars frame, overlap filtering, and max_points binning.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple, Union

import polars as pl

STYLES = frozenset({"line", "bar", "scatter", "interval"})
Y_SCALES = frozenset({"linear", "log"})
DOWNSAMPLES = frozenset({"mean", "min", "max"})

# Colorblind-friendly defaults; multi-series and successive tracks cycle these.
DEFAULT_PALETTE = (
    "#2b6fff",
    "#e67e22",
    "#27ae60",
    "#8e44ad",
    "#e74c3c",
    "#16a085",
)
# Pixel-identical to today's UCSC interval boxes in tracks.js.
UCSC_INTERVAL_COLOR = "#2b6fff"

DataLike = Union[dict, "pl.DataFrame", Any]  # Any covers pandas when present
RegionFetch = Callable[[str, int, int], DataLike]


@dataclass
class TrackSpec:
    """Named software-defined track registered by attach_data()."""

    track_name: str
    data: Union[pl.DataFrame, RegionFetch]
    style: str = "line"
    chrom_col: str = "chrom"
    start_col: str = "start"
    end_col: Optional[str] = None
    value_cols: List[str] = field(default_factory=lambda: ["value"])
    label_col: Optional[str] = None
    y_scale: str = "linear"
    y_min: Optional[float] = None
    y_max: Optional[float] = None
    colors: List[str] = field(default_factory=list)
    track_height: int = 80
    downsample: str = "mean"
    is_callable: bool = False

    @property
    def track_id(self) -> str:
        return f"data-{self.track_name}"


def _is_pandas(obj: Any) -> bool:
    try:
        import pandas as pd  # type: ignore
        return isinstance(obj, pd.DataFrame)
    except ImportError:
        return False


def coerce_to_dataframe(data: DataLike) -> pl.DataFrame:
    """Coerce dict / pandas / polars into a polars DataFrame."""
    if callable(data) and not isinstance(data, (dict, pl.DataFrame)):
        raise TypeError("callable data must not be coerced eagerly; store as-is")
    if isinstance(data, pl.DataFrame):
        return data
    if isinstance(data, dict):
        return pl.DataFrame(data)
    if _is_pandas(data):
        return pl.from_pandas(data)
    raise TypeError(
        f"attach_data data must be dict, pandas.DataFrame, polars.DataFrame, "
        f"or Callable[[str,int,int], ...]; got {type(data).__name__}"
    )


def normalize_value_cols(value_col: Optional[Union[str, Sequence[str]]]) -> List[str]:
    if value_col is None:
        return []
    if isinstance(value_col, str):
        return [value_col]
    cols = list(value_col)
    if not cols:
        return []
    return [str(c) for c in cols]


def validate_static_columns(
    df: pl.DataFrame,
    *,
    chrom_col: str,
    start_col: str,
    end_col: Optional[str],
    value_cols: List[str],
    label_col: Optional[str],
) -> None:
    missing = []
    for col in (chrom_col, start_col):
        if col not in df.columns:
            missing.append(col)
    if end_col and end_col not in df.columns:
        missing.append(end_col)
    for col in value_cols:
        if col not in df.columns:
            missing.append(col)
    if label_col and label_col not in df.columns:
        missing.append(label_col)
    if missing:
        raise ValueError(
            f"attach_data: missing required column(s) {missing}; "
            f"available: {list(df.columns)}"
        )


def canonicalize(
    df: pl.DataFrame,
    *,
    chrom_col: str,
    start_col: str,
    end_col: Optional[str],
    value_cols: List[str],
    label_col: Optional[str],
) -> pl.DataFrame:
    """Rename to chrom/start/end/value*/label and fill missing end = start+1."""
    validate_static_columns(
        df,
        chrom_col=chrom_col,
        start_col=start_col,
        end_col=end_col,
        value_cols=value_cols,
        label_col=label_col,
    )
    rename = {chrom_col: "chrom", start_col: "start"}
    if end_col:
        rename[end_col] = "end"
    if label_col:
        rename[label_col] = "label"
    # value columns keep their names when multiple; single "value" stays "value"
    # unless the source column is already named differently — then rename to value
    # only for the single-series case with a non-"value" name.
    keep_value_names = list(value_cols)
    if len(value_cols) == 1 and value_cols[0] != "value":
        rename[value_cols[0]] = "value"
        keep_value_names = ["value"]
    elif len(value_cols) > 1:
        keep_value_names = list(value_cols)

    out = df.rename({k: v for k, v in rename.items() if k in df.columns and k != v})
    if "end" not in out.columns:
        out = out.with_columns((pl.col("start").cast(pl.Int64) + 1).alias("end"))
    else:
        out = out.with_columns(pl.col("end").cast(pl.Int64))
    out = out.with_columns(
        pl.col("chrom").cast(pl.Utf8),
        pl.col("start").cast(pl.Int64),
    )
    select_cols = ["chrom", "start", "end"]
    for vc in keep_value_names:
        if vc in out.columns:
            out = out.with_columns(pl.col(vc).cast(pl.Float64, strict=False))
            select_cols.append(vc)
    if "label" in out.columns:
        out = out.with_columns(pl.col("label").cast(pl.Utf8))
        select_cols.append("label")
    return out.select(select_cols)


def _contig_aliases(contig: str) -> List[str]:
    c = str(contig)
    aliases = [c]
    if c.startswith("chr"):
        aliases.append(c[3:] or c)
    else:
        aliases.append("chr" + c)
    # de-dupe preserving order
    seen = set()
    out = []
    for a in aliases:
        if a not in seen:
            seen.add(a)
            out.append(a)
    return out


def filter_overlap(df: pl.DataFrame, contig: str, start: int, end: int) -> pl.DataFrame:
    """Rows overlapping [start, end] on contig (with light chr / no-chr alias)."""
    if df.is_empty():
        return df
    start_i, end_i = int(start), int(end)
    aliases = _contig_aliases(contig)
    return df.filter(
        pl.col("chrom").is_in(aliases)
        & (pl.col("end") >= start_i)
        & (pl.col("start") <= end_i)
    )


def _bin_numeric(
    df: pl.DataFrame,
    value_col: str,
    *,
    start: int,
    end: int,
    max_points: int,
    downsample: str,
) -> pl.DataFrame:
    n = df.height
    if n <= max_points or max_points <= 0:
        return df
    span = max(1, int(end) - int(start) + 1)
    # Assign each row to one of max_points bins by midpoint.
    mid = (pl.col("start") + pl.col("end")) / 2.0
    bin_idx = ((mid - float(start)) / float(span) * max_points).floor().clip(
        0, max_points - 1
    ).cast(pl.Int64)
    work = df.with_columns(bin_idx.alias("_bin"))
    if downsample == "min":
        agg_val = pl.col(value_col).min()
    elif downsample == "max":
        agg_val = pl.col(value_col).max()
    else:
        agg_val = pl.col(value_col).mean()
    aggs = [
        pl.col("start").min().alias("start"),
        pl.col("end").max().alias("end"),
        agg_val.alias(value_col),
        pl.col("chrom").first(),
    ]
    if "label" in work.columns:
        aggs.append(pl.col("label").first())
    return work.group_by("_bin").agg(aggs).drop("_bin").sort("start")


def _bin_intervals(
    df: pl.DataFrame,
    *,
    start: int,
    end: int,
    max_points: int,
) -> pl.DataFrame:
    """Cap interval rows: merge per bin (min start / max end), no numeric agg."""
    n = df.height
    if n <= max_points or max_points <= 0:
        return df
    span = max(1, int(end) - int(start) + 1)
    mid = (pl.col("start") + pl.col("end")) / 2.0
    bin_idx = ((mid - float(start)) / float(span) * max_points).floor().clip(
        0, max_points - 1
    ).cast(pl.Int64)
    work = df.with_columns(bin_idx.alias("_bin"))
    aggs = [
        pl.col("start").min().alias("start"),
        pl.col("end").max().alias("end"),
        pl.col("chrom").first(),
    ]
    if "label" in work.columns:
        aggs.append(pl.col("label").first())
    return work.group_by("_bin").agg(aggs).drop("_bin").sort("start")


def downsample_frame(
    df: pl.DataFrame,
    value_cols: List[str],
    *,
    start: int,
    end: int,
    max_points: int,
    downsample: str,
) -> pl.DataFrame:
    if df.is_empty() or df.height <= max_points:
        return df
    if not value_cols:
        return _bin_intervals(df, start=start, end=end, max_points=max_points)
    # Bin once using the first value column's strategy; keep other value cols
    # with the same agg.
    n = df.height
    if n <= max_points or max_points <= 0:
        return df
    span = max(1, int(end) - int(start) + 1)
    mid = (pl.col("start") + pl.col("end")) / 2.0
    bin_idx = ((mid - float(start)) / float(span) * max_points).floor().clip(
        0, max_points - 1
    ).cast(pl.Int64)
    work = df.with_columns(bin_idx.alias("_bin"))

    def _agg(col: str):
        if downsample == "min":
            return pl.col(col).min()
        if downsample == "max":
            return pl.col(col).max()
        return pl.col(col).mean()

    aggs = [
        pl.col("start").min().alias("start"),
        pl.col("end").max().alias("end"),
        pl.col("chrom").first(),
    ]
    for vc in value_cols:
        if vc in work.columns:
            aggs.append(_agg(vc).alias(vc))
    if "label" in work.columns:
        aggs.append(pl.col("label").first())
    return work.group_by("_bin").agg(aggs).drop("_bin").sort("start")


def features_for_series(df: pl.DataFrame, value_col: Optional[str]) -> List[dict]:
    """Serialize rows to [{start, end, value?, label?}, ...]."""
    if df.is_empty():
        return []
    cols = ["start", "end"]
    has_value = value_col is not None and value_col in df.columns
    if has_value:
        cols.append(value_col)
    has_label = "label" in df.columns
    if has_label:
        cols.append("label")
    rows = df.select(cols).iter_rows(named=True)
    out = []
    for r in rows:
        feat = {"start": int(r["start"]), "end": int(r["end"])}
        if has_value:
            v = r[value_col]
            feat["value"] = None if v is None else float(v)
        if has_label and r.get("label") is not None:
            feat["label"] = str(r["label"])
        out.append(feat)
    return out


def assign_colors(
    n_series: int,
    color: Optional[Union[str, Sequence[str]]],
    *,
    style: str,
    palette_offset: int = 0,
) -> List[str]:
    if isinstance(color, str):
        base = [color]
    elif color is not None:
        base = [str(c) for c in color]
    else:
        base = []
    out: List[str] = []
    for i in range(max(1, n_series)):
        if i < len(base):
            out.append(base[i])
        elif style == "interval" and not base:
            out.append(UCSC_INTERVAL_COLOR)
        else:
            out.append(DEFAULT_PALETTE[(palette_offset + i) % len(DEFAULT_PALETTE)])
    return out


def build_track_spec(
    track_name: str,
    data: Union[DataLike, RegionFetch],
    *,
    style: str = "line",
    chrom_col: str = "chrom",
    start_col: str = "start",
    end_col: Optional[str] = None,
    value_col: Optional[Union[str, Sequence[str]]] = "value",
    label_col: Optional[str] = None,
    y_scale: str = "linear",
    y_min: Optional[float] = None,
    y_max: Optional[float] = None,
    color: Optional[Union[str, Sequence[str]]] = None,
    track_height: Optional[int] = None,
    downsample: str = "mean",
    palette_offset: int = 0,
) -> TrackSpec:
    style = str(style).lower()
    if style not in STYLES:
        raise ValueError(f"style must be one of {sorted(STYLES)}; got {style!r}")
    y_scale = str(y_scale).lower()
    if y_scale not in Y_SCALES:
        raise ValueError(f"y_scale must be one of {sorted(Y_SCALES)}; got {y_scale!r}")
    downsample = str(downsample).lower()
    if downsample not in DOWNSAMPLES:
        raise ValueError(
            f"downsample must be one of {sorted(DOWNSAMPLES)}; got {downsample!r}"
        )
    if not track_name or not str(track_name).strip():
        raise ValueError("track_name must be a non-empty string")

    value_cols = normalize_value_cols(value_col)
    is_callable = callable(data) and not isinstance(data, (dict, pl.DataFrame)) and not _is_pandas(data)

    if is_callable:
        stored: Union[pl.DataFrame, RegionFetch] = data  # type: ignore[assignment]
    else:
        raw = coerce_to_dataframe(data)
        stored = canonicalize(
            raw,
            chrom_col=chrom_col,
            start_col=start_col,
            end_col=end_col,
            value_cols=value_cols,
            label_col=label_col,
        )
        # After canonicalize, single renamed value col is "value"
        if len(value_cols) == 1 and value_cols[0] != "value":
            value_cols = ["value"]

    n_series = max(1, len(value_cols)) if value_cols else 1
    colors = assign_colors(n_series, color, style=style, palette_offset=palette_offset)

    if track_height is None:
        track_height = 30 if style == "interval" else 80

    return TrackSpec(
        track_name=str(track_name),
        data=stored,
        style=style,
        chrom_col=chrom_col,
        start_col=start_col,
        end_col=end_col,
        value_cols=value_cols,
        label_col=label_col,
        y_scale=y_scale,
        y_min=y_min,
        y_max=y_max,
        colors=colors,
        track_height=int(track_height),
        downsample=downsample,
        is_callable=is_callable,
    )


def resolve_dataframe(spec: TrackSpec, contig: str, start: int, end: int) -> pl.DataFrame:
    """Materialize (callable) + canonicalize + overlap-filter for a window."""
    if spec.is_callable:
        raw = spec.data(contig, int(start), int(end))  # type: ignore[operator]
        if isinstance(raw, pl.DataFrame):
            df = raw
        elif isinstance(raw, dict) or _is_pandas(raw):
            df = coerce_to_dataframe(raw)
        else:
            raise TypeError(
                f"callable track {spec.track_name!r} returned {type(raw).__name__}; "
                "expected DataFrame-like"
            )
        # Callables may already use canonical names; try as-is first.
        chrom = spec.chrom_col if spec.chrom_col in df.columns else "chrom"
        start_c = spec.start_col if spec.start_col in df.columns else "start"
        end_c = (
            spec.end_col
            if spec.end_col and spec.end_col in df.columns
            else ("end" if "end" in df.columns else None)
        )
        vcols = []
        for c in spec.value_cols:
            if c in df.columns:
                vcols.append(c)
            elif c == "value" and "value" in df.columns:
                vcols.append("value")
        label_c = (
            spec.label_col
            if spec.label_col and spec.label_col in df.columns
            else ("label" if "label" in df.columns else None)
        )
        try:
            df = canonicalize(
                df,
                chrom_col=chrom,
                start_col=start_c,
                end_col=end_c,
                value_cols=vcols,
                label_col=label_c,
            )
        except ValueError:
            # Already canonical or partial — require at least chrom/start
            if "chrom" not in df.columns or "start" not in df.columns:
                raise
            if "end" not in df.columns:
                df = df.with_columns((pl.col("start").cast(pl.Int64) + 1).alias("end"))
    else:
        df = spec.data  # type: ignore[assignment]
        assert isinstance(df, pl.DataFrame)

    return filter_overlap(df, contig, start, end)


def build_payload(
    spec: TrackSpec,
    contig: str,
    start: int,
    end: int,
    *,
    max_points: int = 2000,
) -> dict:
    """Build the fetch_track_data response body for one track/window."""
    df = resolve_dataframe(spec, contig, start, end)
    value_cols = list(spec.value_cols)
    # After canonicalize of static data, single series is under "value"
    if value_cols and value_cols[0] not in df.columns and "value" in df.columns:
        value_cols = ["value"]

    df = downsample_frame(
        df,
        value_cols,
        start=start,
        end=end,
        max_points=max_points,
        downsample=spec.downsample,
    )

    series = []
    if not value_cols:
        # Pure interval / label track — one series, features without value
        series.append({
            "name": "intervals",
            "color": spec.colors[0] if spec.colors else UCSC_INTERVAL_COLOR,
            "features": features_for_series(df, None),
        })
    else:
        for i, vc in enumerate(value_cols):
            col = vc if vc in df.columns else ("value" if "value" in df.columns else vc)
            color = spec.colors[i] if i < len(spec.colors) else DEFAULT_PALETTE[i % len(DEFAULT_PALETTE)]
            series.append({
                "name": vc,
                "color": color,
                "features": features_for_series(df, col if col in df.columns else None),
            })

    return {
        "track_id": spec.track_id,
        "style": spec.style,
        "y_scale": spec.y_scale,
        "y_min": spec.y_min,
        "y_max": spec.y_max,
        "series": series,
    }


def track_metadata(spec: TrackSpec, *, include_series: Optional[List[dict]] = None) -> dict:
    """Config / live-push metadata for one data track."""
    meta = {
        "id": spec.track_id,
        "label": spec.track_name,
        "style": spec.style,
        "y_scale": spec.y_scale,
        "y_min": spec.y_min,
        "y_max": spec.y_max,
        "color": spec.colors[0] if len(spec.colors) == 1 else list(spec.colors),
        "height": spec.track_height,
        "minHeight": 18 if spec.style == "interval" else 40,
        "callable": spec.is_callable,
    }
    if include_series is not None:
        meta["series"] = include_series
    return meta


def wrap_genes_track(models: Optional[List[dict]]) -> dict:
    """Wrap genes() output in the shared track envelope (style: gene)."""
    features = list(models) if models else []
    return {
        "id": "genes",
        "label": "Genes",
        "style": "gene",
        "series": [{"name": "genes", "features": features}],
    }


def wrap_repeats_track(rows: Optional[List[dict]]) -> dict:
    """Wrap repeats() output in the shared track envelope (interval + cls)."""
    features = list(rows) if rows else []
    return {
        "id": "repeats",
        "label": "RepeatMasker",
        "style": "interval",
        "series": [{"name": "repeats", "features": features}],
    }


def annotation_features(track: Optional[dict]) -> List[dict]:
    """Extract the primary series features from a genes_track / repeats_track."""
    if not isinstance(track, dict):
        return []
    series = track.get("series") or []
    if not series:
        return []
    feats = series[0].get("features") if isinstance(series[0], dict) else None
    return list(feats) if feats else []


def wrap_genes_track(models: Optional[List[dict]]) -> dict:
    """Envelope for gene models from genes() — layout id stays ``genes``."""
    feats = list(models) if models else []
    return {
        "id": "genes",
        "label": "Genes",
        "style": "gene",
        "series": [{"name": "genes", "features": feats}],
    }


def wrap_repeats_track(rows: Optional[List[dict]]) -> dict:
    """Envelope for RepeatMasker rows from repeats() — layout id stays ``repeats``."""
    feats = list(rows) if rows else []
    return {
        "id": "repeats",
        "label": "RepeatMasker",
        "style": "interval",
        "series": [{"name": "repeats", "features": feats}],
    }


def annotation_features(track: Optional[dict]) -> List[dict]:
    """Flatten series[0].features from a genes_track / repeats_track envelope."""
    if not isinstance(track, dict):
        return []
    series = track.get("series") or []
    if not series:
        return []
    feats = series[0].get("features") if isinstance(series[0], dict) else None
    return list(feats) if feats else []
