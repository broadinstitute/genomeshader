// UCSC Tracks tab: pick a UCSC assembly (auto-defaulting to the best match for
// this genome build) and add its interval tracks. Data rides the widget comm
// (ucsc_genomes / ucsc_list / ucsc_track).
(function setupUcscTracks() {
  if (typeof state === "undefined") return;
  state.ucscTracks = state.ucscTracks || []; // [{id, track, label, features}]
  let genomesInfo = null;   // {genomes:[{genome,label}], default, genome_build}
  let selectedGenome = "";  // currently chosen UCSC assembly
  let listing = {};         // genome -> {available, tracks} (cache)
  let loadingGenomes = false;
  let loadingTracks = false;

  function host() {
    return (typeof byIdDynamic === "function" ? byIdDynamic("ucscTracksContent") : null)
      || document.getElementById("ucscTracksContent");
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  }
  function msg(html) {
    const h = host(); if (!h) return;
    h.innerHTML = '<div style="font-size:11px;color:var(--muted);padding:8px 2px;line-height:1.5;">' + html + '</div>';
  }

  function render() {
    const h = host(); if (!h) return;
    if (loadingGenomes) { msg("Loading UCSC assemblies…"); return; }
    if (!genomesInfo) { msg("Loading…"); return; }
    if (!genomesInfo.genomes || !genomesInfo.genomes.length) {
      msg("UCSC data is unavailable (could not reach the UCSC API)."); return;
    }
    h.innerHTML = "";

    // Assembly picker.
    const lbl = document.createElement("div");
    lbl.style.cssText = "font-size:11px;color:var(--muted);margin:4px 0 3px;";
    lbl.textContent = "Reference assembly";
    h.appendChild(lbl);
    const sel = document.createElement("select");
    sel.setAttribute("data-1p-ignore", "");
    sel.style.cssText = "width:100%;padding:6px 8px;margin-bottom:6px;border:1px solid var(--border2);"
      + "border-radius:6px;background:var(--panel);color:var(--text);font-size:12px;";
    if (!selectedGenome) {
      const o = document.createElement("option");
      o.value = ""; o.textContent = "— choose assembly —";
      sel.appendChild(o);
    }
    genomesInfo.genomes.forEach(g => {
      const o = document.createElement("option");
      o.value = g.genome; o.textContent = g.label || g.genome;
      if (g.genome === selectedGenome) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener("change", () => { selectedGenome = sel.value; loadTracks(selectedGenome); });
    h.appendChild(sel);

    if (!selectedGenome) {
      const note = document.createElement("div");
      note.style.cssText = "font-size:11px;color:var(--muted);padding:4px 2px;line-height:1.5;";
      note.innerHTML = "No UCSC assembly auto-matched <b>" + esc(genomesInfo.genome_build || "") + "</b>. "
        + "If there's an appropriate reference, pick it above; otherwise there is no UCSC data for this genome.";
      h.appendChild(note);
      return;
    }

    const tracksBox = document.createElement("div");
    tracksBox.id = "ucscTracksList";
    h.appendChild(tracksBox);
    renderTrackList(tracksBox);
  }

  function renderTrackList(box) {
    box.innerHTML = "";
    if (loadingTracks) { box.innerHTML = '<div style="font-size:11px;color:var(--muted);padding:6px 2px;">Loading tracks…</div>'; return; }
    const info = listing[selectedGenome];
    if (!info) { box.innerHTML = '<div style="font-size:11px;color:var(--muted);padding:6px 2px;">Loading tracks…</div>'; return; }
    if (!info.available || !info.tracks.length) {
      box.innerHTML = '<div style="font-size:11px;color:var(--muted);padding:6px 2px;">No renderable (interval) tracks for this assembly.</div>';
      return;
    }
    const search = document.createElement("input");
    search.type = "text"; search.placeholder = "Filter tracks…"; search.setAttribute("data-1p-ignore", "");
    search.style.cssText = "width:100%;padding:6px 8px;margin:2px 0 8px;border:1px solid var(--border2);"
      + "border-radius:6px;background:var(--panel);color:var(--text);font-size:12px;box-sizing:border-box;";
    box.appendChild(search);
    const list = document.createElement("div");
    box.appendChild(list);
    const draw = (f) => {
      list.innerHTML = "";
      f = (f || "").toLowerCase();
      const matches = info.tracks.filter(t => !f || t.label.toLowerCase().includes(f) || t.track.toLowerCase().includes(f));
      matches.slice(0, 300).forEach(t => {
        const row = document.createElement("label");
        row.style.cssText = "display:flex;align-items:center;gap:8px;padding:4px 2px;font-size:12px;cursor:pointer;";
        const cb = document.createElement("input");
        cb.type = "checkbox"; cb.setAttribute("data-1p-ignore", "");
        cb.checked = state.ucscTracks.some(u => u.track === t.track && u.genome === selectedGenome);
        cb.addEventListener("change", () => { cb.checked ? addTrack(t) : removeTrack(t.track); });
        const span = document.createElement("span");
        span.textContent = t.label; span.title = t.track + " (" + t.type + ")";
        span.style.cssText = "flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text);";
        row.appendChild(cb); row.appendChild(span); list.appendChild(row);
      });
      if (matches.length > 300) {
        const more = document.createElement("div");
        more.style.cssText = "font-size:10px;color:var(--muted);padding:4px 2px;";
        more.textContent = "…" + (matches.length - 300) + " more — refine the filter";
        list.appendChild(more);
      }
    };
    search.addEventListener("input", () => draw(search.value));
    draw("");
  }

  function loadGenomes() {
    if (loadingGenomes || genomesInfo) { render(); return; }
    if (typeof sendCommMessage !== "function") { msg("UCSC data channel unavailable."); return; }
    loadingGenomes = true; render();
    if (window.__GS_STATUS) window.__GS_STATUS("Loading UCSC assemblies…", { busy: true });
    sendCommMessage("ucsc_genomes", {}).then(resp => {
      loadingGenomes = false;
      genomesInfo = { genomes: resp.genomes || [], default: resp.default || "", genome_build: resp.genome_build || "" };
      selectedGenome = genomesInfo.default || "";
      if (window.__GS_STATUS) window.__GS_STATUS(false);
      render();
      if (selectedGenome) loadTracks(selectedGenome);
    }).catch(() => {
      loadingGenomes = false;
      genomesInfo = { genomes: [], default: "", genome_build: "" };
      if (window.__GS_STATUS) window.__GS_STATUS("UCSC assemblies failed", { autoHide: 3000 });
      render();
    });
  }

  function loadTracks(genome) {
    if (!genome) { render(); return; }
    if (listing[genome]) { render(); return; }
    loadingTracks = true; render();
    if (window.__GS_STATUS) window.__GS_STATUS("Loading UCSC tracks…", { busy: true });
    sendCommMessage("ucsc_list", { genome: genome }).then(resp => {
      loadingTracks = false;
      listing[genome] = { available: !!resp.available, tracks: resp.tracks || [] };
      if (window.__GS_STATUS) window.__GS_STATUS(false);
      render();
    }).catch(() => {
      loadingTracks = false;
      listing[genome] = { available: false, tracks: [] };
      if (window.__GS_STATUS) window.__GS_STATUS("UCSC track list failed", { autoHide: 3000 });
      render();
    });
  }

  function addTrack(t) {
    if (state.ucscTracks.some(u => u.track === t.track && u.genome === selectedGenome)) return;
    const id = "ucsc-" + t.track;
    const entry = { id: id, track: t.track, label: t.label, genome: selectedGenome, features: [] };
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
      track: entry.track, label: entry.label, genome: entry.genome,
      contig: state.contig, start: Math.floor(state.startBp), end: Math.ceil(state.endBp),
    }).then(resp => {
      if (!state.ucscTracks.some(u => u.id === entry.id)) return;
      entry.features = (resp && resp.features) || [];
      if (window.__GS_STATUS) window.__GS_STATUS("Loaded UCSC " + entry.label + " (" + entry.features.length + ")", { autoHide: 1800 });
      if (typeof updateTracksHeight === "function") updateTracksHeight();
      if (typeof renderAll === "function") renderAll();
    }).catch(() => {
      if (window.__GS_STATUS) window.__GS_STATUS("UCSC " + entry.label + " failed", { autoHide: 3000 });
    });
  }

  const icon = document.querySelector('.command-strip-icon[data-tab="ucsc-tracks"]');
  if (icon) icon.addEventListener("click", () => loadGenomes());
  if (typeof getActiveTab === "function" && getActiveTab() === "ucsc-tracks") loadGenomes();
})();
