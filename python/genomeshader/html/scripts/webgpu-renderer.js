class InstancedRenderer {
  constructor(webgpuCore) {
    this.core = webgpuCore;
    this.device = webgpuCore.device;
    
    // Rectangle rendering
    this.rectPipeline = null;
    this.rectInstances = [];
    this.rectBuffer = null;
    this.rectVertexBuffer = null;
    
    // Triangle rendering
    this.trianglePipeline = null;
    this.triangleInstances = [];
    this.triangleBuffer = null;
    this.triangleVertexBuffer = null;
    
    // Line rendering
    this.linePipeline = null;
    this.lineInstances = [];
    this.lineBuffer = null;
    
    this.init();
  }

  init() {
    this.createRectPipeline();
    this.createTrianglePipeline();
    this.createLinePipeline();
    this.createGeometryBuffers();
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

  // Add rectangle instance
  // color can be: hex string (e.g., "#FF0000"), hex number, or rgba array [r, g, b, a]
  addRect(x, y, width, height, color, alpha = 1.0) {
    let rgba;
    if (Array.isArray(color) && color.length >= 3) {
      // Already an rgba array
      rgba = color.length === 4 ? color : [...color, alpha];
    } else {
      // Convert hex to rgba
      rgba = this.hexToRgba(color, alpha);
    }
    this.rectInstances.push({
      position: [x + width / 2, y + height / 2], // center position
      size: [width, height],
      color: rgba,
    });
  }

  // Add triangle instance
  addTriangle(x0, y0, x1, y1, x2, y2, color, alpha = 1.0) {
    const rgba = this.hexToRgba(color, alpha);
    this.triangleInstances.push({
      v0: [x0, y0],
      v1: [x1, y1],
      v2: [x2, y2],
      color: rgba,
    });
  }

  // Add line instance
  addLine(x0, y0, x1, y1, color, alpha = 1.0) {
    const rgba = this.hexToRgba(color, alpha);
    this.lineInstances.push({
      start: [x0, y0],
      end: [x1, y1],
      color: rgba,
    });
  }

  // Clear all instances
  clear() {
    this.rectInstances = [];
    this.triangleInstances = [];
    this.lineInstances = [];
  }

  // Render all instances
  render(encoder, renderPass) {
    // Create uniform bind group (same layout for all pipelines)
    const uniformBindGroupLayout = this.rectPipeline.getBindGroupLayout(0);
    const uniformBindGroup = this.device.createBindGroup({
      layout: uniformBindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: {
            buffer: this.core.projectionBuffer,
          },
        },
      ],
    });

    // Render rectangles
    if (this.rectInstances.length > 0) {
      const instanceData = new Float32Array(this.rectInstances.length * 8);
      for (let i = 0; i < this.rectInstances.length; i++) {
        const inst = this.rectInstances[i];
        const offset = i * 8;
        instanceData[offset + 0] = inst.position[0];
        instanceData[offset + 1] = inst.position[1];
        instanceData[offset + 2] = inst.size[0];
        instanceData[offset + 3] = inst.size[1];
        instanceData[offset + 4] = inst.color[0];
        instanceData[offset + 5] = inst.color[1];
        instanceData[offset + 6] = inst.color[2];
        instanceData[offset + 7] = inst.color[3];
      }

      if (!this.rectBuffer || this.rectBuffer.size < instanceData.byteLength) {
        if (this.rectBuffer) this.rectBuffer.destroy();
        this.rectBuffer = this.device.createBuffer({
          size: instanceData.byteLength,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
      }

      this.device.queue.writeBuffer(this.rectBuffer, 0, instanceData);

      renderPass.setPipeline(this.rectPipeline);
      renderPass.setBindGroup(0, uniformBindGroup);
      renderPass.setVertexBuffer(0, this.rectBuffer);
      renderPass.draw(4, this.rectInstances.length); // 4 vertices per quad
    }

    // Render triangles
    if (this.triangleInstances.length > 0) {
      // v0(2) + v1(2) + v2(2) + color(4) = 10 floats per instance
      const instanceData = new Float32Array(this.triangleInstances.length * 10);
      for (let i = 0; i < this.triangleInstances.length; i++) {
        const inst = this.triangleInstances[i];
        const offset = i * 10;
        instanceData[offset + 0] = inst.v0[0];
        instanceData[offset + 1] = inst.v0[1];
        instanceData[offset + 2] = inst.v1[0];
        instanceData[offset + 3] = inst.v1[1];
        instanceData[offset + 4] = inst.v2[0];
        instanceData[offset + 5] = inst.v2[1];
        instanceData[offset + 6] = inst.color[0];
        instanceData[offset + 7] = inst.color[1];
        instanceData[offset + 8] = inst.color[2];
        instanceData[offset + 9] = inst.color[3];
      }

      if (!this.triangleBuffer || this.triangleBuffer.size < instanceData.byteLength) {
        if (this.triangleBuffer) this.triangleBuffer.destroy();
        this.triangleBuffer = this.device.createBuffer({
          size: instanceData.byteLength,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
      }

      this.device.queue.writeBuffer(this.triangleBuffer, 0, instanceData);

      const triangleUniformBindGroup = this.device.createBindGroup({
        layout: this.trianglePipeline.getBindGroupLayout(0),
        entries: [
          {
            binding: 0,
            resource: {
              buffer: this.core.projectionBuffer,
            },
          },
        ],
      });
      
      renderPass.setPipeline(this.trianglePipeline);
      renderPass.setBindGroup(0, triangleUniformBindGroup);
      renderPass.setVertexBuffer(0, this.triangleBuffer);
      renderPass.draw(3, this.triangleInstances.length); // 3 vertices per triangle
    }

    // Render lines
    if (this.lineInstances.length > 0) {
      const instanceData = new Float32Array(this.lineInstances.length * 8);
      for (let i = 0; i < this.lineInstances.length; i++) {
        const inst = this.lineInstances[i];
        const offset = i * 8;
        instanceData[offset + 0] = inst.start[0];
        instanceData[offset + 1] = inst.start[1];
        instanceData[offset + 2] = inst.end[0];
        instanceData[offset + 3] = inst.end[1];
        instanceData[offset + 4] = inst.color[0];
        instanceData[offset + 5] = inst.color[1];
        instanceData[offset + 6] = inst.color[2];
        instanceData[offset + 7] = inst.color[3];
      }

      if (!this.lineBuffer || this.lineBuffer.size < instanceData.byteLength) {
        if (this.lineBuffer) this.lineBuffer.destroy();
        this.lineBuffer = this.device.createBuffer({
          size: instanceData.byteLength,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
      }

      this.device.queue.writeBuffer(this.lineBuffer, 0, instanceData);

      const lineUniformBindGroup = this.device.createBindGroup({
        layout: this.linePipeline.getBindGroupLayout(0),
        entries: [
          {
            binding: 0,
            resource: {
              buffer: this.core.projectionBuffer,
            },
          },
        ],
      });
      
      renderPass.setPipeline(this.linePipeline);
      renderPass.setBindGroup(0, lineUniformBindGroup);
      renderPass.setVertexBuffer(0, this.lineBuffer);
      renderPass.draw(2, this.lineInstances.length); // 2 vertices per line
    }
  }

  // Get rendering statistics
  getStats() {
    return {
      rectangles: this.rectInstances.length,
      triangles: this.triangleInstances.length,
      lines: this.lineInstances.length,
      totalPolygons: this.rectInstances.length + this.triangleInstances.length + this.lineInstances.length,
    };
  }
}
