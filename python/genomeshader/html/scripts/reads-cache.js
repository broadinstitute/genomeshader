// Reads cache + scheduler.
//
// Semantics (deliberately the opposite of "refetch on every pan/zoom"):
//   * Reads are stored as aligned CHUNKS (per sample|BAM|contig), like map tiles.
//     A chunk is fetched at most once per session; any window is served by
//     assembling the chunks that cover it. Panning/zooming inside loaded chunks
//     never touches the kernel, and never shows a "stale" state.
//   * Chunks are larger than the requested window (16 kb … 4 Mb by zoom level),
//     so nominal pan/zoom stays inside cache. After the requested window is
//     complete, the neighbouring chunks are prefetched (one ring).
//   * All missing chunks — across every track and every open tile — go to the
//     kernel as ONE batch (`fetch_reads_batch`), which the Rust extension fans out
//     over chunk × BAM with rayon.
//   * Loading can be switched off entirely (Disconnect): nothing is requested
//     until Connect is pressed; only already-cached data is shown.
//   * A window that is not fully covered is drawn from whatever chunks exist and
//     the track is dimmed (data-view-state) until the rest lands.

// ---------------------------------------------------------------------------
// Connection (Disconnect / Connect)
// ---------------------------------------------------------------------------
let _gsConnected = true;
function gsIsConnected() { return _gsConnected; }

function gsSetConnected(on) {
  on = !!on;
  if (on === _gsConnected) return;
  _gsConnected = on;
  try { window.__GS_OFFLINE = !on; } catch (_) {}
  if (!on) {
    // Stop asking. (A batch already running in the kernel cannot be recalled;
    // its result is still cached when it lands — it has already been paid for.)
    _readsQueue = [];
    if (_pumpTimer) { clearTimeout(_pumpTimer); _pumpTimer = null; }
    if (_reconcileTimer) { clearTimeout(_reconcileTimer); _reconcileTimer = null; }
    if (typeof _gsVpTimer !== "undefined" && _gsVpTimer) { clearTimeout(_gsVpTimer); _gsVpTimer = null; }
  }
  if (typeof gsUpdateConnectButton === "function") gsUpdateConnectButton();
  if (window.__GS_STATUS) {
    window.__GS_STATUS(on ? "Connected — loading resumed" : "Disconnected — no data will be loaded",
      { autoHide: 2500 });
  }
  gsNotifyReadsWaiters();
  if (typeof renderAll === "function") renderAll();
  if (on) {
    gsEnsureReads({ force: true });
    if (typeof gsScheduleViewportVariantLoad === "function") gsScheduleViewportVariantLoad(0);
  }
}

