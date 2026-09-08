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

// Monotonic per-message id so a send can be matched to its response in the log.
let _gsCommSeq = 0;

// Small, log-safe summary of a comm request/response — never dump whole payloads
// (variant/read payloads are MBs). Records the shape + a couple of size signals.
function _gsCommSummary(obj) {
  if (obj == null || typeof obj !== 'object') return obj;
  const s = {};
  for (const k of ['type', 'contig', 'start', 'end', 'sample_id', 'aggregate', 'cached', 'error', 'hint', 'region']) {
    if (obj[k] !== undefined) s[k] = obj[k];
  }
  if (Array.isArray(obj.variant_tracks)) {
    s.n_tracks = obj.variant_tracks.length;
    s.n_variants = obj.variant_tracks.reduce((a, t) => a + ((t.variants_data && t.variants_data.length) || 0), 0);
  }
  if (Array.isArray(obj.reads)) s.n_reads = obj.reads.length;
  if (typeof obj.reference_data === 'string') s.ref_len = obj.reference_data.length;
  return s;
}

// Every comm round-trip is logged (send -> recv/error) with latency when debug
// is on, so a session's kernel traffic is fully reconstructable from the log.
function sendCommMessage(type, data, timeoutMs) {
  // Never log the debug-log transport itself — __GS_DEBUG sends `debug_log`
  // through here, so logging it would recurse infinitely.
  const _log = (ev, f) => { if (type !== 'debug_log' && typeof window.__GS_DEBUG === 'function') window.__GS_DEBUG(ev, f); };
  if (typeof window.__GS_SEND !== 'function') {
    _log('comm_send_fail', { type: type, reason: 'transport not ready' });
    return Promise.reject(new Error('Widget transport not ready'));
  }
  const seq = ++_gsCommSeq;
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const _ms = () => Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0);
  _log('comm_send', { seq: seq, type: type, timeoutMs: timeoutMs || null, req: _gsCommSummary(data) });
  return window.__GS_SEND(type, data, timeoutMs).then(
    (resp) => { _log('comm_recv', { seq: seq, type: type, ms: _ms(), resp: _gsCommSummary(resp) }); return resp; },
    (err) => { _log('comm_error', { seq: seq, type: type, ms: _ms(), error: String(err && err.message || err) }); throw err; }
  );
}
