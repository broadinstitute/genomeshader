// UCSC Tracks tab: list interval tracks hosted at UCSC for the current genome
// and add them as interval tracks. Data rides the widget comm (ucsc_list /
// ucsc_track). Genomes not hosted at UCSC show a "not available" message.
(function setupUcscTracks() {
  if (typeof state === "undefined") return;
  state.ucscTracks = state.ucscTracks || []; // [{id, track, label, features}]
  let listing = null;      // {available, tracks, genome} once loaded
  let loadingList = false;

  function host() {
    return (typeof byIdDynamic === "function" ? byIdDynamic("ucscTracksContent") : null)
      || document.getElementById("ucscTracksContent");
  }

  function msg(html) {
    const h = host(); if (!h) return;
    h.innerHTML = '<div style="font-size:11px;color:var(--muted);padding:8px 2px;line-height:1.5;">' + html + '</div>';
  }

  function render() {
    const h = host(); if (!h) return;
    if (loadingList) { msg("Loading UCSC track list…"); return; }
    if (!listing) { msg("Loading…"); return; }
    if (!listing.available) {
      msg("No UCSC tracks for this genome (<b>" + escapeHtml(listing.genome || "") + "</b>).<br>"
        + "UCSC-hosted assemblies only (e.g. hg38, mm10). "
        + "If this <i>is</i> a UCSC genome, enable API access (GENOMESHADER_ALLOW_UCSC_API).");
      return;
    }
    h.innerHTML = "";
    const search = document.createElement("input");
    search.type = "text";
    search.placeholder = "Filter tracks…";
    search.setAttribute("data-1p-ignore", "");
    search.style.cssText = "width:100%;padding:6px 8px;margin:4px 0 8px;border:1px solid var(--border2);"
      + "border-radius:6px;background:var(--panel);color:var(--text);font-size:12px;box-sizing:border-box;";
    h.appendChild(search);
    const list = document.createElement("div");
    h.appendChild(list);

    const draw = (filter) => {
      list.innerHTML = "";
      const f = (filter || "").toLowerCase();
      const matches = listing.tracks.filter(t =>
        !f || t.label.toLowerCase().includes(f) || t.track.toLowerCase().includes(f));
      const shown = matches.slice(0, 300);
      shown.forEach(t => {
        const row = document.createElement("label");
        row.style.cssText = "display:flex;align-items:center;gap:8px;padding:4px 2px;font-size:12px;cursor:pointer;";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.setAttribute("data-1p-ignore", "");
        cb.checked = state.ucscTracks.some(u => u.track === t.track);
        cb.addEventListener("change", () => { cb.checked ? addTrack(t) : removeTrack(t.track); });
        const span = document.createElement("span");
        span.textContent = t.label;
        span.title = t.track + " (" + t.type + ")";
        span.style.cssText = "flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text);";
        row.appendChild(cb); row.appendChild(span);
        list.appendChild(row);
      });
      if (matches.length > shown.length) {
        const more = document.createElement("div");
        more.style.cssText = "font-size:10px;color:var(--muted);padding:4px 2px;";
        more.textContent = "…" + (matches.length - shown.length) + " more — refine the filter";
        list.appendChild(more);
      }
    };
    search.addEventListener("input", () => draw(search.value));
    draw("");
  }

  function loadList(force) {
    if (loadingList) return;
    if (listing && !force) { render(); return; }
    if (typeof sendCommMessage !== "function") { msg("UCSC data channel unavailable."); return; }
    loadingList = true; render();
    if (window.__GS_STATUS) window.__GS_STATUS("Loading UCSC track list…", { busy: true });
    sendCommMessage("ucsc_list", {}).then(resp => {
      loadingList = false;
      listing = { available: !!resp.available, tracks: resp.tracks || [], genome: resp.genome_build || "" };
      if (window.__GS_STATUS) window.__GS_STATUS(false);
      render();
    }).catch(() => {
      loadingList = false;
      listing = { available: false, tracks: [], genome: "" };
      if (window.__GS_STATUS) window.__GS_STATUS("UCSC track list failed", { autoHide: 3000 });
      render();
    });
  }

  function addTrack(t) {
    if (state.ucscTracks.some(u => u.track === t.track)) return;
    const id = "ucsc-" + t.track;
    const entry = { id: id, track: t.track, label: t.label, features: [] };
    state.ucscTracks.push(entry);
    if (!state.tracks.some(tr => tr.id === id)) {
      const trackDef = { id: id, label: t.label, collapsed: false, height: 30, minHeight: 18 };
      const at = state.tracks.findIndex(tr => tr.id === "flow");
      if (at >= 0) state.tracks.splice(at, 0, trackDef); else state.tracks.push(trackDef);
    }
    if (typeof updateTracksHeight === "function") updateTracksHeight();
    if (typeof renderAll === "function") renderAll();
    fetchFeatures(entry);
  }

  function removeTrack(track) {
    state.ucscTracks = state.ucscTracks.filter(u => u.track !== track);
    state.tracks = state.tracks.filter(tr => tr.id !== "ucsc-" + track);
    if (typeof updateTracksHeight === "function") updateTracksHeight();
    if (typeof renderAll === "function") renderAll();
  }

  function fetchFeatures(entry) {
    if (typeof sendCommMessage !== "function") return;
    if (window.__GS_STATUS) window.__GS_STATUS("Loading UCSC " + entry.label + "…", { busy: true });
    sendCommMessage("ucsc_track", {
      track: entry.track, label: entry.label, contig: state.contig,
      start: Math.floor(state.startBp), end: Math.ceil(state.endBp),
    }).then(resp => {
      // Track may have been removed while loading.
      if (!state.ucscTracks.some(u => u.id === entry.id)) return;
      entry.features = (resp && resp.features) || [];
      if (window.__GS_STATUS) window.__GS_STATUS("Loaded UCSC " + entry.label + " (" + entry.features.length + ")", { autoHide: 1800 });
      if (typeof updateTracksHeight === "function") updateTracksHeight();
      if (typeof renderAll === "function") renderAll();
    }).catch(() => {
      if (window.__GS_STATUS) window.__GS_STATUS("UCSC " + entry.label + " failed", { autoHide: 3000 });
    });
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  }

  // Load the list when the UCSC Tracks tab icon is clicked (lazy, once).
  const icon = document.querySelector('.command-strip-icon[data-tab="ucsc-tracks"]');
  if (icon) icon.addEventListener("click", () => loadList(false));
  // If the UCSC tab is already the active one at startup, load immediately.
  if (typeof getActiveTab === "function" && getActiveTab() === "ucsc-tracks") {
    loadList(false);
  }
})();