/** Error a blocked request rejects with; callers treat it as "quietly skipped". */
function gsDisconnectedError(what) {
  const e = new Error("Disconnected" + (what ? " (" + what + " not loaded)" : ""));
  e.gsDisconnected = true;
  return e;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------
const GS_READ_TILE_MIN = 1 << 14;      // 16 kb
const GS_READ_TILE_MAX = 1 << 22;      // 4 Mb
const GS_READ_BATCH_MAX = 16;          // chunk×BAM units per kernel batch

function _readsLocusSig(tile) {
  try {
    const t = tile || state;
    return t.contig + ":" + Math.floor(t.startBp) + "-" + Math.ceil(t.endBp);
  } catch (e) { return ""; }
}

function _locusContigFromSig(sig) {
  if (!sig) return "";
  const i = String(sig).indexOf(":");
  return i > 0 ? String(sig).slice(0, i) : "";
}

function _sigParts(sig) {
  const m = /^(.*):(\d+)-(\d+)$/.exec(String(sig || ""));
  return m ? { contig: m[1], start: +m[2], end: +m[3] } : null;
}

/** 1-based inclusive window a tile is showing. */
function _tileWindow(tile) {
  const t = tile || state;
  const s = Math.max(1, Math.floor(t.startBp));
  const e = Math.max(s, Math.ceil(t.endBp));
  return { contig: t.contig, s, e };
}

function _chromLen(contig) {
  const cfg = window.GENOMESHADER_CONFIG || {};
  return Number((cfg.chrom_lengths || {})[contig]) || 0;
}

/** Chunk size for a window span: the smallest power of two ≥ span, clamped. */
function gsReadTileSize(span) {
  let L = GS_READ_TILE_MIN;
  while (L < span && L < GS_READ_TILE_MAX) L *= 2;
  return L;
}

function _trackBamPin(track) {
  if (!track) return "";
  return track.requestedBamUrl
    || (track.bamUrls && track.bamUrls.length === 1 ? track.bamUrls[0] : "")
    || "";
}

// ---------------------------------------------------------------------------
// Chunk store
// ---------------------------------------------------------------------------
const _chunks = new Map();          // chunkKey -> chunk (Map order = LRU)
const _chunkLines = new Map();      // lineKey  -> Set(chunkKey)
let _chunkRows = 0;
const GS_CHUNK_MAX_ROWS = 6000000;

function _lineKey(sample, pin, contig) { return sample + "|" + (pin || "") + "|" + contig; }
function _chunkKey(sample, pin, contig, s, e) { return _lineKey(sample, pin, contig) + "|" + s + "-" + e; }

function _chunkRowCount(reads) {
  return (reads && reads.query_name && reads.query_name.length) || 0;
}

function gsCacheChunk(sample, pin, contig, s, e, reads, bamUrls) {
  if (!sample || !contig) return null;
  const key = _chunkKey(sample, pin, contig, s, e);
  const old = _chunks.get(key);
  if (old) { _chunkRows -= _chunkRowCount(old.reads); _chunks.delete(key); }
  const chunk = { key, line: _lineKey(sample, pin, contig), sample, pin: pin || "", contig,
    start: s, end: e, reads: reads || {}, bamUrls: bamUrls || [] };
  _chunks.set(key, chunk);
  _chunkRows += _chunkRowCount(chunk.reads);
  let set = _chunkLines.get(chunk.line);
  if (!set) { set = new Set(); _chunkLines.set(chunk.line, set); }
  set.add(key);
  _gsEvictChunks();
  return chunk;
}

function _gsEvictChunks() {
  if (_chunkRows <= GS_CHUNK_MAX_ROWS) return;
  // Never evict a chunk an open tile is showing.
  const protect = new Set();
  try {
    for (const tile of (state.tiles || [])) {
      if (!tile || tile.blank) continue;
      const w = _tileWindow(tile);
      for (const track of (state.smartTracks || [])) {
        if (!track || !track.sampleId) continue;
        for (const c of gsChunksForWindow(track.sampleId, _trackBamPin(track), w.contig, w.s, w.e)) protect.add(c.key);
      }
    }
  } catch (_) {}
  for (const key of Array.from(_chunks.keys())) {
    if (_chunkRows <= GS_CHUNK_MAX_ROWS) break;
    if (protect.has(key)) continue;
    gsDropChunk(key);
  }
}

function gsDropChunk(key) {
  const c = _chunks.get(key);
  if (!c) return false;
  _chunkRows -= _chunkRowCount(c.reads);
  _chunks.delete(key);
  const set = _chunkLines.get(c.line);
  if (set) { set.delete(key); if (!set.size) _chunkLines.delete(c.line); }
  return true;
}

/** Chunks of one (sample, BAM, contig) line intersecting [s,e], sorted by start. */
function gsChunksForWindow(sample, pin, contig, s, e) {
  const set = _chunkLines.get(_lineKey(sample, pin, contig));
  if (!set) return [];
  const out = [];
  for (const key of set) {
    const c = _chunks.get(key);
    if (c && c.end >= s && c.start <= e) out.push(c);
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

/** Sub-ranges of [s,e] NOT covered by the chunks (1-based inclusive). */
function gsCoverageGaps(chunks, s, e) {
  const gaps = [];
  let cur = s;
  for (const c of chunks) {          // sorted by start
    if (c.start > cur) gaps.push([cur, Math.min(e, c.start - 1)]);
    if (c.end + 1 > cur) cur = c.end + 1;
    if (cur > e) break;
  }
  if (cur <= e) gaps.push([cur, e]);
  return gaps;
}

// ---------------------------------------------------------------------------
// Assembling chunks into one reads payload (columnar), de-duplicating reads that
// span a chunk boundary and unioning their elements.
// ---------------------------------------------------------------------------
const _assembleMemo = new Map();
// The memo must hold the whole working set — one entry per (track, tile) showing
// a distinct chunk set — or LRU eviction thrashes: with more entries in use than
// slots, every paint evicts what the next paint needs and re-merges every chunk
// (that was ~70% of a repaint at 50 tracks x 2 tiles). Sized from live state.
function _assembleMemoMax() {
  const tracks = (state.smartTracks || []).length;
  const tiles = (state.tiles || []).length || 1;
  // Each entry is a FULL merged copy of a chunk set's columns (~half of a track's
  // memory), so keep the working set plus slack, not several generations of it.
  return Math.max(16, Math.ceil(1.5 * tracks * tiles));
}

function _readIdentity(p, i) {
  return p.query_name[i] + "|" + p.reference_start[i] + "|" + p.reference_end[i] + "|"
    + (p.is_forward && p.is_forward[i] ? 1 : 0) + "|"
    + (p.is_supplementary && p.is_supplementary[i] ? 1 : 0) + "|"
    + (p.is_secondary && p.is_secondary[i] ? 1 : 0);
}

function _mergeReadPayloads(payloads) {
  const cols = Object.keys(payloads[0]);
  const groups = new Map();
  const order = [];
  for (const p of payloads) {
    const n = p.query_name.length;
    const et = p.element_type;
    let g = null;
    for (let i = 0; i < n; i++) {
      if (et[i] === 0) {
        const k = _readIdentity(p, i);
        g = groups.get(k);
        if (!g) { g = { src: p, i, elems: new Map() }; groups.set(k, g); order.push(g); }
      } else if (g) {
        const ek = et[i] + "|" + p.reference_start[i] + "|" + p.reference_end[i] + "|"
          + (p.sequence ? p.sequence[i] : "");
        if (!g.elems.has(ek)) g.elems.set(ek, { src: p, i });
      }
    }
  }
  const out = {};
  for (const c of cols) out[c] = [];
  const push = (src, i) => {
    for (const c of cols) { const col = src[c]; out[c].push(col ? col[i] : undefined); }
  };
  for (const g of order) {
    push(g.src, g.i);
    const els = Array.from(g.elems.values());
    els.sort((a, b) => a.src.reference_start[a.i] - b.src.reference_start[b.i]);
    for (const e of els) push(e.src, e.i);
  }
  return out;
}

/**
 * Same result as _mergeReadPayloads, but only reads that overlap ANOTHER chunk's
 * range can possibly appear twice, so only those get identity keys; every other
 * read (and its element rows) is copied straight through. The general merge built
 * a string key per read and per element, which dominated chunk-arrival stalls.
 * `ranges[k]` = [start, end] of payload k's chunk.
 */
function _mergeReadPayloadsFast(payloads, ranges) {
  const g = _mergeReadPayloadsFastGen(payloads, ranges, null);
  let r;
  while (!(r = g.next()).done) { /* no slice controller: never yields */ }
  return r.value;
}

function* _mergeReadPayloadsFastGen(payloads, ranges, sl) {
  const cols = Object.keys(payloads[0]);
  const out = {};
  for (const c of cols) out[c] = [];
  const nc = cols.length;
  const seen = new Map();           // identity -> { elems: Map, at }  (candidates only)
  const outIdx = [];                // candidate reads, in first-seen order
  const pushRow = (src, i) => {
    for (let k = 0; k < nc; k++) { const col = src[cols[k]]; out[cols[k]].push(col ? col[i] : undefined); }
  };
  const MARGIN = 2;
  for (let pi = 0; pi < payloads.length; pi++) {
    const p = payloads[pi];
    const n = p.query_name.length;
    const et = p.element_type, rs = p.reference_start, re = p.reference_end;
    // other chunks' union bounds (a read outside all of them cannot be duplicated)
    let i = 0;
    let _reads = 0;
    while (i < n) {
      if (sl && (++_reads & 1023) === 0 && sl.expired()) yield;
      if (et[i] !== 0) { i++; continue; }          // stray element row (no owning read): skip as before
      let j = i + 1;
      while (j < n && et[j] !== 0) j++;            // elements of this read: i+1 .. j-1
      let candidate = false;
      for (let q = 0; q < ranges.length && !candidate; q++) {
        if (q === pi) continue;
        if (re[i] >= ranges[q][0] - MARGIN && rs[i] <= ranges[q][1] + MARGIN) candidate = true;
      }
      if (!candidate) {
        pushRow(p, i);
        // Elements ascending by start (the general merge sorted them; usually already
        // sorted) and without identical repeats (it de-duplicated by type/start/end/seq).
        let sorted = true;
        for (let e = i + 2; e < j; e++) if (rs[e] < rs[e - 1]) { sorted = false; break; }
        let order = null;
        if (!sorted) {
          order = []; for (let e = i + 1; e < j; e++) order.push(e);
          order.sort((a, b) => rs[a] - rs[b]);
        }
        const emitted = [];
        for (let x = i + 1; x < j; x++) {
          const e = order ? order[x - i - 1] : x;
          let dup = false;
          for (let y = emitted.length - 1; y >= 0 && rs[emitted[y]] === rs[e]; y--) {
            const f = emitted[y];
            if (et[f] === et[e] && re[f] === re[e] && (p.sequence ? p.sequence[f] === p.sequence[e] : true)) { dup = true; break; }
          }
          if (dup) continue;
          emitted.push(e);
          pushRow(p, e);
        }
      } else {
        const key = _readIdentity(p, i);
        let g = seen.get(key);
        if (!g) {
          // First sight: emit the read row here (this fixes its place in output order);
          // its element rows are merged across every duplicate and inserted after it.
          g = { src: p, i, elems: new Map(), placeholder: out.query_name.length };
          seen.set(key, g);
          outIdx.push(g);
          pushRow(p, i);
        }
        for (let e = i + 1; e < j; e++) {
          const ek = et[e] + "|" + rs[e] + "|" + re[e] + "|" + (p.sequence ? p.sequence[e] : "");
          if (!g.elems.has(ek)) g.elems.set(ek, { src: p, i: e });
        }
      }
      i = j;
    }
  }
  // Candidate reads were emitted (one row each) at first sight; their element rows
  // must follow that row, merged + sorted. Rebuild output in one pass if any exist.
  if (!outIdx.length) return out;
  const groupAt = new Map();
  for (const g of outIdx) groupAt.set(g.placeholder, g);
  const final = {};
  for (const c of cols) final[c] = [];
  const N = out.query_name.length;
  const copy = (r) => { for (let k = 0; k < nc; k++) final[cols[k]].push(out[cols[k]][r]); };
  for (let r = 0; r < N; r++) {
    if (sl && (r & 8191) === 0 && sl.expired()) yield;
    const g = groupAt.get(r);
    if (g) {
      copy(r);
      const els = Array.from(g.elems.values());
      els.sort((a, b) => a.src.reference_start[a.i] - b.src.reference_start[b.i]);
      for (const e of els) { for (let k = 0; k < nc; k++) { const col = e.src[cols[k]]; final[cols[k]].push(col ? col[e.i] : undefined); } }
    } else copy(r);
  }
  return final;
}

// ---------------------------------------------------------------------------
// Binary reads transport (see python/genomeshader/reads_codec.py)
// ---------------------------------------------------------------------------
// The kernel can send a chunk's columns as raw buffers on the widget's binary
// channel instead of JSON text. JupyterLab would otherwise JSON.parse every reads
// batch on the main thread before we see it. The transport is negotiated per
// request and self-healing: any decode problem switches the session back to JSON.

/** Aligned ArrayBuffer copy of a buffer-ish value (DataView / typed array / ArrayBuffer). */
function _gsBufToArrayBuffer(b) {
  if (b instanceof ArrayBuffer) return b;
  if (ArrayBuffer.isView(b)) return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  throw new Error("unsupported buffer type");
}

/** {name: column} from a reads_bin manifest + the message's buffers. */
function gsDecodeReadsBinary(manifest, buffers) {
  if (!manifest || manifest.v !== 1) throw new Error("unsupported reads_bin version");
  const n = manifest.n;
  const out = {};
  for (const c of manifest.cols) {
    const raw = buffers[c.buf];
    if (raw == null) throw new Error("missing buffer for column " + c.name);
    const ab = _gsBufToArrayBuffer(raw);
    let col;
    if (c.kind === "i32") col = new Int32Array(ab);
    else if (c.kind === "f64") col = new Float64Array(ab);
    else if (c.kind === "bool") {
      const u8 = new Uint8Array(ab);
      col = new Array(u8.length);
      for (let i = 0; i < u8.length; i++) col[i] = u8[i] === 1;        // real booleans (code tests === false)
    } else if (c.kind === "str") col = new TextDecoder("utf-8").decode(ab).split("\0");
    else throw new Error("unknown column kind " + c.kind);
    if (col.length !== n) throw new Error("column " + c.name + ": expected " + n + " rows, got " + col.length);
    out[c.name] = col;
  }
  return out;
}

/** Decode every binary item of a fetch_reads_batch response in place (items[i].reads). */
function gsDecodeBatchResponse(resp) {
  if (!resp || !Array.isArray(resp.items)) return resp;
  for (const it of resp.items) {
    if (it && it.reads_bin) {
      it.reads = gsDecodeReadsBinary(it.reads_bin, resp._buffers || []);
      delete it.reads_bin;
    }
  }
  delete resp._buffers;
  return resp;
}

/**
 * Ask for binary only when it is enabled (config.reads_binary, from
 * GENOMESHADER_READS_BINARY=1), the host transport delivers buffers, and it has not
 * failed this session. Off by default: see reads_codec.py for the trade-offs.
 */
function _gsWantBinaryReads() {
  const cfg = window.GENOMESHADER_CONFIG || {};
  return !!(cfg.reads_binary === true && window.__GS_TRANSPORT_BINARY && window.__GS_READS_BINARY !== false);
}

// ---------------------------------------------------------------------------
// Time-sliced background jobs
// ---------------------------------------------------------------------------
// Merging chunk payloads and laying out hundreds of thousands of reads is real
// work; done in the frame a chunk arrives it froze the viewer for seconds. Large
// jobs run as generators in ~6 ms slices between frames while the tile keeps
// painting its previous view, and repaint when they finish. Small inputs
// (<= GS_SYNC_MAX_ROWS rows) stay fully synchronous — no latency, no behaviour
// change for light sessions.
const GS_SYNC_MAX_ROWS = 20000;
const GS_JOB_SLICE_MS = 6;
const _gsJobs = new Map();                        // key -> { key, gen, onDone, wanted }
const _gsSlice = { deadline: 0, expired() { return performance.now() > this.deadline; } };
let _gsJobPumpScheduled = false;
const _gsJobChannel = (typeof MessageChannel !== "undefined") ? new MessageChannel() : null;
if (_gsJobChannel) _gsJobChannel.port1.onmessage = () => _gsJobPump();

function gsJobsPending() { return _gsJobs.size > 0; }

function gsSubmitJob(key, makeGen, onDone) {
  let job = _gsJobs.get(key);
  if (job) { job.wanted = performance.now(); return job; }
  job = { key, gen: makeGen(_gsSlice), onDone, wanted: performance.now() };
  _gsJobs.set(key, job);
  _gsScheduleJobPump();
  return job;
}

function _gsScheduleJobPump() {
  if (_gsJobPumpScheduled) return;
  _gsJobPumpScheduled = true;
  if (_gsJobChannel) _gsJobChannel.port2.postMessage(0);
  else setTimeout(_gsJobPump, 0);
}

function _gsJobPump() {
  _gsJobPumpScheduled = false;
  const t0 = performance.now();
  _gsSlice.deadline = t0 + GS_JOB_SLICE_MS;
  // Drop jobs nobody has asked for lately (the view moved on); they restart if wanted again.
  for (const [k, j] of _gsJobs) if (t0 - j.wanted > 3000) _gsJobs.delete(k);
  let finished = false;
  while (_gsJobs.size && performance.now() < _gsSlice.deadline) {
    let best = null;                              // most recently wanted first
    for (const j of _gsJobs.values()) if (!best || j.wanted > best.wanted) best = j;
    let r;
    try { r = best.gen.next(); } catch (e) { console.error("read job failed", best.key, e); _gsJobs.delete(best.key); continue; }
    if (r.done) {
      _gsJobs.delete(best.key);
      try { best.onDone(r.value); } catch (e) { console.error("read job completion failed", best.key, e); }
      finished = true;
    }
  }
  if (_gsJobs.size) _gsScheduleJobPump();
  if (finished && typeof scheduleRender === "function") scheduleRender();
}

/** Precompute everything the painter would otherwise build lazily in a frame. */
function* _gsPrepareLayoutGen(layout, display) {
  gsLayoutIndex(layout); yield;
  for (const h of [0, 1, 2]) { gsHapIndex(layout, h); yield; }
  const m = display && display.softClipMode;
  gsSummaryEvents(layout, (m === "bases" || m === "hide") ? m : "marker");
}

const _layoutCache = new WeakMap();               // reads payload -> Map(displayKey -> layout)

/** The layout of `reads` under `display`, or null while a background job computes it. */
function gsLayoutFor(reads, display, dKey) {
  let byKey = _layoutCache.get(reads);
  if (byKey && byKey.has(dKey)) return byKey.get(dKey);
  const store = (lay) => {
    let m = _layoutCache.get(reads);
    if (!m) { m = new Map(); _layoutCache.set(reads, m); }
    m.set(dKey, lay);
  };
  if (_chunkRowCount(reads) <= GS_SYNC_MAX_ROWS) {
    const lay = processReadsData(reads, { display });
    store(lay);
    return lay;
  }
  gsSubmitJob("layout|" + _gsObjId(reads) + "|" + dKey, function* (sl) {
    const lay = yield* _processReadsDataGen(reads, { display }, sl);
    if (lay) yield* _gsPrepareLayoutGen(lay, display);
    return lay;
  }, store);
  return null;
}

/** { ready, reads } for a chunk list; when large and not yet merged, starts a job. */
function gsAssembleChunksAsync(chunks) {
  const withReads = chunks.filter((c) => _chunkRowCount(c.reads) > 0);
  if (!withReads.length) return { ready: true, reads: null };
  if (withReads.length === 1) return { ready: true, reads: withReads[0].reads };
  const key = withReads.map((c) => c.key).join("~");
  const hit = _assembleMemo.get(key);
  if (hit) { _assembleMemo.delete(key); _assembleMemo.set(key, hit); return { ready: true, reads: hit }; }
  const total = withReads.reduce((n, c) => n + _chunkRowCount(c.reads), 0);
  if (total <= GS_SYNC_MAX_ROWS) return { ready: true, reads: gsAssembleChunks(chunks) };
  const payloads = withReads.map((c) => c.reads);
  const ranges = withReads.map((c) => [c.start, c.end]);
  gsSubmitJob("merge|" + key, (sl) => _mergeReadPayloadsFastGen(payloads, ranges, sl), (merged) => {
    _assembleMemo.set(key, merged);
    const max = _assembleMemoMax();
    while (_assembleMemo.size > max) _assembleMemo.delete(_assembleMemo.keys().next().value);
  });
  return { ready: false };
}

/** One reads payload for a chunk list, or null when there are no reads at all. */
function gsAssembleChunks(chunks) {
  const withReads = chunks.filter((c) => _chunkRowCount(c.reads) > 0);
  if (!withReads.length) return null;
  if (withReads.length === 1) return withReads[0].reads;
  const key = withReads.map((c) => c.key).join("~");
  const hit = _assembleMemo.get(key);
  if (hit) { _assembleMemo.delete(key); _assembleMemo.set(key, hit); return hit; }
  const merged = window.__GS_SLOW_MERGE
    ? _mergeReadPayloads(withReads.map((c) => c.reads))
    : _mergeReadPayloadsFast(withReads.map((c) => c.reads), withReads.map((c) => [c.start, c.end]));
  _assembleMemo.set(key, merged);
  const _memoMax = _assembleMemoMax();
  while (_assembleMemo.size > _memoMax) _assembleMemo.delete(_assembleMemo.keys().next().value);
  return merged;
}

// ---------------------------------------------------------------------------
// Per-tile views
// ---------------------------------------------------------------------------
// A "view" is what ONE tile shows for ONE smart track: the packed layout of the
// reads assembled from the chunks covering the tile's window. `exact` means the
// window is FULLY covered. Views are memoized per tile so repaints never re-run
// processReadsData for unchanged data.

function _readsDisplayKey(track) {
  try { return JSON.stringify((track && track.readDisplay) || null); } catch (_) { return ""; }
}

function _sameChunkRefs(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function gsResolveTrackView(track, tile) {
  if (!track || !tile || tile.blank) return null;
  const wantSig = _readsLocusSig(tile);
  if (!wantSig) return null;
  if (!(tile._readsViews instanceof Map)) tile._readsViews = new Map();
  const memo = tile._readsViews;
  const dKey = _readsDisplayKey(track);
  let view = memo.get(track.id) || null;
  const display = track.readDisplay || DEFAULT_READ_DISPLAY;

  if (track.sampleId) {
    const w = _tileWindow(tile);
    const chunks = gsChunksForWindow(track.sampleId, _trackBamPin(track), w.contig, w.s, w.e);
    if (chunks.length) {
      for (const c of chunks) { _chunks.delete(c.key); _chunks.set(c.key, c); }   // LRU touch
      const exact = gsCoverageGaps(chunks, w.s, w.e).length === 0;
      // Chunks are immutable (a re-cache replaces the object), so the same chunk
      // objects mean the same payload: reuse the view's reads without touching
      // the assemble memo at all.
      // Large merges / layouts run as background jobs: until they finish keep painting
      // the tile's previous layout (flagged pending) rather than freezing the frame.
      let reads;
      let pending = false;
      if (view && view.chunkRefs && _sameChunkRefs(view.chunkRefs, chunks)) reads = view.reads;
      else {
        const a = gsAssembleChunksAsync(chunks);
        if (a.ready) reads = a.reads; else pending = true;
      }
      let layout = null;
      if (!pending && reads) {
        layout = (view && view.reads === reads && view.displayKey === dKey && view.layout)
          ? view.layout : gsLayoutFor(reads, display, dKey);
        if (layout === null) pending = true;
      }
      if (pending) {
        if (view && view.layout) {
          return { sig: view.sig, wantSig, exact: false, pending: true, reads: view.reads, layout: view.layout };
        }
        return null;
      }
      if (!view || view.reads !== reads || view.displayKey !== dKey) {
        view = { reads, displayKey: dKey, layout };
      }
      view.chunkRefs = chunks;
      const hullSig = w.contig + ":" + chunks[0].start + "-" + chunks[chunks.length - 1].end;
      view.sig = exact ? wantSig : hullSig;
      view.exact = exact;
      view.hasChunks = true;
      memo.set(track.id, view);
      return { sig: view.sig, wantSig, exact, reads, layout: view.layout };
    }
  }

  // Live single-payload fallback (directly seeded tracks that never went through
  // the chunk store). A payload with no recorded locus belongs to the focused tile.
  const liveOk = track.readsLayout && track.readsData
    && (track._readsLocusSig ? track._readsLocusSig === wantSig
      : (!gsIsMultiTile() || tile.id === state.focusedTileId));
  if (liveOk) {
    if (!view || view.reads !== track.readsData || view.displayKey !== dKey) {
      view = { sig: wantSig, reads: track.readsData, displayKey: dKey, layout: track.readsLayout, exact: true };
      memo.set(track.id, view);
    }
    return { sig: wantSig, wantSig, exact: true, reads: view.reads, layout: view.layout };
  }

  // Nothing cached for this window: keep the tile's previous same-contig view
  // while it overlaps (so a jump never blanks a tile), otherwise nothing.
  if (view && view.layout && view.layout.reads && view.layout.reads.length) {
    const have = _sigParts(view.sig);
    const want = _sigParts(wantSig);
    if (have && want && have.contig === want.contig
        && have.end >= want.start && have.start <= want.end) {
      if (view.displayKey !== dKey) {
        const lay = gsLayoutFor(view.reads, display, dKey);
        if (lay === null) {
          return { sig: view.sig, wantSig, exact: false, pending: true, reads: view.reads, layout: view.layout };
        }
        view.layout = lay;
        view.displayKey = dKey;
      }
      return { sig: view.sig, wantSig, exact: false, reads: view.reads, layout: view.layout };
    }
  }
  return null;
}

/** Packed reads layout a tile shows for a track (memoized per tile), or null. */
function smartTrackReadsLayoutForTile(track, tile) {
  if (!track || !tile || tile.blank) return null;
  const view = gsResolveTrackView(track, tile);
  return view ? view.layout : null;
}

/** True while a batch that includes a chunk of this (track, window) is in flight. */
function gsTrackTileLoading(track, tile) {
  if (!track || !track.sampleId || !tile || tile.blank || !_inflightChunks.size) return false;
  const w = _tileWindow(tile);
  const line = _lineKey(track.sampleId, _trackBamPin(track), w.contig);
  for (const d of _inflightChunks.values()) {
    if (d.line === line && d.end >= w.s && d.start <= w.e) return true;
  }
  return false;
}

/** Freshness of what `tile` shows for `track`: exact | stale | loading | offline | failed. */
function gsTrackTileViewState(track, tile, view) {
  if (!track || !track.sampleId) return "exact";      // nothing to fetch (seeded/test tracks)
  if (view && view.pending) return "stale";           // still laying out: what shows is the previous layout
  if (!view && gsJobsPending()) return "loading";     // first big layout still being built: say so
  if (view && view.exact) return "exact";
  const w = _tileWindow(tile);
  const chunks = gsChunksForWindow(track.sampleId, _trackBamPin(track), w.contig, w.s, w.e);
  const gaps = gsCoverageGaps(chunks, w.s, w.e);
  if (!gaps.length) return view ? "exact" : "exact";
  const L = gsReadTileSize(w.e - w.s + 1);
  for (const g of gaps) {
    for (let i = Math.floor((g[0] - 1) / L); i <= Math.floor((g[1] - 1) / L); i++) {
      const f = _readsFailures.get(_chunkKey(track.sampleId, _trackBamPin(track), w.contig,
        i * L + 1, _clampEnd(w.contig, (i + 1) * L)));
      if (f && f.n >= _READS_MAX_ATTEMPTS) return "failed";
    }
  }
  if (!_gsConnected && !gsTrackTileLoading(track, tile)) return view ? "stale" : "offline";
  return view ? "stale" : "loading";
}

function _clampEnd(contig, end) {
  const len = _chromLen(contig);
  return len > 0 ? Math.min(end, len) : end;
}

/**
 * Run fn with `track`'s live paint fields set to what `tile` should show.
 * Focused tile: the view stays assigned (the live fields ARE the focused tile's).
 * Any other tile: fields are restored afterwards so interaction code reading
 * track.readsLayout keeps seeing the focused tile.
 */
function gsWithTrackView(track, tile, fn) {
  const focused = !gsIsMultiTile() || tile.id === state.focusedTileId;
  const view = gsResolveTrackView(track, tile);
  const viewState = gsTrackTileViewState(track, tile, view);
  // "Pending" = a fetch covering this window is in flight, or the window has no
  // data yet and a load is about to be requested. Never while disconnected.
  const pending = _gsConnected
    && (gsTrackTileLoading(track, tile) || (!view && viewState === "loading"));
  const wantSig = _readsLocusSig(tile);
  // Stale/absent data must never pass for current: the container dims until exact.
  try {
    const rr = gsTileRenderers(tile).get(track.id);
    if (rr && rr.container) rr.container.dataset.viewState = viewState;
  } catch (_) {}
  const saved = {
    readsData: track.readsData,
    readsLayout: track.readsLayout,
    _readsLocusSig: track._readsLocusSig,
    _medianInsertSize: track._medianInsertSize,
    loading: track.loading,
    _loadingLocusSig: track._loadingLocusSig,
  };
  if (view) {
    track.readsData = view.reads;
    track.readsLayout = view.layout;
    track._readsLocusSig = view.sig;
    track._medianInsertSize = view.layout ? view.layout.medianInsertSize : 0;
  } else if (!focused) {
    track.readsData = null;
    track.readsLayout = null;
    track._readsLocusSig = null;
    track._medianInsertSize = 0;
  }
  if (!focused) track.loading = pending;
  track._loadingLocusSig = pending ? wantSig : null;
  try {
    return fn(view);
  } finally {
    if (!focused) {
      track.readsData = saved.readsData;
      track.readsLayout = saved.readsLayout;
      track._readsLocusSig = saved._readsLocusSig;
      track._medianInsertSize = saved._medianInsertSize;
      track.loading = saved.loading;
      track._loadingLocusSig = saved._loadingLocusSig;
    }
  }
}

/** Point every smart track's live fields at the focused tile's view (single-tile path). */
function hydrateSmartTracksForCurrentLocus() {
  const tile = (typeof gsFocusedTile === "function") ? gsFocusedTile() : null;
  if (!tile) return false;
  let incomplete = false;
  for (const track of state.smartTracks || []) {
    if (!track) continue;
    const view = gsResolveTrackView(track, tile);
    if (view) {
      track.readsData = view.reads;
      track.readsLayout = view.layout;
      track._readsLocusSig = view.sig;
      track._medianInsertSize = view.layout ? view.layout.medianInsertSize : 0;
    }
    if (!view || !view.exact) incomplete = true;
  }
  return incomplete;
}

/** Kept for callers that used to persist the live payload; the chunk store is the source of truth. */
function cacheLiveSmartTrackReads() {}

// ---------------------------------------------------------------------------
// Painting one track into ONE tile
// ---------------------------------------------------------------------------
function _gsSaveTileAliases() {
  return {
    contig: state.contig, startBp: state.startBp, endBp: state.endBp, pxPerBp: state.pxPerBp,
    renderPadBp: state.renderPadBp, renderPadPx: state.renderPadPx,
    expandedInsertions: state.expandedInsertions,
    tracksContainer: (typeof tracksContainer !== "undefined") ? tracksContainer : null,
    tracksSvg: (typeof tracksSvg !== "undefined") ? tracksSvg : null,
    tracksWebGPU: (typeof tracksWebGPU !== "undefined") ? tracksWebGPU : null,
    flow: (typeof flow !== "undefined") ? flow : null,
    flowCanvas: (typeof flowCanvas !== "undefined") ? flowCanvas : null,
    flowWebGPU: (typeof flowWebGPU !== "undefined") ? flowWebGPU : null,
    flowOverlay: (typeof flowOverlay !== "undefined") ? flowOverlay : null,
    flowIndelOverlay: (typeof flowIndelOverlay !== "undefined") ? flowIndelOverlay : null,
    webgpuCore, instancedRenderer, flowWebGPUCore, flowInstancedRenderer, flowRibbonRenderer,
  };
}
function _gsRestoreTileAliases(a) {
  state.contig = a.contig; state.startBp = a.startBp; state.endBp = a.endBp; state.pxPerBp = a.pxPerBp;
  state.renderPadBp = a.renderPadBp; state.renderPadPx = a.renderPadPx;
  state.expandedInsertions = a.expandedInsertions;
  if (typeof tracksContainer !== "undefined") tracksContainer = a.tracksContainer;
  if (typeof tracksSvg !== "undefined") tracksSvg = a.tracksSvg;
  if (typeof tracksWebGPU !== "undefined") tracksWebGPU = a.tracksWebGPU;
  if (typeof flow !== "undefined") flow = a.flow;
  if (typeof flowCanvas !== "undefined") flowCanvas = a.flowCanvas;
  if (typeof flowWebGPU !== "undefined") flowWebGPU = a.flowWebGPU;
  if (typeof flowOverlay !== "undefined") flowOverlay = a.flowOverlay;
  if (typeof flowIndelOverlay !== "undefined") flowIndelOverlay = a.flowIndelOverlay;
  webgpuCore = a.webgpuCore; instancedRenderer = a.instancedRenderer;
  flowWebGPUCore = a.flowWebGPUCore; flowInstancedRenderer = a.flowInstancedRenderer;
  flowRibbonRenderer = a.flowRibbonRenderer;
}
function _gsApplyTileToState(tile) {
  state.contig = tile.contig;
  state.startBp = tile.startBp;
  state.endBp = tile.endBp;
  state.pxPerBp = tile.pxPerBp;
  state.renderPadBp = tile.renderPadBp || 0;
  state.renderPadPx = tile.renderPadPx || 0;
  if (tile.expandedInsertions instanceof Set) state.expandedInsertions = tile.expandedInsertions;
}

// > 0 while a tile-aware paint is running (renderSmartTrack must not redirect again).
let _gsTilePaintDepth = 0;

/**
 * Paint one smart track into ONE tile's own container, on that tile's own GPU
 * canvas. Assumes aliases/DOM are already bound to `tile` when called from
 * renderAll (opts.bound); otherwise binds + restores them (scroll / resize
 * repaints).
 */
function gsRenderSmartTrackInTile(trackId, tile, opts) {
  const track = (state.smartTracks || []).find((t) => t.id === trackId);
  if (!track) return;
  const multi = typeof gsIsMultiTile === "function" && gsIsMultiTile();
  if (!tile || !multi) { renderSmartTrack(trackId); return; }
  if (tile.blank) return;
  const paint = () => {
    _gsTilePaintDepth++;
    try {
      gsWithTrackView(track, tile, () => renderSmartTrack(trackId));
    } finally {
      _gsTilePaintDepth--;
    }
  };
  if (opts && opts.bound) {
    gsWithTile(tile, paint);
    return;
  }
  const saved = _gsSaveTileAliases();
  try {
    gsWithTile(tile, () => {
      _gsApplyTileToState(tile);
      if (typeof gsBindTileDom === "function") gsBindTileDom(tile);
      if (typeof updateDerivedForBoundTile === "function") updateDerivedForBoundTile(tile);
      state._viewCoverageMax = null;
      paint();
    });
  } finally {
    _gsRestoreTileAliases(saved);
  }
}

/** Paint every smart track (in layout order) into `tile`. Aliases must be bound. */
function gsPaintSmartTracksForTile(tile) {
  const ordered = state.tracks
    .filter((t) => t.id.startsWith("smart-track-"))
    .map((t) => state.smartTracks.find((st) => st.id === t.id))
    .filter((st) => st !== undefined);
  for (const track of ordered) {
    gsRenderSmartTrackInTile(track.id, tile, { bound: true });
  }
}

// ---------------------------------------------------------------------------
// Scheduler: what is missing → one batched request at a time
// ---------------------------------------------------------------------------
const _readsFailures = new Map();       // chunkKey -> { n, nextAt }
const _READS_MAX_ATTEMPTS = 5;
const _inflightChunks = new Map();      // chunkKey -> desc (line,start,end,…)
let _readsQueue = [];                   // descs wanted but not yet sent (demand first)
let _batchInFlight = null;              // { descs }
let _reconcileTimer = null;
let _readsRenderTimer = null;

function _readsRetryDelay(n) {
  const base = (typeof window !== "undefined" && window.__GS_READS_RETRY_BASE_MS) || 1500;
  return Math.min(30000, base * Math.pow(2, Math.max(0, n - 1)));
}

function _scheduleReadsRender() {
  if (_readsRenderTimer) return;
  _readsRenderTimer = setTimeout(() => {
    _readsRenderTimer = null;
    if (typeof scheduleRender === "function") scheduleRender();
    else if (typeof renderAll === "function") renderAll();
    if (typeof gsDrawTileArcs === "function") gsDrawTileArcs();
  }, 50);
}

function gsScheduleReadsReconcile(delay, debounce) {
  if (!_gsConnected) return;
  if (_reconcileTimer) {
    if (!debounce) return;
    clearTimeout(_reconcileTimer);        // interaction still moving the window: wait for it to settle
  }
  _reconcileTimer = setTimeout(() => {
    _reconcileTimer = null;
    try { gsEnsureReads(); } catch (_) {}
  }, delay == null ? 150 : Math.max(0, delay));
}

/** Debounced reload after pan/zoom settle. Cheap: does nothing when the window is covered. */
let _gsSmartReadsLoadTimer = null;
const GS_SMART_READS_SETTLE_MS = 220;
function gsScheduleSmartReadsLoad(delay) {
  if (_gsSmartReadsLoadTimer) clearTimeout(_gsSmartReadsLoadTimer);
  _gsSmartReadsLoadTimer = setTimeout(() => {
    _gsSmartReadsLoadTimer = null;
    try { gsEnsureReads(); } catch (_) {}
  }, delay == null ? GS_SMART_READS_SETTLE_MS : delay);
}

/**
 * The chunks every open tile needs (demand) plus the neighbouring ring of the
 * focused tile (prefetch, only once the focused tile is complete).
 * Chunks already cached, in flight, or in retry backoff are skipped (unless
 * `force`, an explicit user action, which also resets backoff).
 */
function gsReadsWanted(force) {
  const now = Date.now();
  const demand = [];
  const prefetch = [];
  let nextWake = null;
  const seen = new Set();
  const tiles = (state.tiles || []).filter((t) => t && !t.blank);
  const focusedId = state.focusedTileId;
  const ordered = tiles.slice().sort((a, b) => (b.id === focusedId) - (a.id === focusedId));
  const smart = (state.smartTracks || []).filter((t) => t && t.sampleId);

  const add = (list, track, contig, cs, ce) => {
    const pin = _trackBamPin(track);
    const key = _chunkKey(track.sampleId, pin, contig, cs, ce);
    if (seen.has(key) || _chunks.has(key) || _inflightChunks.has(key)) return;
    seen.add(key);
    const f = _readsFailures.get(key);
    if (f) {
      if (force) _readsFailures.delete(key);
      else if (f.n >= _READS_MAX_ATTEMPTS) return;
      else if (f.nextAt > now) { nextWake = nextWake == null ? f.nextAt : Math.min(nextWake, f.nextAt); return; }
    }
    list.push({ key, line: _lineKey(track.sampleId, pin, contig), sample: track.sampleId, pin,
      contig, start: cs, end: ce, trackId: track.id });
  };

  let focusedComplete = true;
  for (const tile of ordered) {
    const w = _tileWindow(tile);
    if (!w.contig) continue;
    const L = gsReadTileSize(w.e - w.s + 1);
    for (const track of smart) {
      const chunks = gsChunksForWindow(track.sampleId, _trackBamPin(track), w.contig, w.s, w.e);
      const gaps = gsCoverageGaps(chunks, w.s, w.e);
      if (gaps.length && tile.id === focusedId) focusedComplete = false;
      for (const g of gaps) {
        for (let i = Math.floor((g[0] - 1) / L); i <= Math.floor((g[1] - 1) / L); i++) {
          add(demand, track, w.contig, i * L + 1, _clampEnd(w.contig, (i + 1) * L));
        }
      }
    }
  }
  // Neighbour ring for the focused tile, once it (and every demand) is satisfied.
  // Anchored on the chunks that actually cover the window — NOT on the current zoom
  // level's grid — so zooming never invents a fresh set of overlapping chunks. The
  // ring is the chunk-sized neighbour beyond each outer covering chunk; it only
  // moves outward when the window reaches those chunks.
  if (!demand.length && focusedComplete) {
    const ft = tiles.find((t) => t.id === focusedId);
    if (ft) {
      const w = _tileWindow(ft);
      const len = _chromLen(w.contig);
      for (const track of smart) {
        const pin = _trackBamPin(track);
        const chunks = gsChunksForWindow(track.sampleId, pin, w.contig, w.s, w.e);
        if (!chunks.length) continue;
        const left = chunks[0];
        const right = chunks[chunks.length - 1];
        const lsz = left.end - left.start + 1;
        const rsz = right.end - right.start + 1;
        const sides = [];
        if (left.start > 1) sides.push([Math.max(1, left.start - lsz), left.start - 1]);
        if (!(len > 0 && right.end >= len)) sides.push([right.end + 1, _clampEnd(w.contig, right.end + rsz)]);
        for (const [ns, ne] of sides) {
          const have = gsChunksForWindow(track.sampleId, pin, w.contig, ns, ne);
          if (!gsCoverageGaps(have, ns, ne).length) continue;          // already covered
          add(prefetch, track, w.contig, ns, ne);
        }
      }
    }
  }
  return { demand, prefetch, nextWake };
}

/** Anything a tile needs that is not cached / in flight / backing off? */
function gsReadsHaveDemand() {
  return gsReadsWanted(false).demand.length > 0;
}

/**
 * Recompute what is wanted and start the next batch if the kernel is free.
 * Idempotent and cheap; call it whenever the window, tiles or tracks change.
 * opts.force: explicit user trigger (focus, new tile, Go, Connect…) — ignores
 * retry backoff.
 */
function gsEnsureReads(opts) {
  const force = !!(opts && opts.force);
  const w = gsReadsWanted(force);
  _readsQueue = w.demand.concat(w.prefetch);
  if (w.nextWake != null) gsScheduleReadsReconcile(w.nextWake - Date.now() + 20);
  gsReadsPump();
  gsNotifyReadsWaiters();
}

let _pumpTimer = null;
const GS_READ_BATCH_COALESCE_MS = 25;
/**
 * Start the next batch — after a short coalescing delay, so a burst of requests (two
 * samples loaded back-to-back, a tile added right after a load) becomes ONE batch that
 * the kernel fans out in parallel, instead of one round-trip per request.
 */
function gsReadsPump() {
  if (!_gsConnected || _batchInFlight || !_readsQueue.length || _pumpTimer) return;
  _pumpTimer = setTimeout(() => { _pumpTimer = null; _gsPumpNow(); }, GS_READ_BATCH_COALESCE_MS);
}

function _gsPumpNow() {
  if (!_gsConnected || _batchInFlight || !_readsQueue.length) return;
  const descs = _readsQueue.splice(0, GS_READ_BATCH_MAX);
  _batchInFlight = { descs };
  for (const d of descs) _inflightChunks.set(d.key, d);
  if (typeof _readStatusStart === "function") _readStatusStart(descs.length === 1 ? descs[0].sample : "");
  const items = descs.map((d) => ({
    sample_id: d.sample,
    bam_url: d.pin || null,
    locus: d.contig + ":" + d.start + "-" + d.end,
  }));
  _scheduleReadsRender();      // paint the pending (dimmed) state
  let p;
  try {
    const binary = _gsWantBinaryReads();
    p = sendCommMessage("fetch_reads_batch", binary ? { items, accept_binary: true } : { items }, 300000);
    if (binary) {
      // Decode at the boundary. A failure here means the binary path does not work in this
      // host: fall back to JSON for the rest of the session and let the normal retry run.
      p = p.then((resp) => {
        try { return gsDecodeBatchResponse(resp); } catch (e) {
          window.__GS_READS_BINARY = false;
          console.warn("binary reads transport failed; retrying as JSON:", e);
          return sendCommMessage("fetch_reads_batch", { items }, 300000);   // transparent to the caller
        }
      });
    }
  } catch (e) {
    p = Promise.reject(e);
  }
  p.then((resp) => _gsOnBatchDone(descs, resp, null), (err) => _gsOnBatchDone(descs, null, err));
}

/** Has this (sample, BAM) line ever loaded a chunk (any contig)? */
function _gsLineHasData(sample, pin) {
  const prefix = sample + "|" + (pin || "") + "|";
  for (const line of _chunkLines.keys()) if (line.startsWith(prefix)) return true;
  return false;
}

/**
 * A track that has NEVER loaded anything and whose first request failed: there is
 * nothing to show and nothing to dim, so (as before) drop the empty track and say
 * why, once — a retry loop behind an empty row would only hide the problem.
 */
function _gsHardFail(descs, msgBySample) {
  const samples = Array.from(new Set(descs.map((d) => d.sample)));
  for (const d of descs) _gsRemoveTracksForLine(d);
  if (window.__GS_MODAL && !_gsReadsModalOpen) {
    _gsReadsModalOpen = true;
    const first = msgBySample.get(samples[0]) || "The read fetch failed.";
    window.__GS_MODAL(
      "Failed to load reads for " + samples.join(", ") + ".\n\n" + first
        + "\n\nCheck that you are authenticated and can access the BAM/CRAM files.",
      { title: "Failed to load reads", onClose: () => { _gsReadsModalOpen = false; } });
  }
}
let _gsReadsModalOpen = false;

function _gsRecordFailure(d, err) {
  const prev = _readsFailures.get(d.key);
  const n = (prev ? prev.n : 0) + 1;
  const delay = _readsRetryDelay(n);
  _readsFailures.set(d.key, { n, nextAt: Date.now() + delay });
  return { n, delay };
}

function _gsOnBatchDone(descs, resp, err) {
  for (const d of descs) _inflightChunks.delete(d.key);
  _batchInFlight = null;
  let failedMsg = null;
  const disconnected = !!(err && err.gsDisconnected);
  const wholeError = err
    || (resp && (resp.error || (resp.type && String(resp.type).endsWith("_error")))
      ? new Error(resp.error || "reads batch failed") : null);
  if (wholeError) {
    if (!disconnected) {
      let worst = 0;
      const hard = [];
      for (const d of descs) {
        if (!_gsLineHasData(d.sample, d.pin)) { hard.push(d); continue; }
        worst = Math.max(worst, _gsRecordFailure(d, wholeError).n);
      }
      if (hard.length) {
        _gsHardFail(hard, new Map(hard.map((d) => [d.sample, String(wholeError.message || wholeError)])));
      }
      const isTimeout = /timeout/i.test(String(wholeError.message || ""));
      if (hard.length < descs.length) {
        failedMsg = (isTimeout ? "Timed out loading reads" : "Failed to load reads")
          + (worst >= _READS_MAX_ATTEMPTS ? " — giving up (focus the tile to retry)" : " — retrying");
      }
    }
  } else {
    const hard = [];
    const hardMsg = new Map();
    const results = (resp && resp.items) || [];
    descs.forEach((d, idx) => {
      const r = results[idx];
      if (!r || r.error) {
        const msg = (r && r.error) || "no result";
        if (/no bam files found/i.test(String(msg))) { _gsRemoveTracksForLine(d); return; }
        if (!_gsLineHasData(d.sample, d.pin)) { hard.push(d); hardMsg.set(d.sample, String(msg)); return; }
        const f = _gsRecordFailure(d, new Error(msg));
        failedMsg = "Failed to load reads for " + d.sample
          + (f.n >= _READS_MAX_ATTEMPTS ? " — giving up (focus the tile to retry)" : " — retrying");
        return;
      }
      if (!r.bam_urls || !r.bam_urls.length) {          // VCF-only sample: nothing to draw
        _gsRemoveTracksForLine(d);
        return;
      }
      if (!d.pin) {                                      // unpinned track: resolve its BAM(s) first
        _gsResolveUnpinned(d, r);
        return;
      }
      _readsFailures.delete(d.key);
      gsCacheChunk(d.sample, d.pin, d.contig, d.start, d.end, r.reads || {}, r.bam_urls || []);
      for (const t of state.smartTracks || []) {
        if (t.sampleId === d.sample && _trackBamPin(t) === d.pin) {
          t.bamUrls = r.bam_urls || t.bamUrls;
          if (typeof updateSmartTrackLabel === "function") updateSmartTrackLabel(t);
        }
      }
    });
    if (hard.length) _gsHardFail(hard, hardMsg);
  }
  if (typeof _readStatusDone === "function") {
    _readStatusDone(failedMsg || (disconnected ? false : "Loaded reads"), !!failedMsg);
  }
  _scheduleReadsRender();
  gsNotifyReadsWaiters();
  // Next batch (or backoff retry) — also picks up windows that moved meanwhile.
  gsScheduleReadsReconcile(0);
}

function _gsRemoveTracksForLine(d) {
  for (const t of (state.smartTracks || []).slice()) {
    if (t.sampleId === d.sample && _trackBamPin(t) === d.pin && typeof removeSmartTrack === "function") {
      removeSmartTrack(t.id);
    }
  }
}

/** A track loaded without a BAM pin: the kernel says which BAM(s) the sample has. */
function _gsResolveUnpinned(d, r) {
  const urls = r.bam_urls.slice();
  const tracks = (state.smartTracks || []).filter((t) => t.sampleId === d.sample && !_trackBamPin(t));
  if (!tracks.length) return;
  const first = tracks[0];
  first.requestedBamUrl = urls[0];
  first.bamUrls = urls.length === 1 ? urls : first.bamUrls;
  if (urls.length === 1) {
    // Single BAM: this payload IS that BAM's chunk — keep it.
    gsCacheChunk(d.sample, urls[0], d.contig, d.start, d.end, r.reads || {}, urls);
  } else {
    // One track per BAM (like spawn does).
    for (let i = 1; i < urls.length; i++) {
      if (typeof isSampleBamTrackLoaded === "function" && isSampleBamTrackLoaded(d.sample, urls[i])) continue;
      const sib = createSmartTrack(first.strategy, first.selectedAlleles);
      sib.sampleId = d.sample;
      sib.requestedBamUrl = urls[i];
      sib.sampleType = first.sampleType || null;
    }
  }
  if (typeof updateSmartTrackLabel === "function") updateSmartTrackLabel(first);
}

// ---------------------------------------------------------------------------
// Waiters: promises for "this track has its exact reads for the focused tile"
// ---------------------------------------------------------------------------
const _readsWaiters = [];
function gsWhenTrackReady(trackId) {
  return new Promise((resolve, reject) => {
    _readsWaiters.push({ trackId, resolve, reject });
    gsNotifyReadsWaiters();
  });
}
function gsNotifyReadsWaiters() {
  if (!_readsWaiters.length) return;
  const tile = (typeof gsFocusedTile === "function") ? gsFocusedTile() : null;
  for (let i = _readsWaiters.length - 1; i >= 0; i--) {
    const w = _readsWaiters[i];
    const track = (state.smartTracks || []).find((t) => t.id === w.trackId);
    if (!track || !tile) { _readsWaiters.splice(i, 1); w.resolve(null); continue; }
    const view = gsResolveTrackView(track, tile);
    const st = gsTrackTileViewState(track, tile, view);
    if (st === "exact") { _readsWaiters.splice(i, 1); w.resolve(view ? view.layout : null); }
    else if (st === "failed") { _readsWaiters.splice(i, 1); w.reject(new Error("Failed to load reads")); }
    else if (!_gsConnected && !gsTrackTileLoading(track, tile)) {
      _readsWaiters.splice(i, 1); w.reject(gsDisconnectedError("reads"));
    }
  }
}

// Back-compat names used across the codebase.
function ensureSmartTracksForAllTiles(opts) { gsEnsureReads(opts); }
function ensureSmartTracksForCurrentLocus(opts) { gsEnsureReads(opts); }
function reloadSmartTracksForCurrentLocus() { gsEnsureReads({ force: true }); }
function gsFindReadsGaps() { return { gaps: gsReadsWanted(false).demand }; }

if (typeof window !== "undefined") {
  window.gsIsConnected = gsIsConnected;
  window.gsSetConnected = gsSetConnected;
  window.gsEnsureReads = gsEnsureReads;
  window.gsReadsWanted = gsReadsWanted;
  window.gsWhenTrackReady = gsWhenTrackReady;
  window.gsResolveTrackView = gsResolveTrackView;
  window.smartTrackReadsLayoutForTile = smartTrackReadsLayoutForTile;
  window.gsScheduleSmartReadsLoad = gsScheduleSmartReadsLoad;
  window.gsScheduleReadsReconcile = gsScheduleReadsReconcile;
  window.hydrateSmartTracksForCurrentLocus = hydrateSmartTracksForCurrentLocus;
  window.cacheLiveSmartTrackReads = cacheLiveSmartTrackReads;
  window.ensureSmartTracksForAllTiles = ensureSmartTracksForAllTiles;
  window.ensureSmartTracksForCurrentLocus = ensureSmartTracksForCurrentLocus;
  window.reloadSmartTracksForCurrentLocus = reloadSmartTracksForCurrentLocus;
  window.gsFindReadsGaps = gsFindReadsGaps;
  window.gsMergeReadPayloads = _mergeReadPayloads;
  window.gsCacheChunk = gsCacheChunk;
  window.gsCoverageGaps = gsCoverageGaps;
  window.gsReadTileSize = gsReadTileSize;
}

// Test seam: run both merges on the same input.
if (typeof window !== "undefined") {
  window.__GS_TEST_merge = (payloads, ranges, slow) =>
    (slow ? _mergeReadPayloads(payloads) : _mergeReadPayloadsFast(payloads, ranges));
}

if (typeof window !== "undefined") {
  const _b64ToView = (b64) => { const bin = atob(b64); const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new DataView(u.buffer, 0); };
  window.__GS_TEST_toViews = (b64Buffers) => (window.__GS_TEST_views = b64Buffers.map(_b64ToView)).length;
  // Decode only (buffers prepared by __GS_TEST_toViews) so timing excludes test plumbing.
  window.__GS_TEST_decodePrepared = (manifest) => gsDecodeReadsBinary(manifest, window.__GS_TEST_views);
  window.__GS_TEST_decodeReads = (manifest, b64Buffers) => gsDecodeReadsBinary(manifest, b64Buffers.map(_b64ToView));
}
