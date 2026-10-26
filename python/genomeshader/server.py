# server.py: local HTTP host for the viewer, outside Jupyter.
#
#   GET  /view/<page_id>  -> a standalone viewer page (widget.build_standalone_page)
#   POST /api             -> dispatch.dispatch(); JSON in, JSON out
#
# Bound to 127.0.0.1. /api requires the per-server token (X-GS-Token), which is
# only handed out inside the served pages, and never answers CORS preflight —
# so another site open in the same browser can neither call it nor read it.
# Page ids are unguessable for the same reason: a page inlines its config.
import datetime
import hmac
import json
import math
import numbers
import secrets
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Dict, Optional

from .dispatch import HANDLERS, OFFLOADED_TYPES, dispatch

_MAX_BODY = 64 * 1024 * 1024


def _json_default(o):
    if isinstance(o, numbers.Integral):
        return int(o)
    if isinstance(o, numbers.Real):
        return float(o)
    if isinstance(o, (datetime.date, datetime.datetime)):
        return o.isoformat()
    if hasattr(o, "tolist"):
        return o.tolist()
    if isinstance(o, (set, frozenset)):
        return list(o)
    return str(o)


def _scrub_nonfinite(o):
    if isinstance(o, float) and not math.isfinite(o):
        return None
    if isinstance(o, dict):
        return {k: _scrub_nonfinite(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_scrub_nonfinite(v) for v in o]
    return o


def encode_json(obj) -> bytes:
    """Strict JSON for the browser: NaN/Infinity (invalid for JSON.parse) -> null."""
    try:
        return json.dumps(obj, default=_json_default, allow_nan=False).encode("utf-8")
    except ValueError:
        # Round-trip through Python types first so numpy floats get scrubbed too.
        plain = json.loads(json.dumps(obj, default=_json_default))
        return json.dumps(_scrub_nonfinite(plain), allow_nan=False).encode("utf-8")


class ViewerServer:
    """Serves viewer pages and answers their requests from one session."""

    def __init__(self, shader, host: str = "127.0.0.1", port: int = 0):
        self._shader = shader
        self.token = secrets.token_urlsafe(32)
        self._pages: Dict[str, bytes] = {}
        self._pages_lock = threading.Lock()
        # The session is not written for concurrent calls; the comm path runs
        # requests one at a time, so the HTTP path does too (except offloaded
        # user-code tracks, which the comm path also runs on a pool).
        self._dispatch_lock = threading.Lock()
        self._httpd = ThreadingHTTPServer((host, port), self._handler_class())
        self._httpd.daemon_threads = True
        self._thread: Optional[threading.Thread] = None

    @property
    def port(self) -> int:
        return self._httpd.server_address[1]

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def start(self) -> "ViewerServer":
        if self._thread is None:
            self._thread = threading.Thread(
                target=self._httpd.serve_forever, name="gs-viewer-server", daemon=True)
            self._thread.start()
        return self

    def stop(self):
        if self._thread is not None:
            self._httpd.shutdown()
            self._thread.join(timeout=5)
            self._thread = None
        self._httpd.server_close()

    def add_page(self, html: str) -> str:
        """Register a page; returns its path (`/view/<id>`)."""
        page_id = secrets.token_urlsafe(16)
        with self._pages_lock:
            self._pages[page_id] = html.encode("utf-8")
        return f"/view/{page_id}"

    def handle_api(self, content: dict):
        # JSON-only transport: there is no buffer channel to carry binary reads.
        content.pop("accept_binary", None)
        if content.get("type") in OFFLOADED_TYPES:
            return dispatch(self._shader, content)
        with self._dispatch_lock:
            return dispatch(self._shader, content)

    def _handler_class(self):
        server = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, format, *args):
                pass

            def _send(self, status: int, body: bytes = b"", ctype: str = "application/json"):
                self.send_response(status)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.end_headers()
                if body:
                    self.wfile.write(body)

            def _error(self, status: int, message: str):
                self._send(status, json.dumps({"error": message}).encode("utf-8"))

            def do_GET(self):
                path = self.path.split("?", 1)[0]
                if path.startswith("/view/"):
                    with server._pages_lock:
                        page = server._pages.get(path[len("/view/"):])
                    if page is not None:
                        self._send(200, page, "text/html; charset=utf-8")
                        return
                self._error(404, "not found")

            def do_POST(self):
                if self.path.split("?", 1)[0] != "/api":
                    self._error(404, "not found")
                    return
                if not hmac.compare_digest(self.headers.get("X-GS-Token", ""), server.token):
                    self._error(403, "bad token")
                    return
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                except ValueError:
                    length = -1
                if length < 0 or length > _MAX_BODY:
                    self._error(413, "bad request size")
                    return
                try:
                    content = json.loads(self.rfile.read(length) or b"{}")
                except ValueError:
                    self._error(400, "invalid JSON")
                    return
                if not isinstance(content, dict) or content.get("type") not in HANDLERS:
                    self._error(400, "unknown request type")
                    return
                resp, _buffers = server.handle_api(content)
                if resp is None:
                    self._send(204)
                    return
                self._send(200, encode_json(resp))

        return Handler
