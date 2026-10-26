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
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import anywidget
import traitlets

from .dispatch import OFFLOADED_TYPES, dispatch

# Default show() height: 80% of the browser viewport (resolved in the widget JS).
VIEWPORT_HEIGHT_FRAC = 0.8


# Shared pool for software-defined track fetches (closures may be slow user
# code). Sized small so we don't thrash the GIL / UCSC network; the handler
# returns immediately so other comm traffic isn't blocked.
_TRACK_DATA_EXECUTOR = ThreadPoolExecutor(max_workers=2, thread_name_prefix="gs-track-data")


def _send_on_ioloop(widget, msg):
    """Hop a widget.send onto the kernel ioloop (thread-safe from worker threads)."""
    try:
        from tornado.ioloop import IOLoop
        loop = IOLoop.current(instance=False)
        if loop is not None:
            loop.add_callback(widget.send, msg)
            return
    except Exception:
        pass
    # No tornado ioloop (unit tests / plain Python): send directly.
    widget.send(msg)

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
    "widget-comms.js", "dom-utils.js", "ui-state.js", "tiles.js", "tile-ui.js", "view-state.js",
    "allele-reorder.js",
    "read-display.js", "track-groups.js", "reads-cache.js", "smart-tracks.js", "rendering.js", "tracks.js", "interaction.js", "main.js",
    "ucsc-tracks.js", "comments.js",
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
        f"{c} {{ height:var(--gs-widget-h, 80vh); display:block; position:relative; overflow:visible;"
        f" --sidebar-w:360px; --sidebar-right-w:240px; --tracks-h:220px; --flow-h:500px; --reads-h:220px; }}",
        # Flex row: sidebar-left | main | sidebar-right. As siblings they cannot
        # overlap — main flexes to fill whatever the panels leave, so expanding a
        # panel narrows the tracks instead of occluding them. Overrides the inline
        # position:absolute on each element.
        # padding-top reserves the always-visible top locus bar's height: the flex
        # row (sidebars + main) lays out in the content box below the padding, while
        # the absolute #locusBar (top:0) fills the padding strip -> no overlap. The
        # inline top:36px on the panels is overridden to top:auto by the flex rules
        # below, so the offset must live here.
        f"{c} .app {{ height:100% !important; width:100% !important; display:flex !important;"
        f" flex-direction:row !important; align-items:stretch !important;"
        f" position:relative !important; overflow:hidden !important;"
        f" padding-top:36px !important; box-sizing:border-box !important; }}",
        # overflow MUST stay visible on both axes so the protruding expand tab
        # (.sidebar-left::after, at left:100%) isn't clipped. overflow-y:auto
        # here would force overflow-x to compute to auto (CSS spec) and eat the
        # tab — making it invisible AND unclickable. So scroll on the inner
        # .sidebarContent instead (flex column), mirroring the right sidebar.
        f"{c} .sidebar-left {{ position:relative !important; left:auto !important; top:auto !important;"
        f" bottom:auto !important; height:auto !important; align-self:stretch !important;"
        f" flex:0 0 var(--sidebar-w,360px) !important; z-index:100 !important; background:var(--panel) !important;"
        f" display:flex !important; flex-direction:column !important;"
        f" overflow:visible !important; pointer-events:auto !important; }}",
        f"{c} .sidebar-left .sidebarContent {{ flex:1 1 auto !important; min-height:0 !important;"
        f" overflow-y:auto !important; overflow-x:hidden !important; }}",
        # Collapsed left = the 48px icon rail (command strip stays visible so its
        # icons can reopen the panel to a tab); the tab content is hidden.
        f"{c} .app.sidebar-collapsed .sidebar-left {{ flex-basis:48px !important; padding:0 !important; }}",
        f"{c} .main {{ position:relative !important; left:auto !important; right:auto !important;"
        f" top:auto !important; bottom:auto !important; height:auto !important; align-self:stretch !important;"
        f" flex:1 1 auto !important; min-width:0 !important; z-index:1 !important; overflow:hidden !important; }}",
        f"{c} .sidebar-right {{ position:relative !important; right:auto !important; top:auto !important;"
        f" bottom:auto !important; height:auto !important; align-self:stretch !important;"
        f" flex:0 0 var(--sidebar-right-w,240px) !important; z-index:100 !important; pointer-events:auto !important;"
        f" background:var(--panel) !important;"
        # overflow MUST be visible on both axes so the protruding collapse tab
        # (.sidebar-right::before) isn't clipped — overflow-y:hidden here would
        # force overflow-x to auto and eat the tab. Content scrolls on the inner
        # .sidebarContent instead.
        f" overflow:visible !important; display:flex !important; flex-direction:column !important; }}",
        f"{c} .app:not(.sidebar-right-collapsed) .sidebar-right {{ flex-basis:var(--sidebar-right-w,240px) !important; }}",
        # Collapsed right = the 48px icon rail (command strip stays visible,
        # tab content hidden), mirroring the left panel.
        f"{c} .app.sidebar-right-collapsed .sidebar-right {{ flex-basis:48px !important; padding:0 !important; }}",
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
        f"{c} .gs-tile-strip {{ position:absolute !important; inset:0 !important; right:48px !important; display:flex !important;"
        f" flex-direction:row !important; overflow-x:auto !important; }}",
        f"{c} .gs-tile {{ position:relative !important; height:100% !important; min-width:280px !important; }}",
        f"{c} .gs-tile-body {{ position:relative !important; flex:1 !important; min-height:0 !important; }}",
        f"{c} .gs-add-tile-btn {{ position:absolute !important;"
        f" right:calc(48px + 6px) !important; top:calc(36px + (100% - 36px) / 2) !important;"
        f" transform:translateY(-50%) !important; z-index:150 !important; pointer-events:auto !important;"
        f" display:inline-flex !important; align-items:center !important; justify-content:center !important;"
        f" width:36px !important; height:36px !important; padding:0 0 3px 0 !important; margin:0 !important;"
        f" box-sizing:border-box !important; line-height:1 !important; font-size:20px !important; }}",
        f"{c} .app:not(.sidebar-right-collapsed) .gs-add-tile-btn {{"
        f" right:calc(var(--sidebar-right-w,240px) + 6px) !important; }}",
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


