// Model-backed transport for the anywidget host.
//
// Drop-in replacement for jupyter-comms.js: it exposes the same public surface
// the rest of the viewer uses (hostMode, sendCommMessage) but routes messages
// through the ipywidgets model instead of the classic-Notebook
// `Jupyter.notebook.kernel` global. `window.__GS_SEND` is installed by the
// widget's render() and rides the ipywidgets comm — so this works in
// JupyterLab, classic Notebook, Notebook 7, VS Code, Colab, and through the
// Terra / AoU proxy (browser and kernel on different hosts), all with one code
// path.

const hostMode = (window.GENOMESHADER_CONFIG && window.GENOMESHADER_CONFIG.hostMode) || 'inline';

function sendCommMessage(type, data, timeoutMs) {
  if (typeof window.__GS_SEND !== 'function') {
    return Promise.reject(new Error('Widget transport not ready'));
  }
  return window.__GS_SEND(type, data, timeoutMs);
}
