// Instanced 2D primitives (rects / triangles / lines) on the SHARED GPU device.
//
// Pipelines are compiled once per device (GpuShared.pipeline) and reused by every
// renderer. Each renderer only owns its staging arrays and GPU instance buffers.
// Instances are written straight into growable Float32Arrays — no per-primitive
// objects — so a paint of hundreds of thousands of primitives allocates nothing.
const GS_RECT_STRIDE = 8;      // x,y (center), w,h, r,g,b,a
const GS_TRI_STRIDE = 10;      // v0.xy v1.xy v2.xy, r,g,b,a
const GS_LINE_STRIDE = 8;      // x0,y0, x1,y1, r,g,b,a

class InstancedRenderer {
  constructor(webgpuCore) {
    this.core = webgpuCore;
    this._epoch = -1;           // shared-device epoch our pipelines / buffers belong to

    // Staging: one growable Float32Array per primitive kind + a live count.
    this._rect = new Float32Array(GS_RECT_STRIDE * 256);
    this._rectN = 0;
    this._tri = new Float32Array(GS_TRI_STRIDE * 16);
    this._triN = 0;
    this._line = new Float32Array(GS_LINE_STRIDE * 64);
    this._lineN = 0;

    // GPU-side instance buffers (capacity in bytes) and cached bind groups.
    this.rectBuffer = null;
    this.triangleBuffer = null;
    this.lineBuffer = null;
    this._bind = { rect: null, tri: null, line: null, ubo: null };

    this.rectPipeline = null;
    this.trianglePipeline = null;
    this.linePipeline = null;

    this.init();
  }

  get device() { return this.core.device; }

  init() {
    this._bindToDevice();
  }

  // (Re)attach to the current shared device: fetch the shared pipelines and drop
  // any buffers / bind groups that belonged to a previous (lost) device.
  _bindToDevice() {
    const shared = this.core.shared;
    this._epoch = shared.epoch;
    this.rectBuffer = this.triangleBuffer = this.lineBuffer = null;
    this._bind = { rect: null, tri: null, line: null, ubo: null };
    this.rectPipeline = shared.pipeline("rect", () => { this.createRectPipeline(); return this.rectPipeline; });
    this.trianglePipeline = shared.pipeline("triangle", () => { this.createTrianglePipeline(); return this.trianglePipeline; });
    this.linePipeline = shared.pipeline("line", () => { this.createLinePipeline(); return this.linePipeline; });
  }

  /** True when there is anything to draw. */
  hasInstances() {
    return (this._rectN | this._triN | this._lineN) > 0;
  }

  // Convert hex color to normalized RGBA
  hexToRgba(hex, alpha = 1.0) {
    if (typeof hex === 'string') {
      if (hex.startsWith('#')) {
        hex = hex.slice(1);
      }
      const r = parseInt(hex.slice(0, 2), 16) / 255;
      const g = parseInt(hex.slice(2, 4), 16) / 255;
      const b = parseInt(hex.slice(4, 6), 16) / 255;
      return [r, g, b, alpha];
    } else {
      // Assume it's a number (0xRRGGBB)
      const r = ((hex >> 16) & 0xFF) / 255;
      const g = ((hex >> 8) & 0xFF) / 255;
      const b = (hex & 0xFF) / 255;
      return [r, g, b, alpha];
    }
  }

