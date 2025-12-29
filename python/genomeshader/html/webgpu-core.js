// WebGPU Core - Device initialization and canvas setup
export class WebGPUCore {
    constructor() {
        this.device = null;
        this.context = null;
        this.canvas = null;
        this.format = null;
        this.projectionMatrix = null;
        this.screenSize = null;
        this.projectionBuffer = null;
    }

    async init(canvas) {
        if (!navigator.gpu) {
            throw new Error('WebGPU is not supported in this browser');
        }

        this.canvas = canvas;
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) {
            throw new Error('Failed to get WebGPU adapter');
        }

        this.device = await adapter.requestDevice();
        this.format = navigator.gpu.getPreferredCanvasFormat();
        
        this.context = canvas.getContext('webgpu');
        if (!this.context) {
            throw new Error('Failed to get WebGPU context');
        }

        const devicePixelRatio = window.devicePixelRatio || 1;
        const width = canvas.clientWidth * devicePixelRatio;
        const height = canvas.clientHeight * devicePixelRatio;

        this.context.configure({
            device: this.device,
            format: this.format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
            alphaMode: 'premultiplied',
        });

        // Create projection matrix buffer (orthographic 2D projection)
        this.projectionMatrix = new Float32Array([
            2.0 / width, 0, 0, 0,
            0, -2.0 / height, 0, 0,
            0, 0, 1, 0,
            -1, 1, 0, 1
        ]);
        
        // Pad vec2 to vec4 for 16-byte alignment (vec2 = 8 bytes, needs padding to 16)
        this.screenSize = new Float32Array([width, height, 0, 0]);

        this.projectionBuffer = this.device.createBuffer({
            size: (16 + 4) * 4, // mat4x4 (16 floats) + vec4 padded (4 floats) = 20 floats * 4 bytes = 80 bytes
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        // Write projection matrix and screen size to buffer
        this.device.queue.writeBuffer(this.projectionBuffer, 0, this.projectionMatrix);
        this.device.queue.writeBuffer(this.projectionBuffer, 16 * 4, this.screenSize);

        // Handle resize
        window.addEventListener('resize', () => this.handleResize());
    }

    handleResize() {
        if (!this.canvas || !this.context) return;

        const devicePixelRatio = window.devicePixelRatio || 1;
        const width = this.canvas.clientWidth * devicePixelRatio;
        const height = this.canvas.clientHeight * devicePixelRatio;

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

