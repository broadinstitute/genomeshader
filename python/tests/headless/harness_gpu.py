"""Real-GPU WebGPU pixel-test harness.

The plain headless harness (``harness.py``) renders the viewer in headless
Chromium with a software GL backend, so it can only assert on SVG/DOM — WebGPU
never paints there. This harness renders the *same* viewer in **real Google
Chrome on a real GPU** so tests can assert on the actual painted pixels (the
smart-track read canvas, SNP glyph overlay, read colors).

It reuses ``harness.build_page`` for the page HTML but differs in two ways that
WebGPU requires:

- served over ``http://127.0.0.1`` (a secure origin — ``navigator.gpu`` is
  hidden on the ``file://`` / opaque origins the plain harness uses), and
- opened in real Chrome launched **headed** with the WebGPU/Vulkan flags (the
  bundled Chromium compiles WebGPU out; headless tears the instance down).

On a machine without a working WebGPU GPU (no ``--device /dev/nvidia-modeset``,
no display, laptop CI) ``gpu_context`` yields ``None`` so the tests skip
cleanly. See planning/WEBGPU_TESTING.md for the environment setup.
"""
import contextlib
import http.server
import os
import socket
import socketserver
import sys
import threading

sys.path.insert(0, os.path.dirname(__file__))
import harness  # noqa: E402  (reuse build_page / _assets)

VIEWPORT = {"width": 1200, "height": 900}

# Real Chrome + WebGPU-on-Vulkan. `--disable-gpu` is stripped separately via
# ignore_default_args (Playwright injects it, and it hides navigator.gpu).
GPU_CHROME_ARGS = [
    "--enable-unsafe-webgpu",
    "--enable-features=Vulkan",
    "--use-angle=vulkan",
    "--use-vulkan",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--ignore-gpu-blocklist",
]


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


@contextlib.contextmanager
def _serve(html):
    """Serve one HTML string at any path on http://127.0.0.1:<port>."""
    port = _free_port()
    data = html.encode("utf-8")

    class _H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *a):
            pass

    httpd = socketserver.TCPServer(("127.0.0.1", port), _H)
    httpd.allow_reuse_address = True
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    try:
        yield f"http://127.0.0.1:{port}/"
    finally:
        httpd.shutdown()
        httpd.server_close()


def launch(pw):
    """Launch real Chrome for WebGPU, or return None if unavailable (skip)."""
    try:
        return pw.chromium.launch(
            channel="chrome",
            headless=False,
            ignore_default_args=["--disable-gpu"],
            args=GPU_CHROME_ARGS,
        )
    except Exception:
        return None


def webgpu_works(browser):
    """True only if a real WebGPU adapter is obtainable — gates the whole suite
    so it skips on GPU-less hosts instead of failing."""
    page = browser.new_page()
    try:
        with _serve("<!doctype html><html><body>ok</body></html>") as url:
            page.goto(url, wait_until="load")
            return bool(page.evaluate(
                "async () => !!(navigator.gpu && await navigator.gpu.requestAdapter())"
            ))
    except Exception:
        return False
    finally:
        page.close()


@contextlib.contextmanager
def open_viewer(browser, config=None, orientation="horizontal", timeout=25000):
    """Open the real viewer over a secure origin, wait until it's ready.

    Yields (page, errors). ``errors`` collects pageerror + console.error.
    """
    page = browser.new_page(viewport=VIEWPORT)
    errors = []
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    page.on("console", lambda m: errors.append(f"console.error: {m.text}")
            if m.type == "error" else None)
    page.add_init_script(
        "try{localStorage.setItem('genomeshader.orientation',%r);"
        "localStorage.setItem('genomeshader.theme','light');}catch(e){}" % orientation
    )
    with _serve(harness.build_page(config=config)) as url:
        page.goto(url, wait_until="load")
        page.wait_for_function("() => window.__GS_READY === true", timeout=timeout)
        page.wait_for_timeout(400)
        try:
            yield page, errors
        finally:
            page.close()


# --- reads synthesis + seeding ---------------------------------------------

