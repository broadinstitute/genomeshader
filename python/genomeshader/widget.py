# widget.py: anywidget host for the genomeshader viewer.
#
# The classic viewer injects raw HTML + a hand-rolled comm that only reaches the
# kernel in classic Jupyter Notebook (window.Jupyter.notebook.kernel). That
# breaks in JupyterLab and can't be fixed from injected output JS. Delivering the
# viewer as an ipywidget instead makes the data channel ride the ipywidgets comm
# — the same proxied kernel websocket the notebook already uses — so it works in
# classic Notebook, JupyterLab, Notebook 7, VS Code, Colab, and through the
# Terra / AoU proxy (browser and kernel on different hosts), all with one path.
#
# The viewer JS is reused verbatim; only the transport differs: widget-comms.js
# replaces jupyter-comms.js and routes sendCommMessage through the widget model
# (window.__GS_SEND, installed by render() below). Variant data is inlined in the
# config; reads are fetched on demand via widget custom messages.
import json
import re
from pathlib import Path

import anywidget
import traitlets


def _html_dir() -> Path:
    """Locate the packaged html/ directory (installed or in-tree)."""
    try:
        import importlib.resources as ir
        p = ir.files("genomeshader").joinpath("html", "template.html")
        if p.is_file():
            return Path(str(p)).parent
    except Exception:
        pass
    here = Path(__file__).parent / "html"
    if (here / "template.html").exists():
        return here
    return Path(__file__).parent.parent.parent / "html"


# Same order as view._load_template_html, but the model-backed transport
# (widget-comms.js) stands in for the classic-Notebook comm (jupyter-comms.js).
_SCRIPT_ORDER = [
    "cleanup.js", "webgpu-core.js", "webgpu-renderer.js", "webgpu-bezier.js",
    "widget-comms.js", "dom-utils.js", "ui-state.js", "view-state.js",
    "smart-tracks.js", "rendering.js", "tracks.js", "interaction.js", "main.js",
]


