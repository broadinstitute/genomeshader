// Text Renderer - Canvas 2D text to WebGPU texture rendering
import { WebGPUCore } from './webgpu-core.js';

export class TextRenderer {
    constructor(webgpuCore) {
        this.core = webgpuCore;
        this.device = webgpuCore.device;
        this.textCache = new Map(); // Cache rendered text textures
        this.canvas = document.createElement('canvas');
        this.ctx = this.canvas.getContext('2d');
        this.textInstances = [];
        this.textPipeline = null;
        this.textBuffer = null;
        this.textVertexBuffer = null;
        this.sampler = null;
        
        this.init();
    }

    init() {
        this.createTextPipeline();
        this.createSampler();
    }

    createSampler() {
        this.sampler = this.device.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
        });
    }

    createTextPipeline() {
        const vertexShader = `
            struct Uniforms {
                projection: mat4x4<f32>,
            }
            @group(0) @binding(0) var<uniform> uniforms: Uniforms;

            @group(1) @binding(0) var texture: texture_2d<f32>;
            @group(1) @binding(1) var texSampler: sampler;

            struct VertexOutput {
                @builtin(position) position: vec4<f32>,
                @location(0) uv: vec2<f32>,
            }

            @vertex
            fn vs_main(
                @builtin(vertex_index) vertexIndex: u32,
                @builtin(instance_index) instanceIndex: u32,
                @location(0) position: vec2<f32>,
                @location(1) size: vec2<f32>,
                @location(2) texCoord: vec2<f32>,
                @location(3) texSize: vec2<f32>
            ) -> VertexOutput {
                // Quad vertices: (-0.5, -0.5), (0.5, -0.5), (-0.5, 0.5), (0.5, 0.5)
                var quadPos = vec2<f32>(0.0);
                var quadUV = vec2<f32>(0.0);
                if (vertexIndex == 0u) {
                    quadPos = vec2<f32>(-0.5, -0.5);
                    quadUV = vec2<f32>(0.0, 1.0);
                } else if (vertexIndex == 1u) {
                    quadPos = vec2<f32>(0.5, -0.5);
                    quadUV = vec2<f32>(1.0, 1.0);
                } else if (vertexIndex == 2u) {
                    quadPos = vec2<f32>(-0.5, 0.5);
                    quadUV = vec2<f32>(0.0, 0.0);
                } else {
                    quadPos = vec2<f32>(0.5, 0.5);
                    quadUV = vec2<f32>(1.0, 0.0);
                }
                
                var worldPos = position + quadPos * size;
                var uv = texCoord + quadUV * texSize;
                
                var output: VertexOutput;
                output.position = uniforms.projection * vec4<f32>(worldPos, 0.0, 1.0);
                output.uv = uv;
                return output;
            }
        `;

        const fragmentShader = `
            @group(1) @binding(0) var texture: texture_2d<f32>;
            @group(1) @binding(1) var texSampler: sampler;

            @fragment
            fn fs_main(
                @location(0) uv: vec2<f32>
            ) -> @location(0) vec4<f32> {
                return textureSample(texture, texSampler, uv);
            }
        `;

        const vertexModule = this.device.createShaderModule({ code: vertexShader });
        const fragmentModule = this.device.createShaderModule({ code: fragmentShader });

        this.textPipeline = this.device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module: vertexModule,
                entryPoint: 'vs_main',
                buffers: [
                    {
                        arrayStride: 8 * 4, // position(8) + size(8) + texCoord(8) + texSize(8) = 32 bytes
                        stepMode: 'instance',
                        attributes: [
                            { shaderLocation: 0, offset: 0, format: 'float32x2' }, // position
                            { shaderLocation: 1, offset: 8, format: 'float32x2' }, // size
                            { shaderLocation: 2, offset: 16, format: 'float32x2' }, // texCoord
                            { shaderLocation: 3, offset: 24, format: 'float32x2' }, // texSize
                        ],
                    },
                ],
            },
            fragment: {
                module: fragmentModule,
                entryPoint: 'fs_main',
                targets: [{ format: this.core.format }],
            },
            primitive: {
                topology: 'triangle-strip',
            },
        });
    }

    // Render text to texture and cache it
    async renderTextToTexture(text, style = {}) {
        const cacheKey = `${text}_${JSON.stringify(style)}`;
        
        if (this.textCache.has(cacheKey)) {
            return this.textCache.get(cacheKey);
        }

        const fontFamily = style.fontFamily || 'Helvetica';
        const fontSize = style.fontSize || 12;
        const fontWeight = style.fontWeight || 'normal';
        const fill = style.fill || '#000000';
        const align = style.align || 'left';

        // Set up canvas
        this.ctx.font = `${fontWeight} ${fontSize}px ${fontFamily}`;
        this.ctx.textAlign = align;
        this.ctx.textBaseline = 'top';
        
        // Measure text
        const metrics = this.ctx.measureText(text);
        const textWidth = Math.ceil(metrics.width);
        const textHeight = Math.ceil(fontSize * 1.2); // Add some padding
        
        this.canvas.width = textWidth;
        this.canvas.height = textHeight;
        
        // Clear and redraw
        this.ctx.clearRect(0, 0, textWidth, textHeight);
        this.ctx.font = `${fontWeight} ${fontSize}px ${fontFamily}`;
        this.ctx.textAlign = align;
        this.ctx.textBaseline = 'top';
        this.ctx.fillStyle = fill;
        this.ctx.fillText(text, 0, 0);

        // Create texture from canvas
        const imageBitmap = await createImageBitmap(this.canvas);
        const texture = this.device.createTexture({
            size: [textWidth, textHeight],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
        });

        this.device.queue.copyExternalImageToTexture(
            { source: imageBitmap },
            { texture: texture },
            [textWidth, textHeight]
        );

        const textureData = {
            texture,
            width: textWidth,
            height: textHeight,
        };

        this.textCache.set(cacheKey, textureData);
        return textureData;
    }

    // Add text instance
    async addText(x, y, text, style = {}) {
        const textureData = await this.renderTextToTexture(text, style);
        
        this.textInstances.push({
            position: [x + textureData.width / 2, y + textureData.height / 2],
            size: [textureData.width, textureData.height],
            texCoord: [0, 0],
            texSize: [1, 1],
            textureData,
        });
    }

    // Add rotated text (rotation in radians)
    async addTextRotated(x, y, text, style = {}, rotation = 0) {
        const textureData = await this.renderTextToTexture(text, style);
        
        // Calculate rotated bounding box
        const cos = Math.cos(rotation);
        const sin = Math.sin(rotation);
        const w = textureData.width;
        const h = textureData.height;
        
        // For simplicity, we'll use the bounding box of the rotated text
        const bounds = {
            width: Math.abs(w * cos) + Math.abs(h * sin),
            height: Math.abs(w * sin) + Math.abs(h * cos),
        };
        
        this.textInstances.push({
            position: [x + bounds.width / 2, y + bounds.height / 2],
            size: [bounds.width, bounds.height],
            texCoord: [0, 0],
            texSize: [1, 1],
            textureData,
            rotation,
        });
    }

    clear() {
        this.textInstances = [];
    }

    // Render all text instances
    render(encoder, renderPass) {
        if (this.textInstances.length === 0) return;

        const uniformBindGroup = this.device.createBindGroup({
            layout: this.textPipeline.getBindGroupLayout(0),
            entries: [
                {
                    binding: 0,
                    resource: {
                        buffer: this.core.projectionBuffer,
                    },
                },
            ],
        });

        // Group instances by texture to minimize texture switches
        const instancesByTexture = new Map();
        for (let i = 0; i < this.textInstances.length; i++) {
            const inst = this.textInstances[i];
            const texKey = inst.textureData.texture;
            if (!instancesByTexture.has(texKey)) {
                instancesByTexture.set(texKey, []);
            }
            instancesByTexture.get(texKey).push({ instance: inst, index: i });
        }

        // Render each texture group
        for (const [texture, instances] of instancesByTexture) {
            const instanceData = new Float32Array(instances.length * 8);
            for (let i = 0; i < instances.length; i++) {
                const inst = instances[i].instance;
                const offset = i * 8;
                instanceData[offset + 0] = inst.position[0];
                instanceData[offset + 1] = inst.position[1];
                instanceData[offset + 2] = inst.size[0];
                instanceData[offset + 3] = inst.size[1];
                instanceData[offset + 4] = inst.texCoord[0];
                instanceData[offset + 5] = inst.texCoord[1];
                instanceData[offset + 6] = inst.texSize[0];
                instanceData[offset + 7] = inst.texSize[1];
            }

            if (!this.textBuffer || this.textBuffer.size < instanceData.byteLength) {
                if (this.textBuffer) this.textBuffer.destroy();
                this.textBuffer = this.device.createBuffer({
                    size: instanceData.byteLength,
                    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
                });
            }

            this.device.queue.writeBuffer(this.textBuffer, 0, instanceData);

            const textureBindGroup = this.device.createBindGroup({
                layout: this.textPipeline.getBindGroupLayout(1),
                entries: [
                    {
                        binding: 0,
                        resource: texture.createView(),
                    },
                    {
                        binding: 1,
                        resource: this.sampler,
                    },
                ],
            });

            renderPass.setPipeline(this.textPipeline);
            renderPass.setBindGroup(0, uniformBindGroup);
            renderPass.setBindGroup(1, textureBindGroup);
            renderPass.setVertexBuffer(0, this.textBuffer);
            renderPass.draw(4, instances.length); // 4 vertices per quad
        }
    }
}

