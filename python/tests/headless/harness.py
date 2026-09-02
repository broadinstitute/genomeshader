"""Headless viewer test harness.

The genomeshader viewer is ~15k lines of browser JS that the Python/Rust tests
can't exercise. This harness renders the *real* frontend in headless Chromium
(via Playwright) so we can assert on layout, coordinates, and interaction
behavior — the class of regressions that unit tests miss.

Two ways to mount the viewer, matching the two things that actually break:

- ``build_page()`` — the concatenated viewer scripts wrapped in ``__runViewer__``
  exactly as the anywidget host runs them, served from a ``file://`` origin (so
  ``localStorage`` works and orientation can be set). Renders the built-in demo
  data when no config is supplied. Use for layout / coordinate / interaction
  tests.

- ``esm_module_source()`` — the real ``_build_esm()`` output (``export default
  {render}``). Import it as a strict ES module from an *opaque* blob origin to
  reproduce sandboxed notebook outputs (VS Code / Colab / Terra), where
  ``localStorage`` throws. Use to guard the sandbox-render path.

WebGPU does not paint under swiftshader in headless Chromium, so tests assert on
the SVG/DOM/interaction layers (which do render), not on WebGPU pixels.
"""
import json
import os
import sys

# Make `import genomeshader` resolve from the source tree (mirrors test_widget).
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

# Launch flag: force the software GL path so headless Chromium is deterministic.
CHROMIUM_ARGS = ["--use-gl=swiftshader"]


def _assets():
    from genomeshader.widget import _SCRIPT_ORDER, _html_dir

    base = _html_dir()
    scripts_dir = base / "scripts"
    css = (base / "styles.css").read_text(encoding="utf-8")
    body = (base / "body.html").read_text(encoding="utf-8")
    scripts = "\n".join(
        (scripts_dir / n).read_text(encoding="utf-8")
        for n in _SCRIPT_ORDER
        if (scripts_dir / n).exists()
    )
    return css, body, scripts


def build_page(config=None, instrument=False):
    """Standalone HTML that runs the viewer scripts like the anywidget host does.

    config: inlined as ``window.GENOMESHADER_CONFIG`` (empty -> demo data).
    instrument: if True, inject a ``window.__rc`` counter incremented on every
        ``renderAll()`` (for render-coalescing / perf regression checks).
    """
    css, body, scripts = _assets()
    if instrument:
        scripts = scripts.replace(
            "function renderAll() {\n",
            "function renderAll() {\n  try{window.__rc=(window.__rc||0)+1;}catch(e){}\n",
            1,
        )
    cfg = json.dumps(config or {})
    return (
        '<!doctype html><html lang="en" data-theme="light"><head><meta charset="utf-8">'
        f"<style>{css}</style></head><body>"
        '<div id="genomeshader-root-gswidget" style="width:1200px;height:900px;'
        'position:relative;overflow:visible;background:#fff;isolation:isolate;">'
        f"{body}</div><script>"
        f"window.GENOMESHADER_CONFIG={cfg};window.GENOMESHADER_VIEW_ID='gswidget';"
        "window.GENOMESHADER_JUPYTER_ORIGIN='';"
        "window.__GS_SEND=function(){return Promise.reject(new Error('no comm in harness'));};"
        "window.__GS_ERR=null;"
        "(async function __runViewer__(){\n" + scripts
        + "\ntry{window.__GS_STATE=(typeof state!=='undefined')?state:null;}catch(e){}\n"
        "})()"
        ".then(()=>{window.__GS_READY=true;})"
        ".catch(e=>{window.__GS_ERR=String(e&&e.stack||e);console.error(e);});"
        "</script></body></html>"
    )


def esm_module_source():
    """The real anywidget ESM (``export default {render}``) for the strict-module
    / sandboxed-origin test."""
    from genomeshader.widget import _build_esm

    return _build_esm()


def write_page(tmp_path, html, name="harness.html"):
    """Write HTML to a temp file and return its file:// URI (a real origin, so
    localStorage works)."""
    f = tmp_path / name
    f.write_text(html, encoding="utf-8")
    return f.as_uri()