def _container_override_css(cid: str) -> str:
    """Container-scoped layout/stacking overrides, mirroring the classic inline
    path (view.py). These establish positioning, z-index and pointer-events so
    the flow/tracks canvases actually receive clicks — without them hover works
    (document-level) but selection clicks get swallowed by mis-stacked overlays.
    `cid` is the container element id.
    """
    c = "#" + cid
    return "\n".join([
        f"{c} {{ height:600px; display:block; position:relative; overflow:visible;"
        f" --sidebar-w:240px; --sidebar-right-w:240px; --tracks-h:280px; --flow-h:500px; --reads-h:220px; }}",
        # Flex row: sidebar-left | main | sidebar-right. As siblings they cannot
        # overlap — main flexes to fill whatever the panels leave, so expanding a
        # panel narrows the tracks instead of occluding them. Overrides the inline
        # position:absolute on each element.
        f"{c} .app {{ height:100% !important; width:100% !important; display:flex !important;"
        f" flex-direction:row !important; align-items:stretch !important;"
        f" position:relative !important; overflow:hidden !important; }}",
        # overflow MUST stay visible on both axes so the protruding expand tab
        # (.sidebar-left::after, at left:100%) isn't clipped. overflow-y:auto
        # here would force overflow-x to compute to auto (CSS spec) and eat the
        # tab — making it invisible AND unclickable. So scroll on the inner
        # .sidebarContent instead (flex column), mirroring the right sidebar.
        f"{c} .sidebar-left {{ position:relative !important; left:auto !important; top:auto !important;"
        f" bottom:auto !important; height:auto !important; align-self:stretch !important;"
        f" flex:0 0 240px !important; z-index:100 !important; background:var(--panel) !important;"
        f" display:flex !important; flex-direction:column !important;"
        f" overflow:visible !important; pointer-events:auto !important; }}",
        f"{c} .sidebar-left .sidebarContent {{ flex:1 1 auto !important; min-height:0 !important;"
        f" overflow-y:auto !important; overflow-x:visible !important; }}",
        f"{c} .app.sidebar-collapsed .sidebar-left {{ flex-basis:20px !important; padding:0 !important; }}",
        f"{c} .main {{ position:relative !important; left:auto !important; right:auto !important;"
        f" top:auto !important; bottom:auto !important; height:auto !important; align-self:stretch !important;"
        f" flex:1 1 auto !important; min-width:0 !important; z-index:1 !important; overflow:hidden !important; }}",
        f"{c} .sidebar-right {{ position:relative !important; right:auto !important; top:auto !important;"
        f" bottom:auto !important; height:auto !important; align-self:stretch !important;"
        f" flex:0 0 var(--sidebar-right-w,240px) !important; z-index:100 !important; pointer-events:auto !important;"
        f" background:var(--panel) !important;"
        f" overflow-x:visible !important; display:flex !important; flex-direction:column !important; }}",
        f"{c} .app:not(.sidebar-right-collapsed) .sidebar-right {{ flex-basis:var(--sidebar-right-w,240px) !important; }}",
        f"{c} .app.sidebar-right-collapsed .sidebar-right {{ flex-basis:20px !important; padding:0 !important; }}",
        # Bound the content area (was height:100%) so the sticky-less .sidebar-close-btn
        # footer gets its own row below it instead of overlapping the scroll.
        f"{c} .sidebar-right-content {{ flex:1 1 auto !important; min-height:0 !important; height:auto !important; }}",
        f"{c} .sidebar-right .sidebarContent {{ flex:1 !important; min-height:0 !important; overflow-y:auto !important;"
        f" overflow-x:visible !important; padding:12px !important; pointer-events:auto !important; }}",
        f"{c} .sidebar-left > * {{ pointer-events:auto !important; opacity:1 !important; }}",
        f"{c} .sidebar-left select, {c} .sidebar-left input, {c} .sidebar-left button,"
        f" {c} .sidebar-left label {{ pointer-events:auto !important; position:relative !important;"
        f" z-index:200 !important; }}",
        f"{c} #sampleStrategySection, {c} #sampleStrategySection *, {c} #sampleSearchSection,"
        f" {c} #sampleSearchSection *, {c} #sampleContext, {c} #sampleContext * {{ pointer-events:auto !important; }}",
        # Stacking so the sample-search dropdown floats ABOVE the Selection /
        # Strategy section (otherwise it's trapped at the section's z-index and
        # the Selection UI paints over it). Mirrors view.py's inline path.
        f"{c} #sampleSearchSection {{ position:relative !important; z-index:5000 !important; overflow:visible !important; }}",
        f"{c} #sampleStrategySection {{ position:relative !important; z-index:200 !important; }}",
        f"{c} #sampleSearchResults {{ z-index:5001 !important; background:var(--panel,#14181f) !important; }}",
        f"{c} .tracks {{ position:absolute !important; left:0 !important; right:0 !important;"
        f" top:0 !important; height:var(--tracks-h,280px) !important; width:100% !important; }}",
        f"{c} #tracksContainer {{ position:relative !important; width:100% !important; height:100% !important; }}",
        # SVG text/vector layer (reference letters, gene shapes) must sit ABOVE
        # the WebGPU raster layer (solid base-color blocks); otherwise the solid
        # blocks hide the letters. pointer-events:none so it never blocks canvas
        # hover — interactive hover regions set pointer-events:auto themselves.
        f"{c} #tracksSvg {{ position:absolute !important; inset:0 !important; width:100% !important;"
        f" height:100% !important; display:block !important; z-index:3 !important; pointer-events:none !important; }}",
        f"{c} #tracksWebGPU {{ position:absolute !important; inset:0 !important; width:100% !important;"
        f" height:100% !important; display:block !important; pointer-events:auto !important; z-index:1 !important; }}",
        f"{c} #flowWebGPU {{ pointer-events:auto !important; }}",
        f"{c} .flow-track-overlay, {c} #flowOverlay {{ pointer-events:auto !important; }}",
        f"{c} .menu {{ z-index:2147483647 !important; }}",
    ])


# Placeholder container id, substituted with the real one at render() time.
_CID_PLACEHOLDER = "__GSROOT__"


