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


def _build_esm() -> str:
    base = _html_dir()
    scripts_dir = base / "scripts"

    css = (base / "styles.css").read_text(encoding="utf-8")
    # Drop the global `html, body { ... }` rule so it can't restyle the notebook
    # page; the widget container sets its own height.
    css = re.sub(r"(?m)^\s*html\s*,\s*body\s*\{[^}]*\}\s*$", "", css)
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
        "    const style = document.createElement('style');\n"
        "    style.textContent = " + json.dumps(css) + ";\n"
        "    el.appendChild(style);\n"
        "    const container = document.createElement('div');\n"
        "    container.id = 'genomeshader-root-' + viewId;\n"
        "    container.setAttribute('style', 'width:100%;height:600px;position:relative;overflow:visible;');\n"
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