# JS that builds column-oriented raw reads spanning the current locus, in the
# exact shape the Rust extractor emits (element_type 0 = READ row, then that
# read's CIGAR/SNP element rows). Runs in the page (needs window.__GS_STATE for
# the live locus). opts: nReads, haplotype, rowsDeep (force a deep pileup by
# overlapping every read), snp (add a Diff element per read).
BUILD_READS_JS = r"""
(opts) => {
  const S = window.__GS_STATE;
  const s0 = S.startBp, s1 = S.endBp, span = s1 - s0;
  const n = opts.nReads, hap = opts.haplotype || 0;
  const q=[],et=[],rs=[],re=[],fw=[],hp=[],sn=[],seq=[];
  for (let i = 0; i < n; i++) {
    let st, en;
    if (opts.rowsDeep) {
      // All reads overlap the locus center -> greedy packer stacks them into
      // n separate rows (deep pileup) to exercise virtualization.
      st = Math.floor(s0 + span * 0.25);
      en = Math.floor(s0 + span * 0.75);
    } else {
      st = Math.floor(s0 + (i % 7) * (span / 9) + 5);
      en = Math.min(s1 - 2, st + Math.floor(span / 6));
    }
    q.push('r'+i); et.push(0); rs.push(st); re.push(en);
    fw.push(i % 2 === 0); hp.push(hap); sn.push('S'); seq.push('');
    if (opts.snp) {
      const mid = Math.floor((st + en) / 2);
      q.push('r'+i); et.push(1); rs.push(mid); re.push(mid);
      fw.push(true); hp.push(hap); sn.push('S'); seq.push(opts.snpBase || 'A');
    }
  }
  return {query_name:q, element_type:et, reference_start:rs, reference_end:re,
          is_forward:fw, haplotype:hp, sample_name:sn, sequence:seq};
}"""


def set_span(page, span_bp):
    """Narrow the visible locus to span_bp bases (zoom in) and re-render, so
    per-base SNP tiles are wide enough to draw letters. Call before seed_reads."""
    return page.evaluate("(n) => window.__GS_TEST_setSpan(n)", span_bp)


def seed_reads(page, sample_id="SAMPLE", n=20, haplotype=1, rows_deep=False,
               snp=False, snp_base="A", collapsed=False):
    """Build raw reads for the live locus and seed a smart track; returns the
    seam's result dict (trackId, rowCount, readCount, hasWebGPU)."""
    reads = page.evaluate(BUILD_READS_JS, {
        "nReads": n, "haplotype": haplotype, "rowsDeep": rows_deep,
        "snp": snp, "snpBase": snp_base,
    })
    return page.evaluate(
        "async (a) => await window.__GS_TEST_seedSmartTrack(a.sid, a.reads, {collapsed:a.c})",
        {"sid": sample_id, "reads": reads, "c": collapsed},
    )


# --- pixel helpers ----------------------------------------------------------

def canvas_box(page, prefix="smart-track-webgpu-"):
    """Bounding box {x,y,w,h} of the first canvas whose id starts with prefix."""
    return page.evaluate(
        """(pfx) => { const c = document.querySelector('[id^="'+pfx+'"]');
             if (!c) return null; const r = c.getBoundingClientRect();
             return {x:r.x, y:r.y, w:r.width, h:r.height}; }""",
        prefix,
    )


def region_pixels(page, box):
    """Screenshot ``box`` and return (PIL.Image RGB, list of (r,g,b) pixels)."""
    from PIL import Image
    import io
    clip = {"x": box["x"], "y": box["y"], "width": box["w"], "height": box["h"]}
    png = page.screenshot(clip=clip)
    img = Image.open(io.BytesIO(png)).convert("RGB")
    raw = img.tobytes()  # packed RGB
    pixels = [(raw[i], raw[i + 1], raw[i + 2]) for i in range(0, len(raw), 3)]
    return img, pixels


def frac_matching(pixels, pred):
    """Fraction of pixels satisfying pred((r,g,b))."""
    if not pixels:
        return 0.0
    return sum(1 for p in pixels if pred(p)) / len(pixels)