  createRectPipeline() {
    const vertexShader = `
      struct Uniforms {
        projection: mat4x4<f32>,
        screenSize: vec2<f32>,
        _padding: vec2<f32>, // Padding for 16-byte alignment
      }
      @group(0) @binding(0) var<uniform> uniforms: Uniforms;

      struct VertexOutput {
        @builtin(position) position: vec4<f32>,
        @location(1) @interpolate(flat) instanceMin: vec2<f32>,
        @location(2) @interpolate(flat) instanceMax: vec2<f32>,
        @location(3) @interpolate(flat) color: vec4<f32>,
      }

      @vertex
      fn vs_main(
        @builtin(vertex_index) vertexIndex: u32,
        @builtin(instance_index) instanceIndex: u32,
        @location(0) position: vec2<f32>,
        @location(1) size: vec2<f32>,
        @location(2) color: vec4<f32>
      ) -> VertexOutput {
        // Quad vertices: (-0.5, -0.5), (0.5, -0.5), (-0.5, 0.5), (0.5, 0.5)
        var quadPos = vec2<f32>(0.0);
        if (vertexIndex == 0u) {
          quadPos = vec2<f32>(-0.5, -0.5);
        } else if (vertexIndex == 1u) {
          quadPos = vec2<f32>(0.5, -0.5);
        } else if (vertexIndex == 2u) {
          quadPos = vec2<f32>(-0.5, 0.5);
        } else {
          quadPos = vec2<f32>(0.5, 0.5);
        }
        
        var worldPos = position + quadPos * size;
        var halfSize = size * 0.5;
        var output: VertexOutput;
        output.position = uniforms.projection * vec4<f32>(worldPos, 0.0, 1.0);
        output.instanceMin = position - halfSize;
        output.instanceMax = position + halfSize;
        output.color = color;
        return output;
      }
    `;

    const fragmentShader = `
      struct Uniforms {
        projection: mat4x4<f32>,
        screenSize: vec2<f32>,
        _padding: vec2<f32>, // Padding for 16-byte alignment
      }
      @group(0) @binding(0) var<uniform> uniforms: Uniforms;

      @fragment
      fn fs_main(
        @builtin(position) fragCoord: vec4<f32>,
        @location(1) @interpolate(flat) instanceMin: vec2<f32>,
        @location(2) @interpolate(flat) instanceMax: vec2<f32>,
        @location(3) @interpolate(flat) color: vec4<f32>
      ) -> @location(0) vec4<f32> {
        // fragCoord.xy is in framebuffer pixel coordinates (not NDC)
        // This directly matches our world coordinates since we use an orthographic projection
        let worldPos = fragCoord.xy;
        
        // Get rectangle dimensions and center
        let size = instanceMax - instanceMin;
        let center = (instanceMin + instanceMax) * 0.5;
        let halfSize = size * 0.5;
        let minDim = min(size.x, size.y);
        
        // For very small rectangles (< 6px), don't apply rounding or stroke
        if (minDim < 6.0) {
          // Still need premultiplied alpha for correct blending
          return vec4<f32>(color.rgb * color.a, color.a);
        }
        
        // Apply rounded corners with radius 4 pixels (matching SVG rx=4)
        let radius = 4.0;
        let actualRadius = min(radius, minDim * 0.5);
        
        // Proper rounded rectangle SDF
        // Calculate position relative to center
        let p = abs(worldPos - center);
        // Shrink the half-size by radius to get the inner rectangle
        let q = p - halfSize + actualRadius;
        // Distance to rounded rectangle: negative inside, positive outside
        let d = length(max(q, vec2<f32>(0.0))) + min(max(q.x, q.y), 0.0) - actualRadius;
        
        // Stroke width of 1 pixel
        let strokeWidth = 1.0;
        
        // Determine if we're in stroke region or fill region
        // d < -strokeWidth: inside fill region
        // -strokeWidth <= d < 0: in stroke region
        // d >= 0: outside
        
        // Alpha convention: alpha >= 0.99 = draw both fill and stroke (opaque node, e.g. allele nodes).
        // 0.5 < alpha < 0.99 = stroke-only (legacy). alpha <= 0.5 = fill-only (legacy).
        let drawBoth = color.a >= 0.99;
        let isStrokeOnly = !drawBoth && color.a > 0.5;
        
        if (drawBoth) {
          // Opaque node: stroke full opacity, fill slightly transparent
          let fillMask = 1.0 - smoothstep(-strokeWidth - 0.5, -strokeWidth + 0.5, d);
          let strokeMask = smoothstep(-strokeWidth - 0.5, -strokeWidth + 0.5, d) * (1.0 - smoothstep(-0.5, 0.5, d));
          let fillAlpha = fillMask * 0.70;   // Slightly transparent fill (70%)
          let strokeAlpha = strokeMask * 1.0; // Full opacity stroke
          let finalAlpha = min(1.0, fillAlpha + strokeAlpha);
          return vec4<f32>(color.rgb * finalAlpha, finalAlpha);
        } else if (isStrokeOnly) {
          // Stroke-only rectangle
          let strokeAlpha = smoothstep(-strokeWidth - 0.5, -strokeWidth + 0.5, d) * (1.0 - smoothstep(-0.5, 0.5, d));
          let finalAlpha = color.a * strokeAlpha;
          return vec4<f32>(color.rgb * finalAlpha, finalAlpha);
        } else {
          // Fill-only rectangle
          let fillAlpha = 1.0 - smoothstep(-strokeWidth - 0.5, -strokeWidth + 0.5, d);
          let finalAlpha = color.a * fillAlpha;
          return vec4<f32>(color.rgb * finalAlpha, finalAlpha);
        }
      }
    `;

    const vertexModule = this.device.createShaderModule({ code: vertexShader });
    const fragmentModule = this.device.createShaderModule({ code: fragmentShader });

    this.rectPipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: vertexModule,
        entryPoint: 'vs_main',
        buffers: [
          {
            arrayStride: 8 * 4, // position(8) + size(8) + color(16) = 32 bytes
            stepMode: 'instance',
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x2' }, // position
              { shaderLocation: 1, offset: 8, format: 'float32x2' }, // size
              { shaderLocation: 2, offset: 16, format: 'float32x4' }, // color
            ],
          },
        ],
      },
      fragment: {
        module: fragmentModule,
        entryPoint: 'fs_main',
        targets: [{
          format: this.core.format,
          blend: {
            color: {
              srcFactor: 'one',
              dstFactor: 'one-minus-src-alpha',
              operation: 'add',
            },
            alpha: {
              srcFactor: 'one',
              dstFactor: 'one-minus-src-alpha',
              operation: 'add',
            },
          },
        }],
      },
      primitive: {
        topology: 'triangle-strip',
      },
    });
  }

  createTrianglePipeline() {
    const vertexShader = `
      struct Uniforms {
        projection: mat4x4<f32>,
      }
      @group(0) @binding(0) var<uniform> uniforms: Uniforms;

      struct VertexOutput {
        @builtin(position) position: vec4<f32>,
        @location(3) @interpolate(flat) color: vec4<f32>,
      }

      @vertex
      fn vs_main(
        @builtin(vertex_index) vertexIndex: u32,
        @builtin(instance_index) instanceIndex: u32,
        @location(0) v0: vec2<f32>,
        @location(1) v1: vec2<f32>,
        @location(2) v2: vec2<f32>,
        @location(3) color: vec4<f32>
      ) -> VertexOutput {
        var pos: vec2<f32>;
        if (vertexIndex == 0u) {
          pos = v0;
        } else if (vertexIndex == 1u) {
          pos = v1;
        } else {
          pos = v2;
        }
        var output: VertexOutput;
        output.position = uniforms.projection * vec4<f32>(pos, 0.0, 1.0);
        output.color = color;
        return output;
      }
    `;

    const fragmentShader = `
      @fragment
      fn fs_main(
        @location(3) @interpolate(flat) color: vec4<f32>
      ) -> @location(0) vec4<f32> {
        return color;
      }
    `;

    const vertexModule = this.device.createShaderModule({ code: vertexShader });
    const fragmentModule = this.device.createShaderModule({ code: fragmentShader });

    this.trianglePipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: vertexModule,
        entryPoint: 'vs_main',
        buffers: [
          {
            arrayStride: 10 * 4, // v0(8) + v1(8) + v2(8) + color(16) = 40 bytes = 10 floats
            stepMode: 'instance',
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x2' }, // v0
              { shaderLocation: 1, offset: 8, format: 'float32x2' }, // v1
              { shaderLocation: 2, offset: 16, format: 'float32x2' }, // v2
              { shaderLocation: 3, offset: 24, format: 'float32x4' }, // color
            ],
          },
        ],
      },
      fragment: {
        module: fragmentModule,
        entryPoint: 'fs_main',
        targets: [{
          format: this.core.format,
          blend: {
            color: {
              srcFactor: 'src-alpha',
              dstFactor: 'one-minus-src-alpha',
              operation: 'add',
            },
            alpha: {
              srcFactor: 'one',
              dstFactor: 'one-minus-src-alpha',
              operation: 'add',
            },
          },
        }],
      },
      primitive: {
        topology: 'triangle-list',
      },
    });
  }

  createLinePipeline() {
    const vertexShader = `
      struct Uniforms {
        projection: mat4x4<f32>,
      }
      @group(0) @binding(0) var<uniform> uniforms: Uniforms;

      struct VertexOutput {
        @builtin(position) position: vec4<f32>,
        @location(2) @interpolate(flat) color: vec4<f32>,
      }

      @vertex
      fn vs_main(
        @builtin(vertex_index) vertexIndex: u32,
        @builtin(instance_index) instanceIndex: u32,
        @location(0) start: vec2<f32>,
        @location(1) end: vec2<f32>,
        @location(2) color: vec4<f32>
      ) -> VertexOutput {
        var pos: vec2<f32>;
        if (vertexIndex == 0u) {
          pos = start;
        } else {
          pos = end;
        }
        var output: VertexOutput;
        output.position = uniforms.projection * vec4<f32>(pos, 0.0, 1.0);
        output.color = color;
        return output;
      }
    `;

    const fragmentShader = `
      @fragment
      fn fs_main(
        @location(2) @interpolate(flat) color: vec4<f32>
      ) -> @location(0) vec4<f32> {
        return color;
      }
    `;

    const vertexModule = this.device.createShaderModule({ code: vertexShader });
    const fragmentModule = this.device.createShaderModule({ code: fragmentShader });

    this.linePipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: vertexModule,
        entryPoint: 'vs_main',
        buffers: [
          {
            arrayStride: 8 * 4, // start(8) + end(8) + color(16) = 32 bytes
            stepMode: 'instance',
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x2' }, // start
              { shaderLocation: 1, offset: 8, format: 'float32x2' }, // end
              { shaderLocation: 2, offset: 16, format: 'float32x4' }, // color
            ],
          },
        ],
      },
      fragment: {
        module: fragmentModule,
        entryPoint: 'fs_main',
        targets: [{
          format: this.core.format,
          blend: {
            color: {
              srcFactor: 'src-alpha',
              dstFactor: 'one-minus-src-alpha',
              operation: 'add',
            },
            alpha: {
              srcFactor: 'one',
              dstFactor: 'one-minus-src-alpha',
              operation: 'add',
            },
          },
        }],
      },
      primitive: {
        topology: 'line-list',
      },
    });
  }

  createGeometryBuffers() {
    // Rectangle uses triangle-strip, no vertex buffer needed (generated in shader)
    // Triangle uses triangle-list, no vertex buffer needed (generated in shader)
    // Line uses line-list, no vertex buffer needed (generated in shader)
  }

  _growRect(n) {
    const need = (this._rectN + n) * GS_RECT_STRIDE;
    if (need <= this._rect.length) return;
    const next = new Float32Array(Math.max(need, this._rect.length * 2));
    next.set(this._rect.subarray(0, this._rectN * GS_RECT_STRIDE));
    this._rect = next;
  }

  // Add rectangle instance
  // color can be: hex string (e.g., "#FF0000"), hex number, or rgba array [r, g, b, a]
  addRect(x, y, width, height, color, alpha = 1.0) {
    let r, g, b, a;
    if (Array.isArray(color) && color.length >= 3) {
      r = color[0]; g = color[1]; b = color[2];
      a = color.length === 4 ? color[3] : alpha;
    } else {
      const c = this.hexToRgba(color, alpha);
      r = c[0]; g = c[1]; b = c[2]; a = c[3];
    }
    if (this._rect.length < (this._rectN + 1) * GS_RECT_STRIDE) this._growRect(1);
    const o = this._rectN * GS_RECT_STRIDE;
    const d = this._rect;
    d[o] = x + width / 2;       // center position
    d[o + 1] = y + height / 2;
    d[o + 2] = width;
    d[o + 3] = height;
    d[o + 4] = r; d[o + 5] = g; d[o + 6] = b; d[o + 7] = a;
    this._rectN++;
  }

  // Add triangle instance
  addTriangle(x0, y0, x1, y1, x2, y2, color, alpha = 1.0) {
    const c = this.hexToRgba(color, alpha);
    if (this._tri.length < (this._triN + 1) * GS_TRI_STRIDE) {
      const next = new Float32Array(Math.max((this._triN + 1) * GS_TRI_STRIDE, this._tri.length * 2));
      next.set(this._tri.subarray(0, this._triN * GS_TRI_STRIDE));
      this._tri = next;
    }
    const o = this._triN * GS_TRI_STRIDE;
    const d = this._tri;
    d[o] = x0; d[o + 1] = y0; d[o + 2] = x1; d[o + 3] = y1; d[o + 4] = x2; d[o + 5] = y2;
    d[o + 6] = c[0]; d[o + 7] = c[1]; d[o + 8] = c[2]; d[o + 9] = c[3];
    this._triN++;
  }

  // Add line instance
  addLine(x0, y0, x1, y1, color, alpha = 1.0) {
    const c = this.hexToRgba(color, alpha);
    if (this._line.length < (this._lineN + 1) * GS_LINE_STRIDE) {
      const next = new Float32Array(Math.max((this._lineN + 1) * GS_LINE_STRIDE, this._line.length * 2));
      next.set(this._line.subarray(0, this._lineN * GS_LINE_STRIDE));
      this._line = next;
    }
    const o = this._lineN * GS_LINE_STRIDE;
    const d = this._line;
    d[o] = x0; d[o + 1] = y0; d[o + 2] = x1; d[o + 3] = y1;
    d[o + 4] = c[0]; d[o + 5] = c[1]; d[o + 6] = c[2]; d[o + 7] = c[3];
    this._lineN++;
  }

  // Clear all instances (keeps the staging arrays — nothing is reallocated)
  clear() {
    this._rectN = 0;
    this._triN = 0;
    this._lineN = 0;
  }

  // Upload `count` instances from `data` into `buf` (growing it geometrically),
  // returning the (possibly new) buffer.
  _upload(buf, data, count, stride) {
    const floats = count * stride;
    const bytes = floats * 4;
    if (!buf || buf.size < bytes) {
      if (buf) buf.destroy();
      buf = this.device.createBuffer({
        size: Math.max(bytes, buf ? buf.size * 2 : 0, 4096),
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }
    this.device.queue.writeBuffer(buf, 0, data.buffer, data.byteOffset, bytes);
    return buf;
  }

  // Bind group for one pipeline against this canvas's projection uniform, cached
  // until the uniform buffer (or the device) changes.
  _bindGroup(kind, pipeline) {
    const ubo = this.core.projectionBuffer;
    if (this._bind.ubo !== ubo) {
      this._bind = { rect: null, tri: null, line: null, ubo };
    }
    if (!this._bind[kind]) {
      this._bind[kind] = this.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: ubo } }],
      });
    }
    return this._bind[kind];
  }

  // Render all instances
  render(encoder, renderPass) {
    if (this._epoch !== this.core.shared.epoch) this._bindToDevice();

    // Keep the projection matched to the CURRENT canvas size every frame. The
    // canvas can be resized between init and now (first paint before layout
    // settled, orientation swap); previously the projection was only updated at
    // init / on window-resize, so a stale projection drew all geometry offscreen
    // until a manual resize (#81 — vertical read bodies not painting on load).
    if (this.core && this.core.setViewport && this.core.canvas) {
      this.core.setViewport(this.core.canvas.width, this.core.canvas.height);
    }

    if (this._rectN > 0) {
      this.rectBuffer = this._upload(this.rectBuffer, this._rect, this._rectN, GS_RECT_STRIDE);
      renderPass.setPipeline(this.rectPipeline);
      renderPass.setBindGroup(0, this._bindGroup("rect", this.rectPipeline));
      renderPass.setVertexBuffer(0, this.rectBuffer);
      renderPass.draw(4, this._rectN); // 4 vertices per quad
    }

    if (this._triN > 0) {
      this.triangleBuffer = this._upload(this.triangleBuffer, this._tri, this._triN, GS_TRI_STRIDE);
      renderPass.setPipeline(this.trianglePipeline);
      renderPass.setBindGroup(0, this._bindGroup("tri", this.trianglePipeline));
      renderPass.setVertexBuffer(0, this.triangleBuffer);
      renderPass.draw(3, this._triN); // 3 vertices per triangle
    }

    if (this._lineN > 0) {
      this.lineBuffer = this._upload(this.lineBuffer, this._line, this._lineN, GS_LINE_STRIDE);
      renderPass.setPipeline(this.linePipeline);
      renderPass.setBindGroup(0, this._bindGroup("line", this.linePipeline));
      renderPass.setVertexBuffer(0, this.lineBuffer);
      renderPass.draw(2, this._lineN); // 2 vertices per line
    }
  }

  /** Free this renderer's GPU buffers (pipelines belong to the shared device). */
  dispose() {
    for (const k of ["rectBuffer", "triangleBuffer", "lineBuffer"]) {
      if (this[k]) { try { this[k].destroy(); } catch (_) {} this[k] = null; }
    }
    this._bind = { rect: null, tri: null, line: null, ubo: null };
    this.clear();
  }

  // Get rendering statistics
  getStats() {
    return {
      rectangles: this._rectN,
      triangles: this._triN,
      lines: this._lineN,
      totalPolygons: this._rectN + this._triN + this._lineN,
    };
  }
}

