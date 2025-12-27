// WebGPU Core - Device initialization and canvas setup
export class WebGPUCore {
    constructor() {
        this.device = null;
        this.context = null;
        this.canvas = null;
        this.format = null;
        this.projectionMatrix = null;
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

        this.projectionBuffer = this.device.createBuffer({
            size: 16 * 4, // 16 floats * 4 bytes
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        this.device.queue.writeBuffer(this.projectionBuffer, 0, this.projectionMatrix);

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

        this.device.queue.writeBuffer(this.projectionBuffer, 0, this.projectionMatrix);
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