def _viewer_assets():
    """(css, body, scripts) shared by the widget ESM and the standalone page."""
    base = _html_dir()
    scripts_dir = base / "scripts"
    css = (base / "styles.css").read_text(encoding="utf-8")
    # Drop the global `html, body { ... }` rule so it can't restyle the host
    # page; the container sets its own height.
    css = re.sub(r"(?m)^\s*html\s*,\s*body\s*\{[^}]*\}\s*$", "", css)
    body = (base / "body.html").read_text(encoding="utf-8")
    scripts = "\n".join(
        (scripts_dir / name).read_text(encoding="utf-8")
        for name in _SCRIPT_ORDER
        if (scripts_dir / name).exists()
    )
    return css, body, scripts


def _script_json(obj) -> str:
    """JSON safe to inline in a <script> element (no `</script>` breakout)."""
    return json.dumps(obj).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")


def _figure_css(cid: str) -> str:
    """Static-figure presentation: tracks only, no navigation or panel chrome."""
    c = "#" + cid
    return (
        f"{c} #locusBar, {c} .sidebar-left, {c} .sidebar-right, {c} .gs-add-tile-btn, {c} #statusBar"
        " { display:none !important; }"
        f" {c} .app {{ padding-top:0 !important; }}"
        f" {c} .gs-tile-strip {{ right:0 !important; }}"
        # Chrome's PDF print flattens a label pill that overlaps a WebGPU canvas
        # into a bitmap with its soft shadow, which PDF viewers (Preview) draw
        # as a translucent gray box. Figures don't need the hover shadow.
        f" {c} .track-controls {{ box-shadow:none !important; transition:none !important; }}"
    )