/**
 * Size a GPU canvas's backing store only when it actually changed: assigning
 * width/height resets the drawing buffer even for an identical value, which a
 * per-frame repaint must not do. Rounded so a fractional devicePixelRatio is
 * stable.
 */
function gsSetGpuCanvasSize(canvas, w, h) {
  const rw = Math.max(1, Math.round(w));
  const rh = Math.max(1, Math.round(h));
  if (canvas.width !== rw) canvas.width = rw;
  if (canvas.height !== rh) canvas.height = rh;
}

/**
 * Test hook (window.__GS_TEST_CAPTURE): a WebGPU canvas can only be read back in
 * the task that painted it, so tests that assert on painted pixels get a shadow
 * 2D copy taken at the moment of presentation. Never enabled in production.
 */
function gsCaptureGpuCanvas(canvas) {
  const sh = canvas._gsShadow || (canvas._gsShadow = document.createElement("canvas"));
  if (sh.width !== canvas.width) sh.width = canvas.width;
  if (sh.height !== canvas.height) sh.height = canvas.height;
  const ctx = sh.getContext("2d", { willReadFrequently: true });
  ctx.clearRect(0, 0, sh.width, sh.height);
  try { ctx.drawImage(canvas, 0, 0); } catch (_) {}
}

// drawImage of a WebGPU canvas is blank for a short strip on a software Vulkan
// adapter (the summary ticks), even when the render target holds the pixels.
// Copy that target out in the same submission and paint the shadow from it.
function gsEncodeCanvasReadback(device, encoder, texture, canvas) {
  const w = canvas.width | 0, h = canvas.height | 0;
  if (w <= 0 || h <= 0 || w * h > 2000000) return null;
  const bytesPerRow = Math.ceil((w * 4) / 256) * 256;
  const buffer = device.createBuffer({
    size: bytesPerRow * h,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  encoder.copyTextureToBuffer(
    { texture },
    { buffer, bytesPerRow, rowsPerImage: h },
    { width: w, height: h, depthOrArrayLayers: 1 }
  );
  return { buffer, w, h, bytesPerRow };
}

function gsFinishCanvasReadback(canvas, format, pending) {
  const token = (canvas._gsReadbackToken = (canvas._gsReadbackToken || 0) + 1);
  pending.buffer.mapAsync(GPUMapMode.READ).then(() => {
    if (canvas._gsReadbackToken !== token) {
      try { pending.buffer.unmap(); } catch (_) {}
      pending.buffer.destroy();
      return;
    }
    const src = new Uint8Array(pending.buffer.getMappedRange());
    const sh = canvas._gsShadow || (canvas._gsShadow = document.createElement("canvas"));
    if (sh.width !== pending.w) sh.width = pending.w;
    if (sh.height !== pending.h) sh.height = pending.h;
    const ctx = sh.getContext("2d", { willReadFrequently: true });
    const img = ctx.createImageData(pending.w, pending.h);
    const dst = img.data;
    const bgra = format === "bgra8unorm" || format === "bgra8unorm-srgb";
    for (let y = 0; y < pending.h; y++) {
      const row = y * pending.bytesPerRow;
      for (let x = 0; x < pending.w; x++) {
        const o = row + x * 4, j = (y * pending.w + x) * 4;
        // The shader writes premultiplied rgb. drawImage hands tests straight
        // color; undo that here so a translucent tick still matches its hue.
        let r, g, b, a;
        if (bgra) { b = src[o]; g = src[o + 1]; r = src[o + 2]; a = src[o + 3]; }
        else { r = src[o]; g = src[o + 1]; b = src[o + 2]; a = src[o + 3]; }
        if (a > 0 && a < 255) {
          const s = 255 / a;
          r = Math.min(255, Math.round(r * s));
          g = Math.min(255, Math.round(g * s));
          b = Math.min(255, Math.round(b * s));
        }
        dst[j] = r; dst[j + 1] = g; dst[j + 2] = b; dst[j + 3] = a;
      }
    }
    ctx.putImageData(img, 0, 0);
    pending.buffer.unmap();
    pending.buffer.destroy();
  }).catch(() => { try { pending.buffer.destroy(); } catch (_) {} });
}

/**
 * Present one canvas: size its backing store to its CSS box (rounded, so a
 * fractional devicePixelRatio does not reset the swap chain every frame), then
 * draw `ribbons` (an underlay, if given) then `renderer`'s instances in a single
 * pass. With nothing queued the pass just clears the canvas.
 */
function gsFlushGpuCanvas(core, renderer, canvas, ribbons, opts) {
  if (!core || !renderer || !canvas || !core.device || !core.context) return;
  try {
    // keepSize: the caller has already sized the backing store (virtualized canvases).
    if (!(opts && opts.keepSize)) {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.round(canvas.clientWidth * dpr);
      const h = Math.round(canvas.clientHeight * dpr);
      if (w > 0 && h > 0 && (canvas.width !== w || canvas.height !== h)) {
        canvas.width = w;
        canvas.height = h;
        core.handleResize();
      }
    }
    const encoder = core.createCommandEncoder();
    const texture = core.getCurrentTexture();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: texture.createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    if (ribbons) ribbons.render(encoder, pass);
    renderer.render(encoder, pass);
    pass.end();
    let readback = null;
    if (window.__GS_TEST_CAPTURE) {
      try { readback = gsEncodeCanvasReadback(core.device, encoder, texture, canvas); }
      catch (_) { readback = null; }
    }
    core.submit([encoder.finish()]);
    if (window.__GS_TEST_CAPTURE) gsCaptureGpuCanvas(canvas);
    if (readback) gsFinishCanvasReadback(canvas, core.format, readback);
  } catch (error) {
    console.error("WebGPU flush error:", error);
    renderer.clear();
    if (ribbons) ribbons.clear();
  }
}

/**
 * Stand-in bound before the shared device exists (the first paint runs before
 * WebGPU is ready): accepts every draw call and draws nothing. The repaint that
 * follows device readiness fills the canvases in, so paint code never needs a
 * "is the GPU up yet" guard.
 */
const GS_NULL_RENDERER = Object.freeze({
  addRect() {}, addLine() {}, addTriangle() {}, addRibbon() {},
  clear() {}, render() {}, dispose() {},
  hasInstances() { return false; },
  instances: Object.freeze([]),
  getStats() { return { rectangles: 0, triangles: 0, lines: 0, totalPolygons: 0 }; },
});
