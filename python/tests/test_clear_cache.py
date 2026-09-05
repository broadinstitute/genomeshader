"""clear_local_cache wipes the on-disk local cache dir + in-memory caches.

Pure filesystem logic — bind the method to a stub carrying `_local_cache_dir`
and a `clear_cache` spy, so no compiled extension / GCS session is needed.
"""
import tempfile
import types
from pathlib import Path

from genomeshader.view import GenomeShader


def _stub():
    o = types.SimpleNamespace()
    o._local_cache_dir = Path(tempfile.mkdtemp())
    o._cleared = False
    o.clear_cache = lambda: setattr(o, "_cleared", True)
    o.clear_local_cache = types.MethodType(GenomeShader.clear_local_cache, o)
    return o


def test_removes_files_and_dirs_and_reports_stats():
    o = _stub()
    d = o._local_cache_dir
    (d / "gcs" / "bucket" / "x").mkdir(parents=True)
    (d / "gcs" / "bucket" / "x" / "a.json").write_text("x" * 1000)
    (d / "reads").mkdir()
    (d / "reads" / "r.json").write_text("y" * 500)
    (d / "top.json").write_text("z" * 10)

    stats = o.clear_local_cache()

    assert stats == {"files": 3, "bytes": 1510}
    assert o._cleared is True                       # in-memory caches also cleared
    assert d.exists() and list(d.iterdir()) == []   # dir kept, emptied


def test_empty_cache_is_a_noop():
    o = _stub()
    stats = o.clear_local_cache()
    assert stats == {"files": 0, "bytes": 0}
    assert o._cleared is True


def test_missing_cache_dir_does_not_raise():
    o = _stub()
    o._local_cache_dir = o._local_cache_dir / "does-not-exist"
    stats = o.clear_local_cache()
    assert stats == {"files": 0, "bytes": 0}
    assert o._cleared is True


def test_clear_cache_drops_downloaded_windows():
    # "Keep variants once downloaded until the cache is cleared" — clear_cache must
    # empty the host window cache AND the Rust per-locus df cache. Bind the real
    # clear_cache to a stub carrying just the fields it touches.
    o = types.SimpleNamespace()
    o._agg_region_cache = [{"window": 1}, {"window": 2}]
    o._template_html_cache = None
    o._template_html_signature = None
    for attr in ("_ideogram_cache", "_genes_cache", "_repeats_cache",
                 "_reference_cache", "_variant_payload_index",
                 "_variant_payload_index_loaded"):
        setattr(o, attr, {})
    rust_cleared = {"n": 0}
    o._session = types.SimpleNamespace(
        clear_variant_cache=lambda: rust_cleared.__setitem__("n", rust_cleared["n"] + 1))
    o.clear_cache = types.MethodType(GenomeShader.clear_cache, o)

    o.clear_cache()

    assert o._agg_region_cache == []          # downloaded windows dropped
    assert rust_cleared["n"] == 1             # Rust df cache cleared too
