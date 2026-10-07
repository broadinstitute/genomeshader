// WebGPU Classes (inlined to avoid module import issues with blob URLs)
// -----------------------------
//
// ONE GPUDevice and ONE set of compiled pipelines per page. Every canvas
// (tracks, flow, each smart track in each tile) is a thin `WebGPUCore` that only
// owns its own context + projection uniform and draws with the shared device and
// pipelines. That keeps single- and multi-tile painting on exactly the same code
// and GPU state, and makes a 50-sample × N-tile session cost one device, not one
// per canvas.
//
// The shared state lives on `window` so several viewer instances in one
// notebook page also share it.

const GS_GPU_KEY = "__genomeshaderGpu";

class GpuShared {
  constructor() {
    this.device = null;
    this.adapter = null;
    this.format = null;
    this.pipelines = new Map();   // name -> GPURenderPipeline (compiled once per device)
    this.cores = new Set();       // live WebGPUCore instances (for resize / recovery)
    this.epoch = 0;               // bumped whenever the device is (re)created
    this.info = null;
    this._ready = null;
    this._restoreListeners = new Set();
    this._onWindowResize = () => { for (const c of this.cores) c.handleResize(); };
    window.addEventListener("resize", this._onWindowResize);
  }

  /** Resolves once a device exists; rejects with a user-presentable Error if WebGPU is unavailable. */
  ready() {
    if (!this._ready) {
      this._ready = this._init().catch((e) => { this._ready = null; throw e; });
    }
    return this._ready;
  }

  async _init() {
    if (!navigator.gpu) {
      throw new Error("WebGPU is not available in this browser");
    }
    // requestAdapter() can transiently return null right after page load (GPU
    // process still settling); retry a few times before giving up.
    let adapter = null;
    for (let attempt = 0; attempt < 5 && !adapter; attempt++) {
      adapter = await navigator.gpu.requestAdapter();
      if (!adapter) await new Promise((r) => setTimeout(r, 100));
    }
    if (!adapter) throw new Error("No WebGPU adapter was found (GPU unavailable or blocklisted)");

    const device = await adapter.requestDevice();
    this.adapter = adapter;
    this.device = device;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.info = adapter.info || null;
    this.pipelines.clear();
    this.epoch++;

    device.lost.then((info) => {
      // A stale device (already replaced) reporting its loss is not news.
      if (this.device !== device) return;
      console.warn(`GenomeShader: GPU device lost (${info && info.reason}): ${info && info.message}`);
      this.device = null;
      this._ready = null;
      this.pipelines.clear();
      if (info && info.reason === "destroyed") return;
      this._recover();
    });
  }

  async _recover() {
    try {
      await this.ready();
    } catch (e) {
      console.error("GenomeShader: could not recover the GPU device", e);
      return;
    }
    for (const core of this.cores) core.rebind();
    for (const fn of this._restoreListeners) { try { fn(); } catch (_) {} }
  }

  /** Called after the device is recreated (canvases re-configured); repaint here. */
  onRestored(fn) {
    this._restoreListeners.add(fn);
    return () => this._restoreListeners.delete(fn);
  }

  /** Compile a pipeline once per device; later callers get the same object. */
  pipeline(name, build) {
    let p = this.pipelines.get(name);
    if (!p) {
      p = build();
      this.pipelines.set(name, p);
    }
    return p;
  }
}

function gsGpuShared() {
  if (!window[GS_GPU_KEY]) window[GS_GPU_KEY] = new GpuShared();
  return window[GS_GPU_KEY];
}

/** Promise for the shared device; rejects if WebGPU is unavailable. */
function gsGpuReady() {
  return gsGpuShared().ready();
}

class WebGPUCore {
  constructor() {
    this.shared = null;
    this.context = null;
    this.canvas = null;
    this.projectionMatrix = null;
    this.screenSize = null;
    this.projectionBuffer = null;
  }

  get device() { return this.shared ? this.shared.device : null; }
  get format() { return this.shared ? this.shared.format : null; }

  async init(canvas) {
    await gsGpuShared().ready();
    this.attach(canvas);
  }

  /** Synchronous init for when the shared device already exists (throws otherwise). */
  attach(canvas) {
    const shared = gsGpuShared();
    if (!shared.device) throw new Error("GPU device is not ready yet");
    this.shared = shared;
    this.canvas = canvas;

    this.context = canvas.getContext('webgpu');
    if (!this.context) {
      throw new Error('Failed to get WebGPU context');
    }
    this._configure();
    shared.cores.add(this);
  }

