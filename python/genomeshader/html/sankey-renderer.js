// Sankey Renderer - WebGPU rendering for Sankey diagrams
import { WebGPUCore } from './webgpu-core.js';

export class SankeyRenderer {
    constructor(webgpuCore) {
        this.core = webgpuCore;
        this.device = webgpuCore.device;
        
        // Node rendering
        this.nodePipeline = null;
        this.nodeInstances = [];
        this.nodeBuffer = null;
        
        // Edge rendering (curved bezier paths)
        this.edgePipeline = null;
        this.edgeInstances = [];
        this.edgeBuffer = null;
        this.edgeVertexBuffer = null; // For bezier curve vertices
        
        // Ruler rendering
        this.rulerPipeline = null;
        this.rulerInstances = [];
        this.rulerBuffer = null;
        this.rulerHeight = 60; // Height reserved for ruler
        
        // Data
        this.variants = [];
        this.edges = [];
        this.samples = {};
        this.referenceRange = { start: 0, end: 0 };
        
        // Layout state
        this.nodePositions = []; // X, Y positions for each node
        this.edgeControlPoints = []; // Control points for bezier curves
        this.positioningMode = 'variants_only'; // 'full' or 'variants_only'
        
        // Pan and zoom state
        this.panX = 0;
        this.panY = 0;
        this.zoom = 1.0;
        
        // Force simulation state
        this.forceSimulation = {
            running: false,
            iteration: 0,
            maxIterations: 100,
        };
        
        this.init();
    }