def _build_esm() -> str:
    base = _html_dir()
    scripts_dir = base / "scripts"

    css = (base / "styles.css").read_text(encoding="utf-8")
    # Drop the global `html, body { ... }` rule so it can't restyle the notebook
    # page; the widget container sets its own height.
    css = re.sub(r"(?m)^\s*html\s*,\s*body\s*\{[^}]*\}\s*$", "", css)
    # Container-scoped overrides (placeholder id swapped for the real one in JS).
    override_css = _container_override_css(_CID_PLACEHOLDER)
    body = (base / "body.html").read_text(encoding="utf-8")

    scripts = "\n".join(
        (scripts_dir / name).read_text(encoding="utf-8")
        for name in _SCRIPT_ORDER
        if (scripts_dir / name).exists()
    )

    return (
        "export default {\n"
        "  render({ model, el }) {\n"
        "    window.GENOMESHADER_CONFIG = model.get('config') || {};\n"
        "    window.GENOMESHADER_VIEW_ID = model.get('view_id') || 'gswidget';\n"
        "    window.GENOMESHADER_JUPYTER_ORIGIN = '';\n"
        "    const __pending = new Map();\n"
        "    model.on('msg:custom', function (msg) {\n"
        "      if (msg && msg.request_id && __pending.has(msg.request_id)) {\n"
        "        const resolve = __pending.get(msg.request_id);\n"
        "        __pending.delete(msg.request_id); resolve(msg);\n"
        "      }\n"
        "      try { document.dispatchEvent(new CustomEvent('genomeshader_msg', { detail: msg })); } catch (e) {}\n"
        "    });\n"
        "    window.__GS_SEND = function (type, data, timeoutMs) {\n"
        "      return new Promise(function (resolve, reject) {\n"
        "        const id = 'req_' + Math.random().toString(36).slice(2) + Date.now();\n"
        "        __pending.set(id, resolve);\n"
        "        model.send(Object.assign({ type: type, request_id: id }, data || {}));\n"
        "        setTimeout(function () {\n"
        "          if (__pending.has(id)) { __pending.delete(id); reject(new Error('Request timeout')); }\n"
        "        }, timeoutMs || (type === 'fetch_reads' ? 120000 : 30000));\n"
        "      });\n"
        "    };\n"
        "    const viewId = window.GENOMESHADER_VIEW_ID;\n"
        "    const cid = 'genomeshader-root-' + viewId;\n"
        "    const style = document.createElement('style');\n"
        "    style.textContent = " + json.dumps(css) + ";\n"
        "    el.appendChild(style);\n"
        "    const ostyle = document.createElement('style');\n"
        "    ostyle.textContent = " + json.dumps(override_css) +
        ".split(" + json.dumps(_CID_PLACEHOLDER) + ").join(cid);\n"
        "    el.appendChild(ostyle);\n"
        "    const container = document.createElement('div');\n"
        "    container.id = cid;\n"
        "    container.setAttribute('style', 'width:100%;height:600px;position:relative;overflow:visible;background:var(--bg,#0b0d10);isolation:isolate;');\n"
        "    container.innerHTML = " + json.dumps(body) + ";\n"
        "    el.appendChild(container);\n"
        "    __runViewer__().catch(function (e) { console.error('Genomeshader viewer error:', e); });\n"
        "  }\n"
        "};\n"
        "async function __runViewer__() {\n"
        + scripts +
        "\n}\n"
    )


# Built once at import — depends only on packaged assets, not instance state.
_ESM = _build_esm()


class GenomeShaderWidget(anywidget.AnyWidget):
    """Renders a genomeshader view and serves on-demand reads over the widget's
    ipywidgets comm. Created by GenomeShader.show()/show_widget()."""

    _esm = _ESM
    config = traitlets.Dict().tag(sync=True)
    view_id = traitlets.Unicode("").tag(sync=True)

    def __init__(self, shader, **kwargs):
        super().__init__(**kwargs)
        self._shader = shader
        self.on_msg(self._on_custom_msg)

    def _on_custom_msg(self, _widget, content, _buffers):
        if not isinstance(content, dict):
            return
        if content.get("type") != "fetch_reads":
            return
        request_id = content.get("request_id")
        try:
            payload = self._shader._fetch_reads_payload(
                sample_id=content.get("sample_id"),
                samples=content.get("samples"),
            )
            self.send({"type": "fetch_reads_response", "request_id": request_id, **payload})
        except Exception as e:  # surfaced to the frontend as a reads error
            self.send({"type": "fetch_reads_error", "request_id": request_id, "error": str(e)})
