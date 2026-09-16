// UCSC Tracks tab: pick a UCSC assembly (auto-defaulting to the best match for
// this genome build) and add its interval tracks. Data rides the widget comm
// (ucsc_genomes / ucsc_list / ucsc_track).
(function setupUcscTracks() {
  if (typeof state === "undefined") return;
  state.ucscTracks = state.ucscTracks || []; // [{id, track, label, features}]
  let genomesInfo = null;   // {genomes:[{genome,label}], default, genome_build}
  let selectedGenome = "";  // currently chosen UCSC assembly
  let listing = {};         // genome -> {available, tracks, groups} (cache)
  let loadingGenomes = false;
  let loadingTracks = false;
  let trackFilter = "";
  const openGroups = new Set();

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
  function isEnabled(t) {
    return state.ucscTracks.some(u => u.track === t.track && u.genome === selectedGenome);
  }
  function trackMatches(t, f) {
    if (!f) return true;
    const hay = ((t.label || "") + " " + (t.track || "") + " " + (t.longLabel || "")).toLowerCase();
    return hay.includes(f);
  }
  function ucscVersionFamily(label) {
    const s = String(label || "").trim();
    let m = s.match(/^(.*?)\s+[Vv](\d+)\s*$/);
    if (m && m[1].trim()) return { prefix: m[1].trim(), version: parseInt(m[2], 10) };
    m = s.match(/^(.*?)\((\d+)\)\s*$/);
    if (m && m[1].trim()) return { prefix: m[1].trim(), version: parseInt(m[2], 10) };
    return null;
  }
  function clusterFamilies(tracks) {
    const byPrefix = new Map();
    const rest = [];
    for (const t of tracks) {
      const vf = ucscVersionFamily(t.label);
      if (!vf) { rest.push(t); continue; }
      if (!byPrefix.has(vf.prefix)) byPrefix.set(vf.prefix, []);
      byPrefix.get(vf.prefix).push({ t, version: vf.version });
    }
    const items = [];
    for (const [prefix, members] of byPrefix) {
      if (members.length < 2) {
        items.push({ kind: "track", track: members[0].t, sort: members[0].t.label });
        continue;
      }
      members.sort((a, b) => b.version - a.version);
      items.push({
        kind: "family",
        prefix,
        members: members.map(m => m.t),
        sort: members[0].t.label,
      });
    }
    for (const t of rest) items.push({ kind: "track", track: t, sort: t.label });
    items.sort((a, b) => String(a.sort).toLowerCase().localeCompare(String(b.sort).toLowerCase()));
    return items;
  }
  function groupsFor(info) {
    if (info.groups && info.groups.length) return info.groups;
    const seen = [];
    const have = new Set();
    for (const t of info.tracks) {
      const id = t.group || "";
      if (have.has(id)) continue;
      have.add(id);
      seen.push({ id, label: id || "Other" });
    }
    return seen;
  }

  function render() {
    const h = host(); if (!h) return;
    if (loadingGenomes) { msg("Loading UCSC assemblies…"); return; }
    if (!genomesInfo) { msg("Loading…"); return; }
    if (!genomesInfo.genomes || !genomesInfo.genomes.length) {
      msg("UCSC data is unavailable (could not reach the UCSC API)."); return;
    }
    h.innerHTML = "";

    // No auto-matched assembly: warning box right below the title.
    if (!selectedGenome) {
      const warn = document.createElement("div");
      warn.className = "ucsc-warn";
      warn.innerHTML = "<strong>⚠ No UCSC assembly auto-matched</strong> for <b>"
        + esc(genomesInfo.genome_build || "") + "</b>. Pick an appropriate reference below, "
        + "or there may be no UCSC data for this genome.";
      h.appendChild(warn);
    }

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

    if (!selectedGenome) return;  // warning shown above; wait for a manual pick

    const tracksBox = document.createElement("div");
    tracksBox.id = "ucscTracksList";
    h.appendChild(tracksBox);
    renderTrackList(tracksBox);
  }

  function appendTrackRow(parent, t) {
    const row = document.createElement("label");
    row.className = "ucsc-track-row";
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.setAttribute("data-1p-ignore", "");
    cb.checked = isEnabled(t);
    cb.addEventListener("change", () => { cb.checked ? addTrack(t) : removeTrack(t.track); });
    const span = document.createElement("span");
    span.textContent = t.label;
    span.title = (t.longLabel || t.label) + " — " + t.track + " (" + t.type + ")";
    row.appendChild(cb); row.appendChild(span); parent.appendChild(row);
  }

  function appendFamily(parent, family, filterOn) {
    const members = family.members;
    const matching = filterOn ? members.filter(t => trackMatches(t, trackFilter)) : members;
    if (!matching.length) return 0;
    const latest = matching[0];
    const older = matching.slice(1);
    appendTrackRow(parent, latest);
    if (!older.length) return matching.length;
    if (filterOn) {
      older.forEach(t => appendTrackRow(parent, t));
      return matching.length;
    }
    const extra = document.createElement("div");
    extra.className = "ucsc-track-family-older";
    extra.hidden = true;
    older.forEach(t => appendTrackRow(extra, t));
    const more = document.createElement("button");
    more.type = "button";
    more.className = "ucsc-track-family-more";
    more.textContent = older.length + " older version" + (older.length === 1 ? "" : "s");
    more.addEventListener("click", (e) => {
      e.preventDefault();
      extra.hidden = !extra.hidden;
      more.textContent = extra.hidden
        ? (older.length + " older version" + (older.length === 1 ? "" : "s"))
        : "Hide older versions";
    });
    parent.appendChild(more);
    parent.appendChild(extra);
    return matching.length;
  }

  function appendItems(parent, tracks, filterOn) {
    let n = 0;
    for (const item of clusterFamilies(tracks)) {
      if (item.kind === "family") n += appendFamily(parent, item, filterOn);
      else if (trackMatches(item.track, trackFilter)) {
        appendTrackRow(parent, item.track);
        n += 1;
      }
    }
    return n;
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
    search.className = "ucsc-track-filter";
    search.value = trackFilter;
    box.appendChild(search);

    const list = document.createElement("div");
    list.className = "ucsc-track-catalog";
    box.appendChild(list);

    const draw = () => {
      list.innerHTML = "";
      const f = (trackFilter || "").toLowerCase();
      const filterOn = !!f;
      if (state.ucscTracks.some(u => u.genome === selectedGenome)) {
        const pin = document.createElement("section");
        pin.className = "ucsc-track-enabled";
        const head = document.createElement("div");
        head.className = "ucsc-track-enabled-head";
        head.textContent = "On in this view";
        pin.appendChild(head);
        const body = document.createElement("div");
        const pinCount = appendItems(body, info.tracks.filter(t => isEnabled(t)), filterOn);
        if (pinCount) {
          pin.appendChild(body);
          list.appendChild(pin);
        }
      }

      const catalog = info.tracks.filter(t => !isEnabled(t));
      groupsFor(info).forEach(g => {
        const gid = g.id || "";
        const inGroup = catalog.filter(t => (t.group || "") === gid);
        const visible = inGroup.filter(t => trackMatches(t, f));
        if (!visible.length) return;
        const details = document.createElement("details");
        details.className = "ucsc-track-group";
        details.dataset.group = gid;
        details.open = filterOn || openGroups.has(gid);
        const summary = document.createElement("summary");
        const name = document.createElement("span");
        name.textContent = g.label || gid || "Other";
        const count = document.createElement("span");
        count.className = "ucsc-track-group-count";
        count.textContent = String(visible.length);
        summary.appendChild(name);
        summary.appendChild(count);
        details.appendChild(summary);
        const body = document.createElement("div");
        body.className = "ucsc-track-group-body";
        appendItems(body, visible, filterOn);
        details.appendChild(body);
        details.addEventListener("toggle", () => {
          if (filterOn) return;
          if (details.open) openGroups.add(gid); else openGroups.delete(gid);
        });
        list.appendChild(details);
      });
    };
    search.addEventListener("input", () => { trackFilter = search.value; draw(); });
    draw();
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
      listing[genome] = {
        available: !!resp.available,
        tracks: resp.tracks || [],
        groups: resp.groups || [],
      };
      if (window.__GS_STATUS) window.__GS_STATUS(false);
      render();
    }).catch(() => {
      loadingTracks = false;
      listing[genome] = { available: false, tracks: [], groups: [] };
      if (window.__GS_STATUS) window.__GS_STATUS("UCSC track list failed", { autoHide: 3000 });
      render();
    });
  }

  function refreshTrackList() {
    const box = document.getElementById("ucscTracksList");
    if (box) renderTrackList(box);
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
    refreshTrackList();
    fetchFeatures(entry);
  }

  function removeTrack(track) {
    state.ucscTracks = state.ucscTracks.filter(u => u.track !== track);
    state.tracks = state.tracks.filter(tr => tr.id !== "ucsc-" + track);
    if (typeof updateTracksHeight === "function") updateTracksHeight();
    if (typeof renderAll === "function") renderAll();
    refreshTrackList();
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

  window.__GS_TEST_ucscVersionFamily = ucscVersionFamily;
  window.__GS_TEST_ucscSetListing = function (genome, tracks, groups) {
    selectedGenome = genome;
    genomesInfo = {
      genomes: [{ genome: genome, label: genome }],
      default: genome,
      genome_build: genome,
    };
    listing[genome] = { available: true, tracks: tracks || [], groups: groups || [] };
    loadingGenomes = false;
    loadingTracks = false;
    render();
  };
})();
