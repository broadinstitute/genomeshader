// WebGPU: Instanced cubic Bezier ribbon renderer (Sankey ribbons)
// ------------------------------------------------------------
class BezierRibbonRenderer {
  constructor(webgpuCore, opts = {}) {
    this.core = webgpuCore;
    this.device = webgpuCore.device;

    this.segments = Math.max(8, Math.min(128, opts.segments ?? 40)); // smooth, not too heavy
    this.pipeline = null;
    this.bindGroup = null;

    this.instances = [];
    this.instanceBuffer = null;

    this._init();
  }

  clear() {
    this.instances.length = 0;
  }

  // Instance layout (Float32):
  // topP0.xy topP1.xy topP2.xy topP3.xy  (8 floats)
  // botP0.xy botP1.xy botP2.xy botP3.xy  (8 floats)
  // color.rgba (4 floats)
  addRibbon(topP0, topP1, topP2, topP3, botP0, botP1, botP2, botP3, colorRgba) {
    // Basic validity guard
    if (!isFinite(topP0[0]) || !isFinite(topP0[1]) || !isFinite(topP3[0]) || !isFinite(topP3[1])) return;
    if (!isFinite(botP0[0]) || !isFinite(botP0[1]) || !isFinite(botP3[0]) || !isFinite(botP3[1])) return;

    this.instances.push({
      topP0, topP1, topP2, topP3,
      botP0, botP1, botP2, botP3,
      color: colorRgba,
    });
  }

  _init() {
    const wgsl = `
      struct Uniforms {
        projection: mat4x4<f32>,
        screenSize: vec2<f32>,
        _pad: vec2<f32>,
      };
      @group(0) @binding(0) var<uniform> uniforms: Uniforms;

      struct VSOut {
        @builtin(position) position: vec4<f32>,
        @location(0) color: vec4<f32>,
      };

      fn bezier(p0: vec2<f32>, p1: vec2<f32>, p2: vec2<f32>, p3: vec2<f32>, t: f32) -> vec2<f32> {
        let omt = 1.0 - t;
        return (omt*omt*omt)*p0 +
               (3.0*omt*omt*t)*p1 +
               (3.0*omt*t*t)*p2 +
               (t*t*t)*p3;
      }

      @vertex
      fn vs_main(
        @builtin(vertex_index) vid: u32,
        @builtin(instance_index) iid: u32,

        // Top boundary control points
        @location(0) topP0: vec2<f32>,
        @location(1) topP1: vec2<f32>,
        @location(2) topP2: vec2<f32>,
        @location(3) topP3: vec2<f32>,

        // Bottom boundary control points
        @location(4) botP0: vec2<f32>,
        @location(5) botP1: vec2<f32>,
        @location(6) botP2: vec2<f32>,
        @location(7) botP3: vec2<f32>,

        // Premultiplied-alpha color is done in FS
        @location(8) color: vec4<f32>,
      ) -> VSOut {
        // Triangle strip: for each segment s, emit [top(s), bottom(s)]
        // vid: 0 top(0), 1 bot(0), 2 top(1), 3 bot(1), ...
        let side: u32 = vid & 1u;         // 0 = top, 1 = bottom
        let s: u32 = vid >> 1u;           // segment index
        let denom: f32 = f32(${this.segments - 1});
        let t: f32 = select(0.0, f32(s) / denom, denom > 0.0);

        var p: vec2<f32>;
        if (side == 0u) {
          p = bezier(topP0, topP1, topP2, topP3, t);
        } else {
          p = bezier(botP0, botP1, botP2, botP3, t);
        }

        var out: VSOut;
        out.position = uniforms.projection * vec4<f32>(p, 0.0, 1.0);
        out.color = color;
        return out;
      }

      @fragment
      fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
        // premultiply for correct blending
        let a = in.color.a;
        return vec4<f32>(in.color.rgb * a, a);
      }
    `;

    const module = this.device.createShaderModule({ code: wgsl });

    this.pipeline = this.device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module,
        entryPoint: "vs_main",
        buffers: [
          {
            stepMode: "instance",
            arrayStride: (8 + 8 + 4) * 4, // 20 floats
            attributes: [
              { shaderLocation: 0, offset:  0 * 4, format: "float32x2" }, // topP0
              { shaderLocation: 1, offset:  2 * 4, format: "float32x2" }, // topP1
              { shaderLocation: 2, offset:  4 * 4, format: "float32x2" }, // topP2
              { shaderLocation: 3, offset:  6 * 4, format: "float32x2" }, // topP3

              { shaderLocation: 4, offset:  8 * 4, format: "float32x2" }, // botP0
              { shaderLocation: 5, offset: 10 * 4, format: "float32x2" }, // botP1
              { shaderLocation: 6, offset: 12 * 4, format: "float32x2" }, // botP2
              { shaderLocation: 7, offset: 14 * 4, format: "float32x2" }, // botP3

              { shaderLocation: 8, offset: 16 * 4, format: "float32x4" }, // color
            ],
          },
        ],
      },
      fragment: {
        module,
        entryPoint: "fs_main",
        targets: [{
          format: this.core.format,
          blend: {
            color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
          },
        }],
      },
      primitive: { topology: "triangle-strip" },
    });

    this.bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.core.projectionBuffer } }],
    });
  }

  _ensureInstanceBuffer() {
    const neededFloats = this.instances.length * 20;
    const neededBytes = neededFloats * 4;
    if (!this.instanceBuffer || this.instanceBuffer.size < neededBytes) {
      // Over-allocate a bit to reduce realloc churn
      const allocBytes = Math.max(neededBytes, (this.instanceBuffer?.size ?? 0) * 2, 64 * 1024);
      this.instanceBuffer = this.device.createBuffer({
        size: allocBytes,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }
  }

  render(encoder, renderPass) {
    if (!this.pipeline || this.instances.length === 0) return;

    this._ensureInstanceBuffer();

    // Pack instances -> Float32Array
    const data = new Float32Array(this.instances.length * 20);
    let o = 0;
    for (const inst of this.instances) {
      const push2 = (p) => { data[o++] = p[0]; data[o++] = p[1]; };
      push2(inst.topP0); push2(inst.topP1); push2(inst.topP2); push2(inst.topP3);
      push2(inst.botP0); push2(inst.botP1); push2(inst.botP2); push2(inst.botP3);
      data[o++] = inst.color[0]; data[o++] = inst.color[1]; data[o++] = inst.color[2]; data[o++] = inst.color[3];
    }

    this.device.queue.writeBuffer(this.instanceBuffer, 0, data);

    renderPass.setPipeline(this.pipeline);
    renderPass.setBindGroup(0, this.bindGroup);
    renderPass.setVertexBuffer(0, this.instanceBuffer);

    const vertexCount = this.segments * 2;
    renderPass.draw(vertexCount, this.instances.length, 0, 0);
  }
}
