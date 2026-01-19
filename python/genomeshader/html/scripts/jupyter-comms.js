// Genomeshader bootstrap
// -----------------------------
// Determine host mode (inline or popup)
const hostMode = (window.GENOMESHADER_CONFIG && window.GENOMESHADER_CONFIG.hostMode) || 'inline';

// -----------------------------
// Jupyter Comms (Classic Notebook) - Optimized
// -----------------------------
// Python registers a comm target 'genomeshader'
// We create a comm from JS to connect to it (lazy initialization)

let genomeshaderComm = null;
let jupyterKernel = null; // Cache kernel reference
const pendingCommRequests = new Map();
let commInitialized = false;

// Lazy initialization: only set up comm when actually needed
function ensureCommReady() {
  if (commInitialized || genomeshaderComm) {
    return Promise.resolve(genomeshaderComm);
  }
  
  return new Promise(function(resolve, reject) {
    const commAvailable = window.GENOMESHADER_CONFIG?.comm_available;
    if (!commAvailable) {
      reject(new Error('Comms not available'));
      return;
    }
    
    // Use cached kernel if available
    if (jupyterKernel) {
      setupComm(jupyterKernel).then(resolve).catch(reject);
      return;
    }
    
    // Try to get kernel (cached or load)
    if (typeof Jupyter !== 'undefined' && Jupyter.notebook && Jupyter.notebook.kernel) {
      jupyterKernel = Jupyter.notebook.kernel;
      setupComm(jupyterKernel).then(resolve).catch(reject);
    } else if (typeof require !== 'undefined') {
      // Load Jupyter namespace once and cache it
      require(['base/js/namespace'], function(Jupyter) {
        if (Jupyter && Jupyter.notebook && Jupyter.notebook.kernel) {
          jupyterKernel = Jupyter.notebook.kernel;
          setupComm(jupyterKernel).then(resolve).catch(reject);
        } else {
          reject(new Error('Kernel not available'));
        }
      }, reject);
    } else {
      reject(new Error('Jupyter not available'));
    }
  });
}

function setupComm(kernel) {
  return new Promise(function(resolve, reject) {
    try {
      const comm = kernel.comm_manager.new_comm('genomeshader', {
        view_id: window.GENOMESHADER_VIEW_ID
      });
      
      comm.on_msg(function(msg) {
        const data = msg.content.data;
        
        // Handle pending requests
        const request = pendingCommRequests.get(data.request_id);
        if (request) {
          pendingCommRequests.delete(data.request_id);
          request.resolve(data);
        }
        
        // Dispatch event for other listeners
        document.dispatchEvent(new CustomEvent('genomeshader_msg', { detail: data }));
      });
      
      genomeshaderComm = comm;
      commInitialized = true;
      resolve(comm);
    } catch (err) {
      reject(err);
    }
  });
}

function sendCommMessage(type, data, timeoutMs) {
  return ensureCommReady().then(function(comm) {
    return new Promise(function(resolve, reject) {
      const requestId = 'req_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
      pendingCommRequests.set(requestId, { resolve: resolve, reject: reject });
      
      comm.send({
        type: type,
        request_id: requestId,
        ...data
      });
      
      // Timeout - use longer timeout for fetch_reads (120 seconds), default 30 seconds
      const timeout = timeoutMs || (type === 'fetch_reads' ? 120000 : 30000);
      setTimeout(function() {
        if (pendingCommRequests.has(requestId)) {
          pendingCommRequests.delete(requestId);
          reject(new Error('Request timeout'));
        }
      }, timeout);
    });
  });
}

// Defer comm initialization until after visualization renders
// Use requestAnimationFrame to ensure rendering happens first
function initCommLazy() {
  // Wait for visualization to render first
  requestAnimationFrame(function() {
    requestAnimationFrame(function() {
      // Initialize comm in background (non-blocking)
      ensureCommReady().catch(function() {
        // Silently fail - comm is optional
      });
    });
  });
}

// Start lazy initialization after a short delay
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function() {
    setTimeout(initCommLazy, 1000); // Wait 1s for visualization to render
  });
} else {
  setTimeout(initCommLazy, 1000);
}
