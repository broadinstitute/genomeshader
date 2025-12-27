// Tube Map Renderer - WebGPU rendering for Tube Map visualization
import { WebGPUCore } from './webgpu-core.js';

export class TubemapRenderer {
    constructor(webgpuCore) {
        this.core = webgpuCore;
        this.device = webgpuCore.device;
        
        // Node rendering (Sankey nodes)
        this.nodePipeline = null;
        this.nodeInstances = [];
        this.nodeBuffer = null;
        
        // Edge rendering (ribbons)
        this.edgePipeline = null;
        this.edgeInstances = [];
        this.edgeBuffer = null;
        
        // Ruler rendering
        this.rulerPipeline = null;
        this.rulerInstances = [];
        this.rulerBuffer = null;
        
        // Connector rendering (lines from ruler to Sankey columns)
        this.connectorPipeline = null;
        this.connectorInstances = [];
        this.connectorBuffer = null;
        
        // Ideogram rendering
        this.ideogramPipeline = null;
        this.ideogramInstances = [];
        this.ideogramBuffer = null;
        
        // Gene track rendering
        this.genePipeline = null;
        this.geneInstances = [];
        this.geneBuffer = null;
        
        // Data
        this.variants = [];
        this.columns = [];
        this.flows = [];
        this.sampleGroups = [];
        this.referenceRange = { start: 0, end: 0 };
        this.ideogramData = [];
        this.geneData = [];
        
        // Layout state
        this.columnPositions = []; // X positions for each column (equidistant)
        this.nodePositions = []; // Y positions for nodes within columns
        this.leftPanelWidth = 200;
        this.columnSpacing = 100; // Space between columns
        
        // Pan and zoom state
        this.panX = 0;
        this.panY = 0;
        this.zoom = 1.0;
        
        // Viewport tracking for lazy loading
        this.visibleColumns = new Set();
        this.lastViewportStart = 0;
        this.lastViewportEnd = 0;
        
        this.init();
    }