def build_standalone_page(config: dict, view_id: str, token: str,
                          width: int = None, height: int = None, figure: bool = False) -> str:
    """A full HTML document running the viewer outside Jupyter.

    `__GS_SEND` posts each request to the session's local HTTP API (`../api`,
    relative so it also resolves behind jupyter-server-proxy), authenticated by
    `token`. width/height fix the viewer size in CSS pixels; None fills the
    window. Sets `window.__GS_READY` once the viewer has mounted, or
    `window.__GS_ERR` if it failed to.
    """
    css, body, scripts = _viewer_assets()
    cid = "genomeshader-root-" + re.sub(r"[^A-Za-z0-9_-]", "_", view_id or "gsview")
    override_css = _container_override_css(cid) + ("\n" + _figure_css(cid) if figure else "")
    w_css = f"{int(width)}px" if width else "100vw"
    h_css = f"{int(height)}px" if height else "100vh"
    send_js = (
        "(function () {\n"
        "  const TOKEN = " + _script_json(token) + ";\n"
        "  const API = new URL('../api', window.location.href).href;\n"
        "  const LONG = new Set(['fetch_reads', 'fetch_reads_batch', 'fetch_track_data']);\n"
        "  window.__GS_SEND = function (type, data, timeoutMs) {\n"
        "    const id = 'req_' + Math.random().toString(36).slice(2) + Date.now();\n"
        "    const ctl = new AbortController();\n"
        "    const timer = setTimeout(function () { ctl.abort(); }, timeoutMs || (LONG.has(type) ? 120000 : 30000));\n"
        "    return fetch(API, {\n"
        "      method: 'POST',\n"
        "      headers: { 'Content-Type': 'application/json', 'X-GS-Token': TOKEN },\n"
        "      body: JSON.stringify(Object.assign({ type: type, request_id: id }, data || {})),\n"
        "      signal: ctl.signal,\n"
        "    }).then(function (r) {\n"
        "      if (r.status === 204) return { type: type + '_ack', request_id: id };\n"
        "      if (!r.ok) throw new Error('Genomeshader API ' + r.status + ' for ' + type);\n"
        "      return r.json();\n"
        "    }).then(function (msg) {\n"
        "      try { document.dispatchEvent(new CustomEvent('genomeshader_msg', { detail: msg })); } catch (e) {}\n"
        "      return msg;\n"
        "    }, function (e) {\n"
        "      throw (e && e.name === 'AbortError') ? new Error('Request timeout') : e;\n"
        "    }).finally(function () { clearTimeout(timer); });\n"
        "  };\n"
        "})();\n"
    )
    return (
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        "<title>GenomeShader</title>"
        # The stylesheet's own html/body rule (font, colour) is stripped for the
        # notebook host, which supplies a sans-serif; restore it here or text
        # falls back to the browser default serif.
        "<style>html,body{margin:0;padding:0;background:var(--bg,#0b0d10);overflow:hidden;"
        "color:var(--text);font-family:ui-sans-serif,system-ui;}</style>"
        f"<style>{css}</style><style>{override_css}</style></head><body>"
        f'<div id="{cid}" style="width:{w_css};height:{h_css};--gs-widget-h:{h_css};'
        'position:relative;overflow:visible;background:var(--bg,#0b0d10);isolation:isolate;">'
        f"{body}</div><script>\n"
        f"window.GENOMESHADER_CONFIG = {_script_json(config)};\n"
        f"window.GENOMESHADER_VIEW_ID = {_script_json(view_id)};\n"
        "window.GENOMESHADER_JUPYTER_ORIGIN = '';\n"
        "window.__GS_READY = false; window.__GS_ERR = null;\n"
        + send_js +
        "async function __runViewer__(rootEl) {\n" + scripts + "\n}\n"
        f"__runViewer__(document.getElementById({_script_json(cid)}))"
        ".then(function () { window.__GS_READY = true; })"
        ".catch(function (e) { window.__GS_ERR = String(e && e.stack || e);"
        " console.error('Genomeshader viewer error:', e); });\n"
        "</script></body></html>"
    )


