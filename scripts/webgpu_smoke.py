"""WebGPU paint+readback smoke test on the NVIDIA GPU.

Proves the full path #65/#67 pixel tests depend on: headed Chrome under Xvfb,
NVIDIA Vulkan, secure localhost origin -> requestAdapter -> device -> clear a
canvas to a known color -> copy texture to buffer -> map+read the pixel back.

Run after `source scripts/setup_gpu_webgpu.sh` (sets DISPLAY + pins the ICD).
Exits non-zero unless the read-back pixel equals the painted color, so it can
gate CI on a GPU-enabled host. On a headless/no-GPU host it exits 2 (skipped).
"""
import http.server, socketserver, threading, os, sys, json

PAINT = (64, 128, 192, 255)
HTML = r"""<!doctype html><html><body><canvas id=c width=32 height=32></canvas>
<script>
async function main(){
  const out=(o)=>{document.title="RESULT:"+JSON.stringify(o);};
  if(!navigator.gpu){out({err:"no navigator.gpu"});return;}
  const adapter=await navigator.gpu.requestAdapter({powerPreference:"high-performance"});
  if(!adapter){out({err:"no adapter"});return;}
  const info=adapter.info||{};
  const device=await adapter.requestDevice();
  const c=document.getElementById("c"), ctx=c.getContext("webgpu");
  const fmt=navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({device,format:fmt,alphaMode:"opaque",
    usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});
  const enc=device.createCommandEncoder();
  const tex=ctx.getCurrentTexture();
  const pass=enc.beginRenderPass({colorAttachments:[{view:tex.createView(),
    clearValue:{r:64/255,g:128/255,b:192/255,a:1},loadOp:"clear",storeOp:"store"}]});
  pass.end();
  const bpr=256;
  const buf=device.createBuffer({size:bpr*32,
    usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
  enc.copyTextureToBuffer({texture:tex},{buffer:buf,bytesPerRow:bpr},{width:32,height:32});
  device.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const a=new Uint8Array(buf.getMappedRange()).slice(0,4);
  out({ok:true,vendor:info.vendor||"",architecture:info.architecture||"",
    fmt,pixel:[a[0],a[1],a[2],a[3]]});
}
main().catch(e=>{document.title="RESULT:"+JSON.stringify({err:String(e)});});
</script></body></html>"""

import tempfile
_d = tempfile.mkdtemp(prefix="wg_smoke_")
open(os.path.join(_d, "_wg_smoke.html"), "w").write(HTML)
os.chdir(_d)
httpd = socketserver.TCPServer(("127.0.0.1", 8731), http.server.SimpleHTTPRequestHandler)
threading.Thread(target=httpd.serve_forever, daemon=True).start()

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print("SKIP: playwright not installed"); sys.exit(2)

with sync_playwright() as p:
    b = p.chromium.launch(
        channel="chrome", headless=False,
        ignore_default_args=["--disable-gpu"],
        args=["--enable-unsafe-webgpu", "--enable-features=Vulkan",
              "--use-angle=vulkan", "--use-vulkan",
              "--no-sandbox", "--disable-dev-shm-usage", "--ignore-gpu-blocklist"])
    pg = b.new_page()
    pg.goto("http://127.0.0.1:8731/_wg_smoke.html")
    try:
        pg.wait_for_function("document.title.startsWith('RESULT:')", timeout=25000)
    except Exception:
        print("FAIL: timed out waiting for WebGPU result"); b.close(); sys.exit(1)
    res = json.loads(pg.title()[len("RESULT:"):])
    b.close()

print(json.dumps(res))
if not res.get("ok"):
    print("SKIP/FAIL:", res.get("err")); sys.exit(2 if "navigator.gpu" in str(res.get("err")) else 1)
if tuple(res["pixel"]) != PAINT:
    print(f"FAIL: pixel {res['pixel']} != painted {list(PAINT)}"); sys.exit(1)
print(f"PASS: WebGPU painted+readback exact on {res['vendor']}/{res['architecture']}")