    init() {
        this.createNodePipeline();
        this.createEdgePipeline();
        this.createRulerPipeline();
    }

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
            const r = ((hex >> 16) & 0xFF) / 255;
            const g = ((hex >> 8) & 0xFF) / 255;
            const b = (hex & 0xFF) / 255;
            return [r, g, b, alpha];
        }
    }

    createNodePipeline() {
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
                var output: VertexOutput;
                output.position = uniforms.projection * vec4<f32>(worldPos, 0.0, 1.0);
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

        this.nodePipeline = this.device.createRenderPipeline({
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
                targets: [{ format: this.core.format }],
            },
            primitive: {
                topology: 'triangle-strip',
            },
        });
    }

    createEdgePipeline() {
        // Ribbon-style edges: filled bands using bezier curves
        // Each edge will be rendered as a filled ribbon using triangle strips
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
                @location(2) control1: vec2<f32>,
                @location(3) control2: vec2<f32>,
                @location(4) width: f32,
                @location(5) color: vec4<f32>
            ) -> VertexOutput {
                // Generate vertices along bezier curve for triangle strip
                // We need 20 vertices (10 segments * 2 vertices per segment)
                // vertexIndex goes from 0 to 19
                var segmentIndex = vertexIndex / 2u; // Which segment (0-9)
                var side = vertexIndex % 2u; // Which side of the strip (0 or 1)
                
                var t = f32(segmentIndex) / 10.0;
                if (segmentIndex == 9u) {
                    t = 1.0; // Ensure we reach the end
                }
                t = clamp(t, 0.0, 1.0);
                
                // Cubic bezier: (1-t)^3*P0 + 3*(1-t)^2*t*P1 + 3*(1-t)*t^2*P2 + t^3*P3
                var oneMinusT = 1.0 - t;
                var t2 = t * t;
                var t3 = t2 * t;
                var omt2 = oneMinusT * oneMinusT;
                var omt3 = omt2 * oneMinusT;
                
                var pos = omt3 * start + 3.0 * omt2 * t * control1 + 3.0 * oneMinusT * t2 * control2 + t3 * end;
                
                // Calculate perpendicular direction for width
                var tangent = 3.0 * omt2 * (control1 - start) + 6.0 * oneMinusT * t * (control2 - control1) + 3.0 * t2 * (end - control2);
                var tangentLen = length(tangent);
                var perp = vec2<f32>(-tangent.y, tangent.x);
                if (tangentLen > 0.001) {
                    perp = perp / tangentLen;
                } else {
                    perp = vec2<f32>(0.0, 1.0);
                }
                
                // Offset by half width perpendicular to curve
                var offset = perp * width * 0.5;
                if (side == 1u) {
                    offset = -offset;
                }
                
                var output: VertexOutput;
                output.position = uniforms.projection * vec4<f32>(pos + offset, 0.0, 1.0);
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

        this.edgePipeline = this.device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module: vertexModule,
                entryPoint: 'vs_main',
                buffers: [
                    {
                        arrayStride: 13 * 4, // start(8) + end(8) + control1(8) + control2(8) + width(4) + color(16) = 52 bytes
                        stepMode: 'instance',
                        attributes: [
                            { shaderLocation: 0, offset: 0, format: 'float32x2' }, // start
                            { shaderLocation: 1, offset: 8, format: 'float32x2' }, // end
                            { shaderLocation: 2, offset: 16, format: 'float32x2' }, // control1
                            { shaderLocation: 3, offset: 24, format: 'float32x2' }, // control2
                            { shaderLocation: 4, offset: 32, format: 'float32' }, // width
                            { shaderLocation: 5, offset: 36, format: 'float32x4' }, // color
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

    createRulerPipeline() {
        // Simple line rendering for ruler axis and ticks
        const vertexShader = `
            struct Uniforms {
                projection: mat4x4<f32>,
            }
            @group(0) @binding(0) var<uniform> uniforms: Uniforms;

            struct VertexOutput {
                @builtin(position) position: vec4<f32>,
                @location(0) @interpolate(flat) color: vec4<f32>,
            }

            @vertex
            fn vs_main(
                @builtin(vertex_index) vertexIndex: u32,
                @builtin(instance_index) instanceIndex: u32,
                @location(0) start: vec2<f32>,
                @location(1) end: vec2<f32>,
                @location(2) color: vec4<f32>
            ) -> VertexOutput {
                var pos = vec2<f32>(0.0);
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
                @location(0) @interpolate(flat) color: vec4<f32>
            ) -> @location(0) vec4<f32> {
                return color;
            }
        `;

        const vertexModule = this.device.createShaderModule({ code: vertexShader });
        const fragmentModule = this.device.createShaderModule({ code: fragmentShader });

        this.rulerPipeline = this.device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module: vertexModule,
                entryPoint: 'vs_main',
                buffers: [
                    {
                        arrayStride: 32, // start(8) + end(8) + color(16) = 32 bytes
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
                targets: [{ format: this.core.format }],
            },
            primitive: {
                topology: 'line-list',
            },
        });
    }

    setData(variants, edges, samples, referenceRange) {
        this.variants = variants;
        this.edges = edges;
        this.samples = samples;
        this.referenceRange = referenceRange;
        
        // Initialize node positions
        this.updateNodePositions();
        
        // Initialize edge control points
        this.initializeEdgeControlPoints();
    }

    setPositioningMode(mode) {
        if (mode !== 'full' && mode !== 'variants_only') {
            console.warn(`Invalid positioning mode: ${mode}. Using 'variants_only'.`);
            mode = 'variants_only';
        }
        this.positioningMode = mode;
        this.updateNodePositions();
        this.initializeEdgeControlPoints();
    }

    updateNodePositions() {
        const canvas = this.core.canvas;
        const canvasWidth = canvas.clientWidth;
        const canvasHeight = canvas.clientHeight;
        
        this.nodePositions = [];
        
        if (this.variants.length === 0) return;
        
        // Reserve space for ruler at top
        const nodeAreaStartY = this.rulerHeight + 20;
        const nodeAreaHeight = canvasHeight - nodeAreaStartY - 20;
        
        // Always use genomic position for X coordinates
        const range = this.referenceRange.end - this.referenceRange.start;
        if (range === 0) return;
        
        // Calculate X positions based on genomic position
        const padding = 50;
        const availableWidth = canvasWidth - 2 * padding;
        
        // Create array of variants with their X positions
        const variantPositions = [];
        for (let i = 0; i < this.variants.length; i++) {
            const variant = this.variants[i];
            const relativePos = (variant.position - this.referenceRange.start) / range;
            const x = padding + relativePos * availableWidth;
            variantPositions.push({
                index: i,
                variant: variant,
                x: x,
            });
        }
        
        // Sort by X position
        variantPositions.sort((a, b) => a.x - b.x);
        
        // Stack nodes vertically when they overlap
        const nodeWidth = 6; // Fixed width for rectangular nodes
        const nodeHeight = 25; // Fixed height for nodes
        const laneSpacing = nodeHeight + 5; // Spacing between lanes
        
        // Track lane usage - for each X position, track which lanes are occupied
        const lanes = []; // Array of arrays, each sub-array contains occupied X ranges for that lane
        
        for (const vp of variantPositions) {
            const nodeLeft = vp.x - nodeWidth / 2;
            const nodeRight = vp.x + nodeWidth / 2;
            
            // Find first available lane where this node doesn't overlap
            let assignedLane = -1;
            for (let laneIdx = 0; laneIdx < lanes.length; laneIdx++) {
                const lane = lanes[laneIdx];
                let overlaps = false;
                
                // Check if this node overlaps with any node in this lane
                for (const occupiedRange of lane) {
                    if (!(nodeRight < occupiedRange.left || nodeLeft > occupiedRange.right)) {
                        overlaps = true;
                        break;
                    }
                }
                
                if (!overlaps) {
                    assignedLane = laneIdx;
                    break;
                }
            }
            
            // If no lane available, create a new one
            if (assignedLane === -1) {
                assignedLane = lanes.length;
                lanes.push([]);
            }
            
            // Add this node's range to the lane
            lanes[assignedLane].push({ left: nodeLeft, right: nodeRight });
            
            // Calculate Y position based on lane
            const y = nodeAreaStartY + (assignedLane * laneSpacing) + (nodeHeight / 2);
            
            // Store position (using original index)
            this.nodePositions[vp.index] = { x: vp.x, y: y, lane: assignedLane };
        }
    }

    initializeEdgeControlPoints() {
        // Initialize control points for bezier curves
        // Control points will be adjusted by force simulation
        this.edgeControlPoints = [];
        
        for (const edge of this.edges) {
            const sourcePos = this.nodePositions[edge.source];
            const targetPos = this.nodePositions[edge.target];
            
            if (!sourcePos || !targetPos) continue;
            
            // Initial control points - positioned to create a smooth curve
            const dx = targetPos.x - sourcePos.x;
            const dy = targetPos.y - sourcePos.y;
            const midX = (sourcePos.x + targetPos.x) / 2;
            const midY = (sourcePos.y + targetPos.y) / 2;
            
            // Control points offset perpendicular to the line
            const perpOffset = 30; // Base offset
            const control1 = {
                x: midX - perpOffset,
                y: sourcePos.y + dy * 0.3,
            };
            const control2 = {
                x: midX + perpOffset,
                y: targetPos.y - dy * 0.3,
            };
            
            this.edgeControlPoints.push({
                control1,
                control2,
                group: this.getEdgeGroup(edge),
            });
        }
    }

    getEdgeGroup(edge) {
        // Get the primary group for this edge (most common sample group)
        if (!edge.sample_groups || Object.keys(edge.sample_groups).length === 0) {
            return 0;
        }
        
        let maxCount = 0;
        let primaryGroup = 0;
        for (const [group, samples] of Object.entries(edge.sample_groups)) {
            if (samples.length > maxCount) {
                maxCount = samples.length;
                primaryGroup = parseInt(group);
            }
        }
        return primaryGroup;
    }

    addRulerLine(startX, startY, endX, endY, color, alpha = 1.0) {
        const rgba = this.hexToRgba(color, alpha);
        this.rulerInstances.push({
            start: [startX, startY],
            end: [endX, endY],
            color: rgba,
        });
    }

    renderRuler(encoder, renderPass, textRenderer) {
        this.rulerInstances = [];
        
        const canvas = this.core.canvas;
        const canvasWidth = canvas.clientWidth;
        const rulerY = this.rulerHeight - 10; // Position of main axis line (fixed, doesn't pan/zoom)
        
        // Calculate visible genomic range based on pan/zoom (only horizontal)
        const range = this.referenceRange.end - this.referenceRange.start;
        if (range === 0) return;
        
        // Calculate visible X range in canvas coordinates
        const visibleStartX = -this.panX / this.zoom;
        const visibleEndX = (canvasWidth - this.panX) / this.zoom;
        
        // Convert to genomic positions
        const pixelsPerBase = (canvasWidth / this.zoom) / range;
        const visibleStartPos = this.referenceRange.start + (visibleStartX / pixelsPerBase);
        const visibleEndPos = this.referenceRange.start + (visibleEndX / pixelsPerBase);
        
        // Draw main axis line (fixed Y position)
        this.addRulerLine(0, rulerY, canvasWidth, rulerY, 0x000000, 1.0);
        
        // Calculate tick intervals (adaptive based on zoom)
        const visibleRange = visibleEndPos - visibleStartPos;
        let tickInterval = 1;
        if (visibleRange > 1000000) {
            tickInterval = 100000;
        } else if (visibleRange > 100000) {
            tickInterval = 10000;
        } else if (visibleRange > 10000) {
            tickInterval = 1000;
        } else if (visibleRange > 1000) {
            tickInterval = 100;
        } else if (visibleRange > 100) {
            tickInterval = 10;
        } else {
            tickInterval = 1;
        }
        
        // Round start position to nearest tick
        const firstTick = Math.ceil(visibleStartPos / tickInterval) * tickInterval;
        
        // Draw ticks (labels are handled separately in Python code)
        for (let pos = firstTick; pos <= visibleEndPos; pos += tickInterval) {
            const x = ((pos - this.referenceRange.start) * pixelsPerBase * this.zoom) + this.panX;
            
            if (x < 0 || x > canvasWidth) continue;
            
            // Major tick (every 5th tick)
            const isMajorTick = (pos / tickInterval) % 5 === 0;
            const tickHeight = isMajorTick ? 15 : 8;
            
            this.addRulerLine(x, rulerY, x, rulerY - tickHeight, 0x000000, 1.0);
        }
        
        // Render ruler lines
        if (this.rulerInstances.length > 0) {
            const instanceData = new Float32Array(this.rulerInstances.length * 6);
            for (let i = 0; i < this.rulerInstances.length; i++) {
                const inst = this.rulerInstances[i];
                const offset = i * 6;
                instanceData[offset + 0] = inst.start[0];
                instanceData[offset + 1] = inst.start[1];
                instanceData[offset + 2] = inst.end[0];
                instanceData[offset + 3] = inst.end[1];
                instanceData[offset + 4] = inst.color[0];
                instanceData[offset + 5] = inst.color[1];
                instanceData[offset + 6] = inst.color[2];
                instanceData[offset + 7] = inst.color[3];
            }
            
            // Fix the array size - we need 8 floats per instance
            const correctedData = new Float32Array(this.rulerInstances.length * 8);
            for (let i = 0; i < this.rulerInstances.length; i++) {
                const inst = this.rulerInstances[i];
                const offset = i * 8;
                correctedData[offset + 0] = inst.start[0];
                correctedData[offset + 1] = inst.start[1];
                correctedData[offset + 2] = inst.end[0];
                correctedData[offset + 3] = inst.end[1];
                correctedData[offset + 4] = inst.color[0];
                correctedData[offset + 5] = inst.color[1];
                correctedData[offset + 6] = inst.color[2];
                correctedData[offset + 7] = inst.color[3];
            }
            
            if (!this.rulerBuffer || this.rulerBuffer.size < correctedData.byteLength) {
                if (this.rulerBuffer) this.rulerBuffer.destroy();
                this.rulerBuffer = this.device.createBuffer({
                    size: correctedData.byteLength,
                    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
                });
            }
            
            this.device.queue.writeBuffer(this.rulerBuffer, 0, correctedData);
            
            const uniformBindGroup = this.device.createBindGroup({
                layout: this.rulerPipeline.getBindGroupLayout(0),
                entries: [
                    {
                        binding: 0,
                        resource: {
                            buffer: this.core.projectionBuffer,
                        },
                    },
                ],
            });
            
            renderPass.setPipeline(this.rulerPipeline);
            renderPass.setBindGroup(0, uniformBindGroup);
            renderPass.setVertexBuffer(0, this.rulerBuffer);
            renderPass.draw(2, this.rulerInstances.length); // 2 vertices per line
        }
    }

    updateForceSimulation() {
        if (!this.forceSimulation.running) return;
        
        // Simple force-directed layout for edge bundling
        // Edges from the same group attract their control points
        const attractionStrength = 0.01;
        const repulsionStrength = 0.005;
        const damping = 0.9;
        
        // Update control points based on forces
        for (let i = 0; i < this.edgeControlPoints.length; i++) {
            const cp = this.edgeControlPoints[i];
            let fx1 = 0, fy1 = 0, fx2 = 0, fy2 = 0;
            
            // Attraction to edges in same group
            for (let j = 0; j < this.edgeControlPoints.length; j++) {
                if (i === j) continue;
                const other = this.edgeControlPoints[j];
                
                if (cp.group === other.group) {
                    // Attract control points from same group
                    const dx1 = other.control1.x - cp.control1.x;
                    const dy1 = other.control1.y - cp.control1.y;
                    const dist1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
                    if (dist1 > 0) {
                        fx1 += (dx1 / dist1) * attractionStrength;
                        fy1 += (dy1 / dist1) * attractionStrength;
                    }
                    
                    const dx2 = other.control2.x - cp.control2.x;
                    const dy2 = other.control2.y - cp.control2.y;
                    const dist2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
                    if (dist2 > 0) {
                        fx2 += (dx2 / dist2) * attractionStrength;
                        fy2 += (dy2 / dist2) * attractionStrength;
                    }
                } else {
                    // Repulsion from edges in different groups
                    const dx1 = cp.control1.x - other.control1.x;
                    const dy1 = cp.control1.y - other.control1.y;
                    const dist1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
                    if (dist1 > 0 && dist1 < 100) {
                        fx1 += (dx1 / dist1) * repulsionStrength;
                        fy1 += (dy1 / dist1) * repulsionStrength;
                    }
                    
                    const dx2 = cp.control2.x - other.control2.x;
                    const dy2 = cp.control2.y - other.control2.y;
                    const dist2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
                    if (dist2 > 0 && dist2 < 100) {
                        fx2 += (dx2 / dist2) * repulsionStrength;
                        fy2 += (dy2 / dist2) * repulsionStrength;
                    }
                }
            }
            
            // Apply forces with damping
            cp.control1.x += fx1 * damping;
            cp.control1.y += fy1 * damping;
            cp.control2.x += fx2 * damping;
            cp.control2.y += fy2 * damping;
        }
        
        this.forceSimulation.iteration++;
        if (this.forceSimulation.iteration >= this.forceSimulation.maxIterations) {
            this.forceSimulation.running = false;
        }
    }

    clear() {
        // Don't clear here - clearing is done in individual render methods
        // This method is kept for compatibility but does nothing
    }

    addNode(x, y, width, height, color, alpha = 1.0) {
        const rgba = this.hexToRgba(color, alpha);
        this.nodeInstances.push({
            position: [x, y],
            size: [width, height],
            color: rgba,
        });
    }

    addEdge(startX, startY, endX, endY, control1X, control1Y, control2X, control2Y, width, color, alpha = 1.0) {
        const rgba = this.hexToRgba(color, alpha);
        this.edgeInstances.push({
            start: [startX, startY],
            end: [endX, endY],
            control1: [control1X, control1Y],
            control2: [control2X, control2Y],
            width: width,
            color: rgba,
        });
    }

    render(encoder, renderPass) {
        // This method now only renders edges - nodes are rendered separately
        // Clear only edge instances (nodes are cleared separately)
        this.edgeInstances = [];
        
        // Update force simulation
        this.updateForceSimulation();
        
        // Render edges (ribbons)
        for (let i = 0; i < this.edges.length; i++) {
            const edge = this.edges[i];
            const cp = this.edgeControlPoints[i];
            
            if (!cp) continue;
            
            const sourcePos = this.nodePositions[edge.source];
            const targetPos = this.nodePositions[edge.target];
            
            if (!sourcePos || !targetPos) continue;
            
            // Apply pan and zoom transform
            const sourceX = (sourcePos.x * this.zoom) + this.panX;
            const sourceY = (sourcePos.y * this.zoom) + this.panY;
            const targetX = (targetPos.x * this.zoom) + this.panX;
            const targetY = (targetPos.y * this.zoom) + this.panY;
            const control1X = (cp.control1.x * this.zoom) + this.panX;
            const control1Y = (cp.control1.y * this.zoom) + this.panY;
            const control2X = (cp.control2.x * this.zoom) + this.panX;
            const control2Y = (cp.control2.y * this.zoom) + this.panY;
            
            // Ribbon width proportional to sample count
            const baseWidth = 2;
            const maxWidth = 30;
            const width = Math.min(baseWidth + (edge.sample_count || 1) * 0.8, maxWidth) * this.zoom;
            
            // Color by group - use softer colors for ribbons
            const groupColors = [0x4A90E2, 0x50C878, 0xF5A623, 0xBD10E0, 0x9013FE];
            const groupColor = groupColors[cp.group % groupColors.length] || 0x888888;
            
            // Highlight if in highlightedEdges set
            const highlightedEdges = window.highlightedEdges || new Set();
            const isHighlighted = highlightedEdges.has(i);
            const edgeColor = isHighlighted ? 0xFF0000 : groupColor;
            const edgeAlpha = isHighlighted ? 0.9 : 0.5; // Softer alpha for ribbons
            
            // Add edge with bezier curve
            this.addEdge(
                sourceX, sourceY,
                targetX, targetY,
                control1X, control1Y,
                control2X, control2Y,
                width,
                edgeColor,
                edgeAlpha
            );
        }
        
        // Render edge instances
        if (this.edgeInstances.length > 0) {
            const instanceData = new Float32Array(this.nodeInstances.length * 8);
            for (let i = 0; i < this.nodeInstances.length; i++) {
                const inst = this.nodeInstances[i];
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

            if (!this.nodeBuffer || this.nodeBuffer.size < instanceData.byteLength) {
                if (this.nodeBuffer) this.nodeBuffer.destroy();
                this.nodeBuffer = this.device.createBuffer({
                    size: instanceData.byteLength,
                    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
                });
            }

            this.device.queue.writeBuffer(this.nodeBuffer, 0, instanceData);

            const uniformBindGroup = this.device.createBindGroup({
                layout: this.nodePipeline.getBindGroupLayout(0),
                entries: [
                    {
                        binding: 0,
                        resource: {
                            buffer: this.core.projectionBuffer,
                        },
                    },
                ],
            });

            renderPass.setPipeline(this.nodePipeline);
            renderPass.setBindGroup(0, uniformBindGroup);
            renderPass.setVertexBuffer(0, this.nodeBuffer);
            renderPass.draw(4, this.nodeInstances.length);
        }
        
        // Render edges
        if (this.edgeInstances.length > 0) {
            const instanceData = new Float32Array(this.edgeInstances.length * 12);
            for (let i = 0; i < this.edgeInstances.length; i++) {
                const inst = this.edgeInstances[i];
                const offset = i * 12;
                instanceData[offset + 0] = inst.start[0];
                instanceData[offset + 1] = inst.start[1];
                instanceData[offset + 2] = inst.end[0];
                instanceData[offset + 3] = inst.end[1];
                instanceData[offset + 4] = inst.control1[0];
                instanceData[offset + 5] = inst.control1[1];
                instanceData[offset + 6] = inst.control2[0];
                instanceData[offset + 7] = inst.control2[1];
                instanceData[offset + 8] = inst.width;
                instanceData[offset + 9] = inst.color[0];
                instanceData[offset + 10] = inst.color[1];
                instanceData[offset + 11] = inst.color[2];
                // Note: alpha is in color[3], but we're using 12 floats, need to adjust
            }
            
            // Fix: we need 13 floats (including alpha)
            const correctedData = new Float32Array(this.edgeInstances.length * 13);
            for (let i = 0; i < this.edgeInstances.length; i++) {
                const inst = this.edgeInstances[i];
                const offset = i * 13;
                correctedData[offset + 0] = inst.start[0];
                correctedData[offset + 1] = inst.start[1];
                correctedData[offset + 2] = inst.end[0];
                correctedData[offset + 3] = inst.end[1];
                correctedData[offset + 4] = inst.control1[0];
                correctedData[offset + 5] = inst.control1[1];
                correctedData[offset + 6] = inst.control2[0];
                correctedData[offset + 7] = inst.control2[1];
                correctedData[offset + 8] = inst.width;
                correctedData[offset + 9] = inst.color[0];
                correctedData[offset + 10] = inst.color[1];
                correctedData[offset + 11] = inst.color[2];
                correctedData[offset + 12] = inst.color[3];
            }

            if (!this.edgeBuffer || this.edgeBuffer.size < correctedData.byteLength) {
                if (this.edgeBuffer) this.edgeBuffer.destroy();
                this.edgeBuffer = this.device.createBuffer({
                    size: correctedData.byteLength,
                    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
                });
            }

            this.device.queue.writeBuffer(this.edgeBuffer, 0, correctedData);

            const edgeUniformBindGroup = this.device.createBindGroup({
                layout: this.edgePipeline.getBindGroupLayout(0),
                entries: [
                    {
                        binding: 0,
                        resource: {
                            buffer: this.core.projectionBuffer,
                        },
                    },
                ],
            });

            renderPass.setPipeline(this.edgePipeline);
            renderPass.setBindGroup(0, edgeUniformBindGroup);
            renderPass.setVertexBuffer(0, this.edgeBuffer);
            renderPass.draw(20, this.edgeInstances.length); // 20 vertices per bezier curve (10 segments * 2)
        }
    }

    renderNodes(encoder, renderPass) {
        // Clear node instances
        this.nodeInstances = [];
        
        // Render nodes as rectangles
        const selectedVariantIndex = window.selectedVariantIndex !== undefined ? window.selectedVariantIndex : null;
        for (let i = 0; i < this.variants.length; i++) {
            const pos = this.nodePositions[i];
            if (!pos) continue;
            
            // Rectangular nodes: narrow width, fixed height
            const nodeWidth = 6;
            const nodeHeight = 25;
            
            // Apply pan and zoom transform
            const transformedX = (pos.x * this.zoom) + this.panX;
            const transformedY = (pos.y * this.zoom) + this.panY;
            
            // Node colors: light gray with darker border, or red if selected
            const isSelected = (selectedVariantIndex !== null && selectedVariantIndex === i);
            const nodeColor = isSelected ? 0xFF0000 : 0x888888;
            const nodeAlpha = isSelected ? 1.0 : 0.8;
            
            this.addNode(transformedX, transformedY, nodeWidth * this.zoom, nodeHeight * this.zoom, nodeColor, nodeAlpha);
        }
        
        // Render node instances
        if (this.nodeInstances.length > 0) {
            const instanceData = new Float32Array(this.nodeInstances.length * 8);
            for (let i = 0; i < this.nodeInstances.length; i++) {
                const inst = this.nodeInstances[i];
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

            if (!this.nodeBuffer || this.nodeBuffer.size < instanceData.byteLength) {
                if (this.nodeBuffer) this.nodeBuffer.destroy();
                this.nodeBuffer = this.device.createBuffer({
                    size: instanceData.byteLength,
                    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
                });
            }

            this.device.queue.writeBuffer(this.nodeBuffer, 0, instanceData);

            const uniformBindGroup = this.device.createBindGroup({
                layout: this.nodePipeline.getBindGroupLayout(0),
                entries: [
                    {
                        binding: 0,
                        resource: {
                            buffer: this.core.projectionBuffer,
                        },
                    },
                ],
            });

            renderPass.setPipeline(this.nodePipeline);
            renderPass.setBindGroup(0, uniformBindGroup);
            renderPass.setVertexBuffer(0, this.nodeBuffer);
            renderPass.draw(4, this.nodeInstances.length);
        }
    }

    startForceSimulation() {
        this.forceSimulation.running = true;
        this.forceSimulation.iteration = 0;
    }

    stopForceSimulation() {
        this.forceSimulation.running = false;
    }

    setPan(x, y) {
        this.panX = x;
        this.panY = y;
    }

    setZoom(zoom) {
        this.zoom = Math.max(0.1, Math.min(5.0, zoom)); // Clamp zoom between 0.1 and 5.0
    }

    pan(deltaX, deltaY) {
        this.panX += deltaX;
        this.panY += deltaY;
    }

    zoomAt(x, y, factor) {
        const oldZoom = this.zoom;
        this.setZoom(this.zoom * factor);
        
        // Adjust pan to zoom around the point (x, y)
        const zoomChange = this.zoom / oldZoom;
        this.panX = x - (x - this.panX) * zoomChange;
        this.panY = y - (y - this.panY) * zoomChange;
    }

    getStats() {
        return {
            nodes: this.nodeInstances.length,
            edges: this.edgeInstances.length,
        };
    }
}