def _build_esm() -> str:
    css, body, scripts = _viewer_assets()
    # Container-scoped overrides (placeholder id swapped for the real one in JS).
    override_css = _container_override_css(_CID_PLACEHOLDER)

    return (
        "export default {\n"
        "  render({ model, el }) {\n"
        "    window.GENOMESHADER_CONFIG = model.get('config') || {};\n"
        "    window.GENOMESHADER_VIEW_ID = model.get('view_id') || 'gswidget';\n"
        "    window.GENOMESHADER_JUPYTER_ORIGIN = '';\n"
        "    const __pending = new Map();\n"
        "    window.__GS_TRANSPORT_BINARY = true;\n"
        "    model.on('msg:custom', function (msg, buffers) {\n"
        "      if (msg && buffers && buffers.length) msg._buffers = buffers;\n"
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
        "        }, timeoutMs || (type === 'fetch_reads' || type === 'fetch_reads_batch' || type === 'fetch_track_data' ? 120000 : 30000));\n"
        "      });\n"
        "    };\n"
        "    const viewId = window.GENOMESHADER_VIEW_ID;\n"
        "    const cid = 'genomeshader-root-' + viewId;\n"
        "    const container = document.createElement('div');\n"
        "    container.id = cid;\n"
        "    container.setAttribute('style', 'width:100%;position:relative;overflow:visible;background:var(--bg,#0b0d10);isolation:isolate;');\n"
        "    function gsHeightIsAuto(raw) {\n"
        "      const n = Number(raw);\n"
        "      return raw == null || raw === '' || !Number.isFinite(n) || n <= 0;\n"
        "    }\n"
        "    function gsResolveHeightPx(raw) {\n"
        "      if (gsHeightIsAuto(raw)) {\n"
        "        return Math.max(1, Math.round((window.innerHeight || 600) * " + str(VIEWPORT_HEIGHT_FRAC) + "));\n"
        "      }\n"
        "      return Math.max(1, Math.round(Number(raw)));\n"
        "    }\n"
        "    function gsApplyHeight() {\n"
        "      const px = gsResolveHeightPx(model.get('height'));\n"
        "      container.style.height = px + 'px';\n"
        "      container.style.setProperty('--gs-widget-h', px + 'px');\n"
        "    }\n"
        "    gsApplyHeight();\n"
        "    container.innerHTML = " + json.dumps(body) + ";\n"
        # Keep the stylesheet inside #genomeshader-root so it travels with the
        # viewer when fullscreen moves that node into the overlay. Sibling
        # <style> tags on `el` would stay in the notebook cell and stop
        # matching once the container left.
        "    const style = document.createElement('style');\n"
        "    style.textContent = " + json.dumps(css) + ";\n"
        "    container.appendChild(style);\n"
        "    const ostyle = document.createElement('style');\n"
        "    ostyle.textContent = " + json.dumps(override_css) +
        ".split(" + json.dumps(_CID_PLACEHOLDER) + ").join(cid);\n"
        "    container.appendChild(ostyle);\n"
        "    el.appendChild(container);\n"
        "    model.on('change:height', function () {\n"
        "      gsApplyHeight();\n"
        "      try { window.dispatchEvent(new Event('resize')); } catch (e) {}\n"
        "    });\n"
        "    window.addEventListener('resize', function () {\n"
        "      if (gsHeightIsAuto(model.get('height'))) gsApplyHeight();\n"
        "    });\n"
        "    __runViewer__(container).catch(function (e) { console.error('Genomeshader viewer error:', e); });\n"
        "  }\n"
        "};\n"
        # rootEl is this instance's container. Scripts scope all DOM lookups to it
        # (dom-utils `root`) so a 2nd widget in the same notebook doesn't bind to
        # the 1st widget's container and render blank.
        "async function __runViewer__(rootEl) {\n"
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
    height = traitlets.Int(default_value=None, allow_none=True).tag(sync=True)

    def __init__(self, shader, **kwargs):
        super().__init__(**kwargs)
        self._shader = shader
        self.on_msg(self._on_custom_msg)

    def _on_custom_msg(self, _widget, content, _buffers):
        if not isinstance(content, dict):
            return
        if content.get("type") in OFFLOADED_TYPES:
            shader = self._shader

            def _work():
                resp, _ = dispatch(shader, content)
                if resp is not None:
                    _send_on_ioloop(self, resp)

            _TRACK_DATA_EXECUTOR.submit(_work)
            return
        resp, buffers = dispatch(self._shader, content)
        if resp is None:
            return
        if buffers:
            self.send(resp, buffers)
        else:
            self.send(resp)