    init() {
        this.createNodePipeline();
        this.createEdgePipeline();
        this.createRulerPipeline();
        this.createConnectorPipeline();
        this.createIdeogramPipeline();
        this.createGenePipeline();
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
                        arrayStride: 8 * 4,
                        stepMode: 'instance',
                        attributes: [
                            { shaderLocation: 0, offset: 0, format: 'float32x2' },
                            { shaderLocation: 1, offset: 8, format: 'float32x2' },
                            { shaderLocation: 2, offset: 16, format: 'float32x4' },
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
        // Same as SankeyRenderer - bezier curve ribbons
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
                var segmentIndex = vertexIndex / 2u;
                var side = vertexIndex % 2u;
                
                var t = f32(segmentIndex) / 10.0;
                if (segmentIndex == 9u) {
                    t = 1.0;
                }
                t = clamp(t, 0.0, 1.0);
                
                var oneMinusT = 1.0 - t;
                var t2 = t * t;
                var t3 = t2 * t;
                var omt2 = oneMinusT * oneMinusT;
                var omt3 = omt2 * oneMinusT;
                
                var pos = omt3 * start + 3.0 * omt2 * t * control1 + 3.0 * oneMinusT * t2 * control2 + t3 * end;
                
                var tangent = 3.0 * omt2 * (control1 - start) + 6.0 * oneMinusT * t * (control2 - control1) + 3.0 * t2 * (end - control2);
                var tangentLen = length(tangent);
                var perp = vec2<f32>(-tangent.y, tangent.x);
                if (tangentLen > 0.001) {
                    perp = perp / tangentLen;
                } else {
                    perp = vec2<f32>(0.0, 1.0);
                }
                
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
                        arrayStride: 13 * 4,
                        stepMode: 'instance',
                        attributes: [
                            { shaderLocation: 0, offset: 0, format: 'float32x2' },
                            { shaderLocation: 1, offset: 8, format: 'float32x2' },
                            { shaderLocation: 2, offset: 16, format: 'float32x2' },
                            { shaderLocation: 3, offset: 24, format: 'float32x2' },
                            { shaderLocation: 4, offset: 32, format: 'float32' },
                            { shaderLocation: 5, offset: 36, format: 'float32x4' },
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
                        arrayStride: 32,
                        stepMode: 'instance',
                        attributes: [
                            { shaderLocation: 0, offset: 0, format: 'float32x2' },
                            { shaderLocation: 1, offset: 8, format: 'float32x2' },
                            { shaderLocation: 2, offset: 16, format: 'float32x4' },
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

    createConnectorPipeline() {
        // Same as ruler pipeline - just lines
        this.connectorPipeline = this.rulerPipeline;
    }

    createIdeogramPipeline() {
        // Same as node pipeline - rectangles
        this.ideogramPipeline = this.nodePipeline;
    }

    createGenePipeline() {
        // Same as node pipeline - rectangles for genes
        this.genePipeline = this.nodePipeline;
    }

    setData(tubemapData, ideogramData, geneData) {
        this.variants = tubemapData.variants || [];
        this.columns = tubemapData.columns || [];
        this.flows = tubemapData.flows || [];
        this.sampleGroups = tubemapData.sample_groups || [];
        this.referenceRange = tubemapData.reference_range || { start: 0, end: 0 };
        this.ideogramData = ideogramData || [];
        this.geneData = geneData || [];
        
        this.updateLayout();
    }

    updateLayout() {
        const canvas = this.core.canvas;
        const canvasWidth = canvas.clientWidth - this.leftPanelWidth;
        const canvasHeight = canvas.clientHeight;
        
        // Calculate column positions (equidistant)
        this.columnPositions = [];
        if (this.columns.length > 0) {
            const totalWidth = (this.columns.length - 1) * this.columnSpacing;
            const startX = this.leftPanelWidth + (canvasWidth - totalWidth) / 2;
            
            for (let i = 0; i < this.columns.length; i++) {
                this.columnPositions.push(startX + i * this.columnSpacing);
            }
        }
        
        // Calculate node positions within columns
        this.nodePositions = [];
        const nodeHeight = 20;
        const nodeSpacing = 5;
        
        for (let colIdx = 0; colIdx < this.columns.length; colIdx++) {
            const column = this.columns[colIdx];
            const colX = this.columnPositions[colIdx];
            const nodes = column.nodes || [];
            
            // Stack nodes vertically, grouped by sample group
            let currentY = 100; // Start Y position
            const groupNodes = {};
            
            // Group nodes by sample group
            for (const node of nodes) {
                const groupIdx = node.group_index || 0;
                if (!groupNodes[groupIdx]) {
                    groupNodes[groupIdx] = [];
                }
                groupNodes[groupIdx].push(node);
            }
            
            // Position nodes
            for (const groupIdx of Object.keys(groupNodes).sort()) {
                const groupNodeList = groupNodes[groupIdx];
                for (const node of groupNodeList) {
                    this.nodePositions.push({
                        columnIndex: colIdx,
                        nodeIndex: node.index,
                        x: colX,
                        y: currentY,
                        width: 40,
                        height: nodeHeight,
                    });
                    currentY += nodeHeight + nodeSpacing;
                }
                currentY += 10; // Extra space between groups
            }
        }
    }

    render(encoder, renderPass, textRenderer) {
        // Clear instances
        this.nodeInstances = [];
        this.edgeInstances = [];
        this.rulerInstances = [];
        this.connectorInstances = [];
        this.ideogramInstances = [];
        this.geneInstances = [];
        
        // Render ideogram
        this.renderIdeogram();
        
        // Render gene track
        this.renderGenes();
        
        // Render ruler
        this.renderRuler();
        
        // Render connectors
        this.renderConnectors();
        
        // Render Sankey nodes and edges
        this.renderSankey();
        
        // Render all instances
        this.renderInstances(encoder, renderPass);
    }

    renderIdeogram() {
        // TODO: Render ideogram bands
        // For now, placeholder
    }

    renderGenes() {
        // TODO: Render gene track
        // For now, placeholder
    }

    renderRuler() {
        const canvas = this.core.canvas;
        const canvasWidth = canvas.clientWidth;
        const rulerY = 30;
        
        // Draw main axis
        this.addRulerLine(this.leftPanelWidth, rulerY, canvasWidth, rulerY, 0x000000, 1.0);
        
        // Draw ticks at variant positions
        const range = this.referenceRange.end - this.referenceRange.start;
        if (range > 0) {
            for (let i = 0; i < this.variants.length; i++) {
                const variant = this.variants[i];
                const x = this.columnPositions[i] || (this.leftPanelWidth + 100);
                
                // Draw tick
                this.addRulerLine(x, rulerY, x, rulerY - 10, 0x000000, 1.0);
            }
        }
    }

    renderConnectors() {
        // Draw lines from variant positions on ruler to Sankey columns
        // Connectors update in real-time as user scrolls
        const rulerY = 30;
        const sankeyStartY = 100;
        
        const canvas = this.core.canvas;
        const canvasWidth = canvas.clientWidth;
        const viewportStart = -this.panX / this.zoom;
        const viewportEnd = (canvasWidth - this.panX) / this.zoom;
        
        for (let i = 0; i < this.variants.length; i++) {
            const x = this.columnPositions[i] || (this.leftPanelWidth + 100);
            const transformedX = (x * this.zoom) + this.panX;
            
            // Only draw connectors for visible columns
            if (transformedX >= -50 && transformedX <= canvasWidth + 50) {
                // Draw connector line from ruler to Sankey
                this.addConnectorLine(transformedX, rulerY, transformedX, sankeyStartY, 0x888888, 0.3);
            }
        }
    }
    
    updateVisibleColumns() {
        // Update which columns are visible in viewport
        // Only update Sankey when variants enter/exit viewport
        const canvas = this.core.canvas;
        const canvasWidth = canvas.clientWidth;
        const viewportStart = -this.panX / this.zoom;
        const viewportEnd = (canvasWidth - this.panX) / this.zoom;
        
        const newVisibleColumns = new Set();
        
        for (let i = 0; i < this.columnPositions.length; i++) {
            const x = this.columnPositions[i];
            const transformedX = (x * this.zoom) + this.panX;
            
            // Column is visible if it's within viewport (with margin)
            if (transformedX >= -100 && transformedX <= canvasWidth + 100) {
                newVisibleColumns.add(i);
            }
        }
        
        // Check if visible columns changed
        const columnsChanged = 
            newVisibleColumns.size !== this.visibleColumns.size ||
            Array.from(newVisibleColumns).some(col => !this.visibleColumns.has(col));
        
        if (columnsChanged) {
            this.visibleColumns = newVisibleColumns;
            return true; // Indicates Sankey needs update
        }
        
        return false; // No update needed
    }

    renderSankey() {
        // Only render nodes and edges for visible columns
        // Render nodes
        for (const nodePos of this.nodePositions) {
            // Skip if column is not visible
            if (!this.visibleColumns.has(nodePos.columnIndex)) {
                continue;
            }
            
            const column = this.columns[nodePos.columnIndex];
            const node = column.nodes[nodePos.nodeIndex];
            
            if (!node) continue;
            
            // Color by node type
            let color = 0x888888;
            if (node.type === 'nocall') {
                color = 0xcccccc;
            } else if (node.type === 'ref') {
                color = 0x90EE90;
            } else { // alt
                color = 0x4A90E2;
            }
            
            // Apply pan/zoom
            const x = (nodePos.x * this.zoom) + this.panX;
            const y = (nodePos.y * this.zoom) + this.panY;
            
            this.addNode(x, y, nodePos.width * this.zoom, nodePos.height * this.zoom, color, 0.8);
        }
        
        // Render flows (ribbons) - only for visible columns
        for (const flow of this.flows) {
            // Skip if either source or target column is not visible
            if (!this.visibleColumns.has(flow.source_column) && 
                !this.visibleColumns.has(flow.target_column)) {
                continue;
            }
            
            const sourceCol = this.columnPositions[flow.source_column];
            const targetCol = this.columnPositions[flow.target_column];
            
            if (sourceCol === undefined || targetCol === undefined) continue;
            
            const sourceNodePos = this.nodePositions.find(np => 
                np.columnIndex === flow.source_column && np.nodeIndex === flow.source_node
            );
            const targetNodePos = this.nodePositions.find(np => 
                np.columnIndex === flow.target_column && np.nodeIndex === flow.target_node
            );
            
            if (!sourceNodePos || !targetNodePos) continue;
            
            const sourceX = (sourceCol * this.zoom) + this.panX;
            const sourceY = ((sourceNodePos.y + sourceNodePos.height / 2) * this.zoom) + this.panY;
            const targetX = (targetCol * this.zoom) + this.panX;
            const targetY = ((targetNodePos.y + targetNodePos.height / 2) * this.zoom) + this.panY;
            
            // Control points for bezier curve
            const midX = (sourceX + targetX) / 2;
            const control1X = midX - 30;
            const control1Y = sourceY;
            const control2X = midX + 30;
            const control2Y = targetY;
            
            // Width proportional to sample count
            const width = Math.min(2 + flow.sample_count * 0.5, 30) * this.zoom;
            
            // Color by group
            const groupColors = [0x4A90E2, 0x50C878, 0xF5A623, 0xBD10E0, 0x9013FE];
            const groupColor = groupColors[flow.group_index % groupColors.length] || 0x888888;
            
            this.addEdge(
                sourceX, sourceY,
                targetX, targetY,
                control1X, control1Y,
                control2X, control2Y,
                width,
                groupColor,
                0.5
            );
        }
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

    addRulerLine(startX, startY, endX, endY, color, alpha = 1.0) {
        const rgba = this.hexToRgba(color, alpha);
        this.rulerInstances.push({
            start: [startX, startY],
            end: [endX, endY],
            color: rgba,
        });
    }

    addConnectorLine(startX, startY, endX, endY, color, alpha = 1.0) {
        const rgba = this.hexToRgba(color, alpha);
        this.connectorInstances.push({
            start: [startX, startY],
            end: [endX, endY],
            color: rgba,
        });
    }

    renderInstances(encoder, renderPass) {
        // Render nodes
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
        
        // Render edges (ribbons)
        if (this.edgeInstances.length > 0) {
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
            renderPass.draw(20, this.edgeInstances.length);
        }
        
        // Render ruler lines
        if (this.rulerInstances.length > 0) {
            const rulerData = new Float32Array(this.rulerInstances.length * 8);
            for (let i = 0; i < this.rulerInstances.length; i++) {
                const inst = this.rulerInstances[i];
                const offset = i * 8;
                rulerData[offset + 0] = inst.start[0];
                rulerData[offset + 1] = inst.start[1];
                rulerData[offset + 2] = inst.end[0];
                rulerData[offset + 3] = inst.end[1];
                rulerData[offset + 4] = inst.color[0];
                rulerData[offset + 5] = inst.color[1];
                rulerData[offset + 6] = inst.color[2];
                rulerData[offset + 7] = inst.color[3];
            }

            if (!this.rulerBuffer || this.rulerBuffer.size < rulerData.byteLength) {
                if (this.rulerBuffer) this.rulerBuffer.destroy();
                this.rulerBuffer = this.device.createBuffer({
                    size: rulerData.byteLength,
                    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
                });
            }

            this.device.queue.writeBuffer(this.rulerBuffer, 0, rulerData);

            const rulerUniformBindGroup = this.device.createBindGroup({
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
            renderPass.setBindGroup(0, rulerUniformBindGroup);
            renderPass.setVertexBuffer(0, this.rulerBuffer);
            renderPass.draw(2, this.rulerInstances.length);
        }
        
        // Render connector lines
        if (this.connectorInstances.length > 0) {
            const connectorData = new Float32Array(this.connectorInstances.length * 8);
            for (let i = 0; i < this.connectorInstances.length; i++) {
                const inst = this.connectorInstances[i];
                const offset = i * 8;
                connectorData[offset + 0] = inst.start[0];
                connectorData[offset + 1] = inst.start[1];
                connectorData[offset + 2] = inst.end[0];
                connectorData[offset + 3] = inst.end[1];
                connectorData[offset + 4] = inst.color[0];
                connectorData[offset + 5] = inst.color[1];
                connectorData[offset + 6] = inst.color[2];
                connectorData[offset + 7] = inst.color[3];
            }

            if (!this.connectorBuffer || this.connectorBuffer.size < connectorData.byteLength) {
                if (this.connectorBuffer) this.connectorBuffer.destroy();
                this.connectorBuffer = this.device.createBuffer({
                    size: connectorData.byteLength,
                    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
                });
            }

            this.device.queue.writeBuffer(this.connectorBuffer, 0, connectorData);

            const connectorUniformBindGroup = this.device.createBindGroup({
                layout: this.connectorPipeline.getBindGroupLayout(0),
                entries: [
                    {
                        binding: 0,
                        resource: {
                            buffer: this.core.projectionBuffer,
                        },
                    },
                ],
            });

            renderPass.setPipeline(this.connectorPipeline);
            renderPass.setBindGroup(0, connectorUniformBindGroup);
            renderPass.setVertexBuffer(0, this.connectorBuffer);
            renderPass.draw(2, this.connectorInstances.length);
        }
    }

    setPan(x, y) {
        this.panX = x;
        this.panY = y;
    }

    setZoom(zoom) {
        this.zoom = Math.max(0.1, Math.min(5.0, zoom));
    }

    pan(deltaX, deltaY) {
        this.panX += deltaX;
        this.panY += deltaY;
    }

    zoomAt(x, y, factor) {
        const oldZoom = this.zoom;
        this.setZoom(this.zoom * factor);
        
        const zoomChange = this.zoom / oldZoom;
        this.panX = x - (x - this.panX) * zoomChange;
        this.panY = y - (y - this.panY) * zoomChange;
    }
}