  _configure() {
    const devicePixelRatio = window.devicePixelRatio || 1;
    const width = Math.round(this.canvas.clientWidth * devicePixelRatio);
    const height = Math.round(this.canvas.clientHeight * devicePixelRatio);

    this.context.configure({
      device: this.device,
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      alphaMode: 'premultiplied',
    });

    // Orthographic 2D projection
    this.projectionMatrix = new Float32Array([
      2.0 / width, 0, 0, 0,
      0, -2.0 / height, 0, 0,
      0, 0, 1, 0,
      -1, 1, 0, 1
    ]);
    // Pad vec2 to vec4 for 16-byte alignment
    this.screenSize = new Float32Array([width, height, 0, 0]);

    if (this.projectionBuffer) { try { this.projectionBuffer.destroy(); } catch (_) {} }
    this.projectionBuffer = this.device.createBuffer({
      size: (16 + 4) * 4, // mat4x4 (16 floats) + vec4 padded (4 floats)
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.projectionBuffer, 0, this.projectionMatrix);
    this.device.queue.writeBuffer(this.projectionBuffer, 16 * 4, this.screenSize);
  }

  /** The shared device was replaced: re-attach this canvas to the new one. */
  rebind() {
    if (!this.canvas || !this.context || !this.shared || !this.device) return;
    this.projectionBuffer = null; // belonged to the dead device
    try { this._configure(); } catch (e) { console.error("GenomeShader: canvas rebind failed", e); }
  }

  /** Release this canvas's GPU resources (its shared device/pipelines stay). */
  dispose() {
    if (this.shared) this.shared.cores.delete(this);
    if (this._resizeTimeout) { cancelAnimationFrame(this._resizeTimeout); this._resizeTimeout = null; }
    if (this.projectionBuffer) { try { this.projectionBuffer.destroy(); } catch (_) {} this.projectionBuffer = null; }
    if (this.context) { try { this.context.unconfigure(); } catch (_) {} }
    this.context = null;
    this.canvas = null;
  }

  handleResize() {
    if (!this.canvas || !this.context) return;

    // Cancel any pending resize to avoid rapid successive updates
    if (this._resizeTimeout) {
      cancelAnimationFrame(this._resizeTimeout);
    }

    // Defer resize to next animation frame to ensure layout has settled
    // This prevents flickering in overlay mode where dimensions may change rapidly
    this._resizeTimeout = requestAnimationFrame(() => {
      this._resizeTimeout = null;

      if (!this.canvas || !this.context || !this.device) return;

      const devicePixelRatio = window.devicePixelRatio || 1;
      const width = Math.round(this.canvas.clientWidth * devicePixelRatio);
      const height = Math.round(this.canvas.clientHeight * devicePixelRatio);

      // Skip if dimensions are invalid (layout still settling)
      if (width <= 0 || height <= 0 || isNaN(width) || isNaN(height)) {
        return;
      }

      // Update canvas size
      this.canvas.width = width;
      this.canvas.height = height;

      // Update projection matrix
      this.projectionMatrix[0] = 2.0 / width;
      this.projectionMatrix[5] = -2.0 / height;
      this.projectionMatrix[12] = -1;
      this.projectionMatrix[13] = 1;

      // Update screen size (vec4 padded)
      this.screenSize[0] = width;
      this.screenSize[1] = height;
      this.screenSize[2] = 0;
      this.screenSize[3] = 0;

      this.device.queue.writeBuffer(this.projectionBuffer, 0, this.projectionMatrix);
      this.device.queue.writeBuffer(this.projectionBuffer, 16 * 4, this.screenSize);
    });
  }

  // Sync the orthographic projection to explicit device-pixel dims. The canvas
  // can be resized between init and a render (first paint before layout settled,
  // orientation swap); the projection was otherwise only written at init / on
  // window-resize, so a stale one mapped all geometry offscreen until a manual
  // resize (#81). Called every frame from the renderer.
  setViewport(width, height) {
    if (!this.projectionBuffer || !this.projectionMatrix || !this.screenSize) return;
    if (!(width > 0) || !(height > 0)) return;
    if (this.projectionMatrix[0] === 2.0 / width && this.projectionMatrix[5] === -2.0 / height) {
      return; // already in sync — skip the buffer writes
    }
    this.projectionMatrix[0] = 2.0 / width;
    this.projectionMatrix[5] = -2.0 / height;
    this.projectionMatrix[12] = -1;
    this.projectionMatrix[13] = 1;
    this.screenSize[0] = width;
    this.screenSize[1] = height;
    this.device.queue.writeBuffer(this.projectionBuffer, 0, this.projectionMatrix);
    this.device.queue.writeBuffer(this.projectionBuffer, 16 * 4, this.screenSize);
  }

  getCurrentTexture() {
    return this.context.getCurrentTexture();
  }

  createCommandEncoder() {
    return this.device.createCommandEncoder();
  }

  submit(commands) {
    this.device.queue.submit(commands);
  }
}
