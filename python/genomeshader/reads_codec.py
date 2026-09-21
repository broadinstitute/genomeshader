"""Binary encoding of columnar reads payloads for the widget comm.

A reads chunk is a dict of equal-length columns. Sent as JSON, a 128 kb window of
30x short reads is ~10 MB of text per sample: ``json.dumps`` in the kernel, then
``JSON.parse`` on the browser's main thread (in JupyterLab, before the viewer even
sees the message), then a second copy as JS arrays of boxed values. This module
sends the same columns as raw little-endian buffers on the widget's binary channel
instead (ipywidgets ``send(content, buffers=[...])``):

* ints -> ``i32`` (or ``f64`` when a value does not fit), floats -> ``f64``
* bools -> ``bool`` (one byte each; the viewer decodes real JS booleans)
* strings -> ``str``: ONE utf-8 blob, values joined by NUL (``\\0``)

The manifest ``{"v": 1, "n": rows, "cols": [{"name", "kind", "buf", "len"}]}`` says
which buffer holds which column. Encoding is all-or-nothing per chunk: any column
it cannot represent exactly (mixed types, nulls in an int/bool column, embedded NUL, ints beyond 2**53) makes
``encode_reads`` return ``None`` and the caller sends that chunk as JSON, so the
binary path can never change what the viewer sees.

The matching decoder is ``gsDecodeReadsBinary`` in html/scripts/reads-cache.js;
``decode_reads`` here is the reference implementation used by the tests.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

VERSION = 1
_NUL = "\0"
_I32_MIN, _I32_MAX = -(2 ** 31), 2 ** 31 - 1
_F64_EXACT_INT = 2 ** 53


def _np():
    try:
        import numpy as np  # noqa: WPS433 (lazy: numpy is optional)
        return np
    except Exception:  # pragma: no cover - numpy missing: caller falls back to JSON
        return None


def _encode_column(vals: list):
    """(kind, bytes) for one column, or (None, None) if it cannot be represented exactly."""
    np = _np()
    if np is None:
        return None, None
    first = next((v for v in vals if v is not None), None)
    if first is None:                                   # all null: an empty-string column
        return "str", ("\0".join("" for _ in vals)).encode("utf-8")
    if isinstance(first, str):
        if not all(v is None or isinstance(v, str) for v in vals):
            return None, None
        blob = _NUL.join("" if v is None else v for v in vals)
        if blob.count(_NUL) != len(vals) - 1:           # a value contained NUL
            return None, None
        return "str", blob.encode("utf-8")
    # bool / int columns must be null-free: null -> 0 would change what the viewer sees.
    if isinstance(first, bool):
        if not all(isinstance(v, bool) for v in vals):
            return None, None
        return "bool", np.asarray(vals, dtype=np.uint8).tobytes()
    if isinstance(first, int):
        if not all(isinstance(v, int) and not isinstance(v, bool) for v in vals):
            return None, None
        ints = vals
        lo, hi = min(ints), max(ints)
        if _I32_MIN <= lo and hi <= _I32_MAX:
            return "i32", np.asarray(ints, dtype="<i4").tobytes()
        if -_F64_EXACT_INT <= lo and hi <= _F64_EXACT_INT:
            return "f64", np.asarray(ints, dtype="<f8").tobytes()
        return None, None
    if isinstance(first, float):
        if not all(v is None or isinstance(v, (float, int)) and not isinstance(v, bool) for v in vals):
            return None, None
        return "f64", np.asarray([float("nan") if v is None else float(v) for v in vals], dtype="<f8").tobytes()
    return None, None


def encode_reads(reads: Dict[str, list], buffers: List[bytes]) -> Optional[dict]:
    """Append ``reads``' columns to ``buffers``; return the manifest, or None to fall back."""
    if not reads:
        return None
    cols = list(reads.items())
    n = len(cols[0][1])
    if n == 0 or any(len(v) != n for _k, v in cols):
        return None
    staged = []
    for name, vals in cols:
        kind, data = _encode_column(vals)
        if kind is None:
            return None
        staged.append((name, kind, data))
    manifest_cols = []
    for name, kind, data in staged:
        buffers.append(data)
        manifest_cols.append({"name": name, "kind": kind, "buf": len(buffers) - 1, "len": n})
    return {"v": VERSION, "n": n, "cols": manifest_cols}


def encode_batch_items(items: List[dict]):
    """Encode a ``fetch_reads_batch`` result list.

    Returns ``(items, buffers)``: each item whose ``reads`` encoded has them replaced
    by a ``reads_bin`` manifest (buffer indices are into the ONE shared list);
    everything else is passed through untouched (JSON).
    """
    buffers: List[bytes] = []
    out = []
    for it in items:
        reads = it.get("reads") if isinstance(it, dict) else None
        manifest = None
        if reads:
            mark = len(buffers)
            try:
                manifest = encode_reads(reads, buffers)
            except Exception:
                manifest = None
            if manifest is None:
                del buffers[mark:]                      # discard partial output
        if manifest is not None:
            it = {k: v for k, v in it.items() if k != "reads"}
            it["reads_bin"] = manifest
        out.append(it)
    return out, buffers


def decode_reads(manifest: dict, buffers: List[Any]) -> Dict[str, list]:
    """Reference decoder (mirrors gsDecodeReadsBinary in the viewer)."""
    import numpy as np
    out: Dict[str, list] = {}
    n = manifest["n"]
    for c in manifest["cols"]:
        raw = bytes(buffers[c["buf"]])
        kind = c["kind"]
        if kind == "i32":
            out[c["name"]] = np.frombuffer(raw, dtype="<i4").tolist()
        elif kind == "f64":
            out[c["name"]] = np.frombuffer(raw, dtype="<f8").tolist()
        elif kind == "bool":
            out[c["name"]] = [bool(x) for x in np.frombuffer(raw, dtype=np.uint8)]
        elif kind == "str":
            out[c["name"]] = raw.decode("utf-8").split(_NUL)
        else:
            raise ValueError(f"unknown column kind {kind!r}")
        if len(out[c["name"]]) != n:
            raise ValueError(f"column {c['name']!r}: expected {n} values, got {len(out[c['name']])}")
    return out
