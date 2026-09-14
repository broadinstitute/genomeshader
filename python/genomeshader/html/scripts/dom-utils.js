// Theme + menu
// -----------------------------
// Find root container for scoping event handlers in inline mode.
// rootEl is this widget instance's container (passed into __runViewer__). Binding
// to it — not document.querySelector(...) which returns the FIRST match — is what
// lets a 2nd widget in the same notebook find its own DOM instead of the 1st's.
const root = (typeof rootEl !== 'undefined' && rootEl) ||
              document.querySelector('[id^="genomeshader-root-"]') ||
              (document.querySelector('.app')?.closest('[id^="genomeshader-root-"]')) ||
              document.body; // Fallback to body if not found

// Dynamic root lookup - finds the current container (overlay modal or original root)
// This is needed because the viewer moves to an overlay modal in full-screen mode
function getCurrentRoot() {
  // Check if we're in overlay mode by looking for the app element in an overlay.
  // Scope to this instance's root first so a 2nd widget doesn't pick up the 1st's
  // .app; fall back to document only for the moved-out fullscreen modal case.
  const appEl = (root && root.querySelector && root.querySelector('.app')) ||
                document.querySelector('.app');
  if (appEl) {
    // Check if app is inside an overlay modal
    const overlayModal = appEl.closest('[id^="genomeshader-modal-"]');
    if (overlayModal) {
      return overlayModal;
    }
    // Check if app is inside a genomeshader-root
    const gsRoot = appEl.closest('[id^="genomeshader-root-"]');
    if (gsRoot) {
      return gsRoot;
    }
  }
  return root;
}

// Root-scoped element lookup helpers
function byId(rootEl, id) {
  const el = rootEl.querySelector(`#${CSS.escape(id)}`);
  return el;
}

function $(rootEl, selector) {
  const el = rootEl.querySelector(selector);
  return el;
}

// Dynamic version that uses current root
function byIdDynamic(id) {
  return byId(getCurrentRoot(), id);
}

// Use root-scoped queries in inline mode, document queries in popup mode
const querySelector = (selector) => {
  if (hostMode === 'inline' && root && root !== document.body) {
    return root.querySelector(selector) || document.querySelector(selector);
  }
  return document.querySelector(selector);
};
const getElementById = (id) => {
  if (hostMode === 'inline' && root && root !== document.body) {
    return root.getElementById ? root.getElementById(id) : root.querySelector(`#${id}`) || document.getElementById(id);
  }
  return document.getElementById(id);
};

const app = querySelector(".app");
const sidebar = getElementById("sidebarLeft") || getElementById("sidebar");
const menuBtn = getElementById("menuBtn");
const ctxMenu = getElementById("ctxMenu");
const themeItem = getElementById("themeItem");
const themeLabel = getElementById("themeLabel");
const orientationItem = getElementById("orientationItem");
const orientationLabel = getElementById("orientationLabel");
const lockAllelesItem = getElementById("lockAllelesItem");
const lockAllelesToggle = getElementById("lockAllelesToggle");
const chromClickJumpItem = getElementById("chromClickJumpItem");
const chromClickJumpToggle = getElementById("chromClickJumpToggle");
const aggregateRareAllelesItem = getElementById("aggregateRareAllelesItem");
const aggregateRareAllelesToggle = getElementById("aggregateRareAllelesToggle");
const aggregateRareAllelesCutoffItem = getElementById("aggregateRareAllelesCutoffItem");
const aggregateRareAllelesCutoffInput = getElementById("aggregateRareAllelesCutoffInput");
const addFacetSelect = getElementById("addFacetSelect");

// Debug: Check if elements are found

// In inline mode, keep menu in root initially, but we'll move it to body when opening
// This ensures fixed positioning works relative to viewport, not container
if (hostMode === 'inline' && root && ctxMenu && !root.contains(ctxMenu)) {
  root.appendChild(ctxMenu);
}

// Sidebar collapse/expand
function getSidebarCollapsed() {
  return gsLocalStorage.getItem("genomeshader.sidebarCollapsed") === "true";
}
function setSidebarCollapsed(collapsed) {
  gsLocalStorage.setItem("genomeshader.sidebarCollapsed", String(collapsed));
  updateSidebarState();
}
function updateSidebarState() {
  const collapsed = getSidebarCollapsed();
  if (!app) {
    return;
  }
  if (collapsed) {
    app.classList.add("sidebar-collapsed");
  } else {
    app.classList.remove("sidebar-collapsed");
  }
  // Reflow so the tracks resize to the new width instead of waiting on the
  // debounced ResizeObserver (which still handles the transition tail). Use the
  // rAF-deduped scheduleRender so opening both panels at once (e.g. double-click
  // an allele) coalesces to one render instead of a renderAll storm.
  if (typeof scheduleRender === "function") scheduleRender();
  else requestAnimationFrame(() => { try { if (typeof renderAll === "function") renderAll(); } catch (e) {} });
}

// Make sidebar border clickable - always bind regardless of hostMode
if (sidebar) {
  const handleSidebarToggle = (e) => {
    // Don't toggle if clicking on menu button or menu
    if ((menuBtn && (menuBtn === e.target || menuBtn.contains(e.target))) ||
        (ctxMenu && (ctxMenu === e.target || ctxMenu.contains(e.target)))) {
      return; // Let menu button handler fire
    }
    
    // Don't intercept clicks on form elements or their containers
    const target = e.target;
    if (target.closest('select, input, button, label, .sampleStrategyControls, .sampleSearchControls, #samplePreview, #sampleContext, .sidebar-left-resize-handle')) {
      return; // Let form / resize handlers fire
    }
    
    const collapsed = getSidebarCollapsed();
    const rect = sidebar.getBoundingClientRect();
    const clickX = e.clientX - rect.left;

    // Check if click is within 8px of the right edge (or anywhere if collapsed)
    if (collapsed) {
      // When collapsed, the entire 8px strip is clickable
      e.preventDefault();
      e.stopPropagation();
      setSidebarCollapsed(false);
    } else if (clickX >= rect.width - 8) {
      // When open, only the right 8px edge is clickable
      e.preventDefault();
      e.stopPropagation();
      setSidebarCollapsed(true);
    }
    // For clicks elsewhere in the sidebar, don't stop propagation
  };
  
  // Use multiple event types with capturing phase (like debug buttons)
  sidebar.addEventListener("click", handleSidebarToggle, true);
  sidebar.addEventListener("pointerdown", handleSidebarToggle, true);
  sidebar.addEventListener("pointerup", handleSidebarToggle, true);
  sidebar.addEventListener("mousedown", handleSidebarToggle, true);
  
  // Ensure sidebar is clickable
  sidebar.style.pointerEvents = "auto";

  // Collapse is handled by the protruding edge tab (.sidebar-left::after); no
  // separate close button needed.
}

updateSidebarState();

function getStoredTheme() {
  return gsLocalStorage.getItem("genomeshader.theme"); // "dark" | "light" | "auto" | null
}
function setTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  gsLocalStorage.setItem("genomeshader.theme", theme);
  updateThemeLabel();
}
function updateThemeLabel() {
  const t = document.documentElement.getAttribute("data-theme") || "auto";
  themeLabel.textContent = t === "auto" ? "Auto" : (t === "light" ? "Light" : "Dark");
}
function getStoredOrientation() {
  return gsLocalStorage.getItem("genomeshader.orientation"); // "horizontal" | "vertical" | null
}
function setOrientation(o) {
  gsLocalStorage.setItem("genomeshader.orientation", o);
  try { if (typeof state !== "undefined" && state) state.vertScrollX = 0; } catch (e) {}
  updateOrientationState();
}
function updateOrientationState() {
  const o = getStoredOrientation() ?? "horizontal";
  // Apply on the main pane so CSS can target all track contents
  main.classList.toggle("vertical", o === "vertical");
  orientationLabel.textContent = (o === "vertical") ? "Vertical" : "Horizontal";
}
function isVerticalMode() {
  return (getStoredOrientation() ?? "horizontal") === "vertical";
}
function getStoredVariantLayoutMode() {
  return gsLocalStorage.getItem("genomeshader.variantLayoutMode"); // "equidistant" | "genomic" | null
}
function setVariantLayoutMode(mode) {
  gsLocalStorage.setItem("genomeshader.variantLayoutMode", mode);
  state.variantLayoutMode = mode;
  updateVariantLayoutModeLabel();
}
function updateVariantLayoutModeLabel() {
  const mode = state.variantLayoutMode || "genomic";
  const labelEl = document.getElementById("variantLayoutModeLabel");
  if (labelEl) {
    labelEl.textContent = mode === "equidistant" ? "Equidistant" : "Genomic";
  }
}
function getVariantLayoutMode() {
  return state.variantLayoutMode || "genomic";
}
function getStoredLockAlleles() {
  return gsLocalStorage.getItem("genomeshader.lockAlleles") === "true";
}
function setLockAlleles(enabled) {
  const v = enabled === true;
  gsLocalStorage.setItem("genomeshader.lockAlleles", v ? "true" : "false");
  state.lockAlleles = v;
  if (lockAllelesToggle) lockAllelesToggle.checked = v;
}
// Click-chromosome-to-jump: opt-in (default OFF) so a stray ideogram click
// doesn't teleport the view unexpectedly.
function getStoredChromClickJump() {
  return gsLocalStorage.getItem("genomeshader.chromClickJump") === "true";
}
function setChromClickJump(enabled) {
  const v = enabled === true;
  gsLocalStorage.setItem("genomeshader.chromClickJump", v ? "true" : "false");
  state.chromClickJump = v;
  if (chromClickJumpToggle) chromClickJumpToggle.checked = v;
}
function getStoredAggregateRareAlleles() {
  return gsLocalStorage.getItem("genomeshader.aggregateRareAlleles") === "true";
}
function setAggregateRareAlleles(enabled) {
  const v = enabled === true;
  gsLocalStorage.setItem("genomeshader.aggregateRareAlleles", v ? "true" : "false");
  state.aggregateRareAlleles = v;
  updateAggregateRareAllelesControls();
}
function getStoredAggregateRareAllelesCutoff() {
  const raw = parseFloat(gsLocalStorage.getItem("genomeshader.aggregateRareAllelesCutoffPct"));
  if (!isFinite(raw)) return 2.0;
  return Math.max(0, Math.min(50, raw));
}
function setAggregateRareAllelesCutoff(cutoffPct) {
  const clamped = Math.max(0, Math.min(50, Number(cutoffPct)));
  gsLocalStorage.setItem("genomeshader.aggregateRareAllelesCutoffPct", String(clamped));
  state.aggregateRareAllelesCutoffPct = clamped;
  updateAggregateRareAllelesControls();
}
function updateAggregateRareAllelesControls() {
  if (aggregateRareAllelesToggle) {
    aggregateRareAllelesToggle.checked = state.aggregateRareAlleles === true;
  }
  if (aggregateRareAllelesCutoffInput) {
    aggregateRareAllelesCutoffInput.value = String((state.aggregateRareAllelesCutoffPct ?? 2.0).toFixed(1));
    aggregateRareAllelesCutoffInput.disabled = state.aggregateRareAlleles !== true;
  }
}

function getStoredFacetsState() {
  try {
    const raw = gsLocalStorage.getItem("genomeshader.activeFacets");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.facets)) {
        // Drop legacy kind:"readset" entries; metadata-only (tolerate missing kind).
        const facets = parsed.facets
          .filter((f) => f && f.key && f.kind !== "readset")
          .map((f) => ({
            key: String(f.key),
            level: f.level == null || f.level === "" ? null : String(f.level),
          }));
        return {
          facets,
          colorFacetKey: parsed.colorFacetKey != null ? String(parsed.colorFacetKey) : null,
        };
      }
    }
  } catch (e) { /* ignore */ }
  // Migrate legacy single Variable key.
  const legacy = gsLocalStorage.getItem("genomeshader.groupingVariable");
  if (legacy) {
    return {
      facets: [{ key: String(legacy), level: null }],
      colorFacetKey: String(legacy),
    };
  }
  return { facets: [], colorFacetKey: null };
}
function setStoredFacetsState() {
  const payload = {
    facets: (state.activeFacets || []).map((f) => ({
      key: f.key,
      level: f.level == null ? null : String(f.level),
    })),
    colorFacetKey: state.colorFacetKey || null,
  };
  gsLocalStorage.setItem("genomeshader.activeFacets", JSON.stringify(payload));
  gsLocalStorage.removeItem("genomeshader.groupingVariable");
}

function getSampleMetadataConfig() {
  const cfg = (typeof window !== "undefined" && window.GENOMESHADER_CONFIG) || {};
  return cfg.sample_metadata || null;
}

function getGroupingEligibleColumns() {
  const meta = getSampleMetadataConfig();
  if (!meta || !Array.isArray(meta.columns)) return [];
  return meta.columns.map(c => c && c.name).filter(Boolean);
}

function getGroupingColumnSpec(columnName) {
  const meta = getSampleMetadataConfig();
  if (!meta || !Array.isArray(meta.columns) || !columnName) return null;
  return meta.columns.find(c => c && c.name === columnName) || null;
}

function getGroupColor(columnName, groupValue) {
  const spec = getGroupingColumnSpec(columnName);
  if (!spec || !Array.isArray(spec.values)) return null;
  const hit = spec.values.find(v => v && String(v.value) === String(groupValue));
  return hit && hit.color ? hit.color : null;
}

function getSampleGroupValue(sampleId, columnName) {
  if (!columnName) return null;
  const meta = getSampleMetadataConfig();
  if (!meta || !meta.by_id) return "(unlabeled)";
  const attrs = meta.by_id[String(sampleId)];
  if (!attrs || attrs[columnName] == null || attrs[columnName] === "") return "(unlabeled)";
  return String(attrs[columnName]);
}

function smartTrackSampleId(track) {
  if (!track) return null;
  if (track.sampleId) return String(track.sampleId);
  const smartMeta = (typeof state !== "undefined" && Array.isArray(state.smartTracks))
    ? state.smartTracks.find(st => st && st.id === track.id)
    : null;
  if (smartMeta && smartMeta.sampleId) return String(smartMeta.sampleId);
  return track.label ? String(track.label) : null;
}

function getMetadataFacets() {
  return (state.activeFacets || []).filter((f) => f && f.key);
}

function getColorFacetKey() {
  return state.colorFacetKey || null;
}

function getColorFacetLevel() {
  const key = getColorFacetKey();
  if (!key) return null;
  const f = getMetadataFacets().find((x) => x.key === key);
  return f && f.level != null && f.level !== "" ? String(f.level) : null;
}

function getEvidenceFilter() {
  return (state.sampleSelection && state.sampleSelection.evidenceFilter) || null;
}

function sampleHasEvidence(sampleId, evidenceLabel) {
  if (!sampleId || !evidenceLabel) return false;
  const cfg = (typeof window !== "undefined" && window.GENOMESHADER_CONFIG) || {};
  const idx = cfg.read_bam_index || {};
  const sm = cfg.sample_mapping || {};
  let urls = [];
  if (Array.isArray(idx[sampleId]) && idx[sampleId].length) urls = idx[sampleId];
  else if (Array.isArray(sm[sampleId]) && sm[sampleId].length) urls = sm[sampleId];
  if (!urls.length) return false;
  return urls.some((u) => String(getReadSetForUrl(u) || "") === String(evidenceLabel));
}

/** Metadata-facet AND sample-ID set, or null when unrestricted. Evidence is excluded. */
function compositeSampleIds() {
  const facets = getMetadataFacets().filter(
    (f) => f.level != null && f.level !== ""
  );
  if (!facets.length) return null;

  const meta = getSampleMetadataConfig();
  const cfg = (typeof window !== "undefined" && window.GENOMESHADER_CONFIG) || {};
  const universe = new Set();
  if (meta && meta.by_id) {
    Object.keys(meta.by_id).forEach((sid) => universe.add(String(sid)));
  }
  const rs = cfg.read_samples;
  if (Array.isArray(rs)) rs.forEach((sid) => universe.add(String(sid)));
  const idx = cfg.read_bam_index || {};
  Object.keys(idx).forEach((sid) => universe.add(String(sid)));
  if (!universe.size && meta && Array.isArray(meta.sample_ids)) {
    meta.sample_ids.forEach((sid) => universe.add(String(sid)));
  }

  const out = [];
  for (const sid of universe) {
    let ok = true;
    for (const f of facets) {
      const g = String(getSampleGroupValue(sid, f.key) || "(unlabeled)");
      if (g !== String(f.level)) { ok = false; break; }
    }
    if (ok) out.push(sid);
  }
  return out;
}

/**
 * Non-color active metadata levels for track labels, keys alphabetical.
 * Platform identity comes from the BAM URL, not this suffix.
 */
function compositeLabelSuffix() {
  const colorKey = getColorFacetKey();
  const parts = [];
  const facets = getMetadataFacets().filter(
    (f) => f.level != null && f.level !== ""
  );
  facets.sort((a, b) => String(a.key).localeCompare(String(b.key)));
  for (const f of facets) {
    if (colorKey && f.key === colorKey) continue;
    parts.push(String(f.level));
  }
  return parts.length ? (" · " + parts.join(" · ")) : "";
}

function isSmartTrackExcludedByFacets(track) {
  if (!track || !String(track.id || "").startsWith("smart-track-")) return false;
  const ids = compositeSampleIds();
  if (ids == null) return false;
  const sid = smartTrackSampleId(track);
  return !sid || ids.indexOf(String(sid)) < 0;
}

function isSmartTrackExcludedByGrouping(track) {
  return isSmartTrackExcludedByFacets(track);
}

function groupColorForSmartTrack(track) {
  const col = getColorFacetKey();
  if (!col || !track) return null;
  const sid = smartTrackSampleId(track);
  const g = getSampleGroupValue(sid, col);
  if (g == null) return null;
  return (typeof getGroupColor === "function") ? getGroupColor(col, g) : null;
}

function syncColorFacetKey() {
  const metaKeys = getMetadataFacets().map((f) => f.key);
  if (!metaKeys.length) {
    state.colorFacetKey = null;
    return;
  }
  if (!state.colorFacetKey || metaKeys.indexOf(state.colorFacetKey) < 0) {
    state.colorFacetKey = metaKeys[0];
  }
}

function notifyFacetsChanged() {
  setStoredFacetsState();
  renderActiveFacets();
  updateAddFacetSelect();
  if (window.ribbonTransitionCache && typeof window.ribbonTransitionCache.clear === "function") {
    window.ribbonTransitionCache.clear();
  }
  if (typeof window.clusterSmartTracksByGrouping === "function") {
    window.clusterSmartTracksByGrouping();
  }
  if (state.sampleSelection) {
    state.sampleSelection._candidateSig = null;
    state.sampleSelection._resolvedSig = null;
  }
  if (typeof recomputeCandidateSamples === "function") recomputeCandidateSamples();
  else if (typeof updateSampleSelectionUI === "function") updateSampleSelectionUI();
  if (typeof updateTracksHeight === "function") updateTracksHeight();
  if (typeof renderSmartTracksSidebar === "function") renderSmartTracksSidebar();
  if (typeof renderVariantsTabSelection === "function") renderVariantsTabSelection();
  else if (typeof window !== "undefined" && typeof window.renderVariantsTabSelection === "function") {
    window.renderVariantsTabSelection();
  }
  if (typeof window.invalidateViewportForFacets === "function") {
    window.invalidateViewportForFacets();
  }
  if (typeof renderAll === "function") renderAll();
}

function notifyEvidenceFilterChanged() {
  if (state.sampleSelection) {
    state.sampleSelection._candidateSig = null;
    state.sampleSelection._resolvedSig = null;
  }
  renderEvidenceFilter();
  if (typeof recomputeCandidateSamples === "function") recomputeCandidateSamples();
  else if (typeof updateSampleSelectionUI === "function") updateSampleSelectionUI();
  if (typeof updateTracksHeight === "function") updateTracksHeight();
  if (typeof renderSmartTracksSidebar === "function") renderSmartTracksSidebar();
  if (typeof renderAll === "function") renderAll();
}

function addMetadataFacet(columnName) {
  const cols = getGroupingEligibleColumns();
  if (!columnName || cols.indexOf(columnName) < 0) return;
  if (getMetadataFacets().some((f) => f.key === columnName)) return;
  state.activeFacets = (state.activeFacets || []).concat([{
    key: String(columnName), level: null,
  }]);
  syncColorFacetKey();
  notifyFacetsChanged();
}

function removeMetadataFacet(columnName) {
  state.activeFacets = (state.activeFacets || []).filter(
    (f) => !(f && f.key === columnName)
  );
  syncColorFacetKey();
  notifyFacetsChanged();
}

function setMetadataFacetLevel(columnName, level) {
  const f = getMetadataFacets().find((x) => x.key === columnName);
  if (!f) return;
  if (level == null || level === "" || String(level) === String(f.level)) {
    f.level = null;
  } else {
    f.level = String(level);
  }
  notifyFacetsChanged();
}

function setColorFacetKey(columnName) {
  const metaKeys = getMetadataFacets().map((f) => f.key);
  if (!columnName || metaKeys.indexOf(columnName) < 0) return;
  if (state.colorFacetKey === columnName) return;
  state.colorFacetKey = columnName;
  notifyFacetsChanged();
}

function setEvidenceFilter(label) {
  if (!state.sampleSelection) return;
  const next = (label == null || label === "") ? null : String(label);
  const cur = state.sampleSelection.evidenceFilter;
  if (next === cur || (next == null && (cur == null || cur === ""))) {
    return;
  }
  state.sampleSelection.evidenceFilter = next;
  notifyEvidenceFilterChanged();
}

// Compat alias used by older call sites / tests.
function setReadSetFilter(label) {
  setEvidenceFilter(label);
}

function updateAddFacetSelect() {
  const sel = addFacetSelect || getElementById("addFacetSelect");
  if (!sel) return;
  const cols = getGroupingEligibleColumns();
  const active = new Set(getMetadataFacets().map((f) => f.key));
  const available = cols.filter((c) => !active.has(c));
  sel.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = available.length
    ? "Add variable…"
    : (cols.length ? "All variables added" : "No metadata attached");
  sel.appendChild(placeholder);
  for (const col of available) {
    const opt = document.createElement("option");
    opt.value = col;
    opt.textContent = col;
    sel.appendChild(opt);
  }
  sel.disabled = available.length === 0;
  sel.value = "";
}

function renderActiveFacets() {
  const list = getElementById("activeFacetsList");
  const hint = getElementById("participantGroupsHint");
  if (!list) return;
  list.innerHTML = "";
  const facets = getMetadataFacets();
  if (!facets.length) {
    if (hint) {
      hint.style.display = "";
      const eligible = getGroupingEligibleColumns();
      hint.textContent = eligible.length
        ? "Add a Variable above to list participant groups."
        : "Attach sample metadata to enable participant groups.";
    }
    return;
  }
  if (hint) hint.style.display = "none";

  for (const facet of facets) {
    const col = facet.key;
    const spec = getGroupingColumnSpec(col);
    const block = document.createElement("div");
    block.className = "active-facet-block";
    block.style.marginBottom = "14px";
    block.dataset.facetKey = col;

    const header = document.createElement("div");
    header.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;";
    const title = document.createElement("div");
    title.style.cssText = "font-weight:600;font-size:12px;color:var(--text);";
    title.textContent = col;
    header.appendChild(title);

    const controls = document.createElement("div");
    controls.style.cssText = "display:flex;align-items:center;gap:8px;font-size:11px;";
    const colorLabel = document.createElement("label");
    colorLabel.style.cssText = "display:flex;align-items:center;gap:4px;cursor:pointer;color:var(--muted);";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "colorFacetKey";
    radio.value = col;
    radio.checked = getColorFacetKey() === col;
    radio.addEventListener("change", (e) => {
      e.stopPropagation();
      setColorFacetKey(col);
    });
    colorLabel.appendChild(radio);
    colorLabel.appendChild(document.createTextNode("Color by"));
    controls.appendChild(colorLabel);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.textContent = "×";
    removeBtn.title = "Remove variable";
    removeBtn.setAttribute("aria-label", "Remove " + col);
    removeBtn.style.cssText = "border:none;background:transparent;color:var(--muted);cursor:pointer;font-size:16px;line-height:1;padding:0 2px;";
    removeBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      removeMetadataFacet(col);
    });
    controls.appendChild(removeBtn);
    header.appendChild(controls);
    block.appendChild(header);

    const pills = document.createElement("div");
    const values = (spec && Array.isArray(spec.values)) ? spec.values : [];
    const allRow = document.createElement("div");
    allRow.className = "group" + (facet.level == null ? " group-active" : "");
    const allLabel = document.createElement("span");
    allLabel.textContent = "All";
    const allPill = document.createElement("span");
    allPill.className = "pill";
    const total = values.reduce((n, v) => n + (Number(v.count) || 0), 0);
    allPill.textContent = String(total);
    allRow.appendChild(allLabel);
    allRow.appendChild(allPill);
    allRow.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      setMetadataFacetLevel(col, null);
    });
    pills.appendChild(allRow);

    for (const entry of values) {
      const val = String(entry.value);
      const row = document.createElement("div");
      row.className = "group" + (facet.level === val ? " group-active" : "");
      if (entry.color) row.style.borderLeft = `3px solid ${entry.color}`;
      const label = document.createElement("span");
      label.textContent = val;
      const pill = document.createElement("span");
      pill.className = "pill";
      if (entry.color) {
        pill.style.background = entry.color;
        pill.style.color = "#fff";
      }
      pill.textContent = String(entry.count != null ? entry.count : 0);
      row.appendChild(label);
      row.appendChild(pill);
      row.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        setMetadataFacetLevel(col, val);
      });
      pills.appendChild(row);
    }
    block.appendChild(pills);
    list.appendChild(block);
  }
}

function getReadSetsConfig() {
  const cfg = (typeof window !== "undefined" && window.GENOMESHADER_CONFIG) || {};
  return cfg.read_sets || null;
}

function getReadSetForUrl(url) {
  if (!url) return null;
  const rs = getReadSetsConfig();
  if (!rs || !rs.by_url) return null;
  const hit = rs.by_url[String(url)];
  return hit != null && hit !== "" ? String(hit) : null;
}

function getReadSetColor(label) {
  const rs = getReadSetsConfig();
  if (!rs || !Array.isArray(rs.labels)) return null;
  const hit = rs.labels.find((e) => e && String(e.name) === String(label));
  return hit && hit.color ? hit.color : null;
}

function smartTrackReadSet(track) {
  if (!track) return null;
  const url = (track.requestedBamUrl)
    || (Array.isArray(track.bamUrls) && track.bamUrls.length === 1 ? track.bamUrls[0] : null);
  return getReadSetForUrl(url);
}

function renderEvidenceFilter() {
  const section = getElementById("evidenceFilterSection");
  const sel = getElementById("evidenceFilterList");
  if (!section || !sel) return;
  const rs = getReadSetsConfig();
  const labels = (rs && Array.isArray(rs.labels)) ? rs.labels : [];
  if (!labels.length) {
    section.style.display = "none";
    sel.innerHTML = "";
    return;
  }
  section.style.display = "";

  const activeLevel = getEvidenceFilter();
  const desired = activeLevel == null ? "" : String(activeLevel);

  // Rebuild options so newly attached read-set labels appear without a reload.
  const prevFocus = document.activeElement === sel;
  sel.innerHTML = "";
  const allOpt = document.createElement("option");
  allOpt.value = "";
  allOpt.textContent = "All";
  sel.appendChild(allOpt);
  for (const entry of labels) {
    const opt = document.createElement("option");
    opt.value = String(entry.name);
    opt.textContent = String(entry.name);
    sel.appendChild(opt);
  }
  // Fall back to All if the active label disappeared from config.
  sel.value = (desired && Array.from(sel.options).some((o) => o.value === desired))
    ? desired
    : "";

  if (!sel._evidenceListenerAttached) {
    sel._evidenceListenerAttached = true;
    sel.addEventListener("change", () => {
      const v = sel.value;
      setEvidenceFilter(v === "" ? null : v);
    });
  }
  if (prevFocus) {
    try { sel.focus(); } catch (e) {}
  }
}

function onReadSetsChanged(payload) {
  const cfg = window.GENOMESHADER_CONFIG || (window.GENOMESHADER_CONFIG = {});
  if (payload && Object.prototype.hasOwnProperty.call(payload, "read_sets")) {
    cfg.read_sets = payload.read_sets || null;
  }
  if (payload && payload.read_bam_index) cfg.read_bam_index = payload.read_bam_index;
  if (payload && payload.read_samples) cfg.read_samples = payload.read_samples;
  const rs = getReadSetsConfig();
  const names = (rs && Array.isArray(rs.labels)) ? rs.labels.map((e) => String(e.name)) : [];
  const cur = getEvidenceFilter();
  if (cur && names.indexOf(String(cur)) < 0 && state.sampleSelection) {
    state.sampleSelection.evidenceFilter = null;
  }
  renderEvidenceFilter();
  if (state.sampleSelection) {
    state.sampleSelection._candidateSig = null;
    state.sampleSelection._resolvedSig = null;
  }
  if (typeof recomputeCandidateSamples === "function") recomputeCandidateSamples();
  else if (typeof updateSampleSelectionUI === "function") updateSampleSelectionUI();
  if (typeof updateTracksHeight === "function") updateTracksHeight();
  if (typeof renderSmartTracksSidebar === "function") renderSmartTracksSidebar();
  if (typeof renderAll === "function") renderAll();
}

function initSampleGroupingUI() {
  const stored = getStoredFacetsState();
  const cols = getGroupingEligibleColumns();
  state.activeFacets = [];
  for (const f of (stored.facets || [])) {
    if (!f || !f.key) continue;
    if (cols.indexOf(f.key) >= 0) {
      state.activeFacets.push({
        key: String(f.key),
        level: f.level == null || f.level === "" ? null : String(f.level),
      });
    }
  }
  state.colorFacetKey = stored.colorFacetKey;
  syncColorFacetKey();
  updateAddFacetSelect();
  renderActiveFacets();
  renderEvidenceFilter();
}

function onSampleMetadataChanged(meta) {
  const cfg = window.GENOMESHADER_CONFIG || (window.GENOMESHADER_CONFIG = {});
  cfg.sample_metadata = meta || null;
  const cols = getGroupingEligibleColumns();
  state.activeFacets = (state.activeFacets || []).filter(
    (f) => f && f.key && cols.indexOf(f.key) >= 0
  );
  for (const f of state.activeFacets) f.level = null;
  syncColorFacetKey();
  setStoredFacetsState();
  updateAddFacetSelect();
  renderActiveFacets();
  if (typeof window.clusterSmartTracksByGrouping === "function") {
    window.clusterSmartTracksByGrouping();
  }
  if (typeof renderVariantsTabSelection === "function") renderVariantsTabSelection();
  else if (typeof window !== "undefined" && typeof window.renderVariantsTabSelection === "function") {
    window.renderVariantsTabSelection();
  }
  if (typeof renderAll === "function") renderAll();
}

if (typeof document !== "undefined") {
  document.addEventListener("genomeshader_msg", function (ev) {
    const msg = ev && ev.detail;
    if (!msg || !msg.type) return;
    if (msg.type === "sample_metadata_changed") {
      onSampleMetadataChanged(msg.sample_metadata || null);
    } else if (msg.type === "read_sets_changed") {
      onReadSetsChanged(msg);
    }
  });
}

if (typeof window !== "undefined") {
  window.getSampleMetadataConfig = getSampleMetadataConfig;
  window.getGroupingColumnSpec = getGroupingColumnSpec;
  window.getGroupColor = getGroupColor;
  window.getSampleGroupValue = getSampleGroupValue;
  window.smartTrackSampleId = smartTrackSampleId;
  window.getMetadataFacets = getMetadataFacets;
  window.getColorFacetKey = getColorFacetKey;
  window.getColorFacetLevel = getColorFacetLevel;
  window.getEvidenceFilter = getEvidenceFilter;
  window.sampleHasEvidence = sampleHasEvidence;
  window.compositeSampleIds = compositeSampleIds;
  window.compositeLabelSuffix = compositeLabelSuffix;
  window.isSmartTrackExcludedByFacets = isSmartTrackExcludedByFacets;
  window.isSmartTrackExcludedByGrouping = isSmartTrackExcludedByGrouping;
  window.groupColorForSmartTrack = groupColorForSmartTrack;
  window.getReadSetsConfig = getReadSetsConfig;
  window.getReadSetForUrl = getReadSetForUrl;
  window.getReadSetColor = getReadSetColor;
  window.smartTrackReadSet = smartTrackReadSet;
  window.setEvidenceFilter = setEvidenceFilter;
  window.setReadSetFilter = setReadSetFilter;
  window.addMetadataFacet = addMetadataFacet;
  window.removeMetadataFacet = removeMetadataFacet;
  window.setMetadataFacetLevel = setMetadataFacetLevel;
  window.setColorFacetKey = setColorFacetKey;
  window.renderActiveFacets = renderActiveFacets;
  window.renderEvidenceFilter = renderEvidenceFilter;
  window.onReadSetsChanged = onReadSetsChanged;
  window.initSampleGroupingUI = initSampleGroupingUI;
  window.onSampleMetadataChanged = onSampleMetadataChanged;
  window.setGroupingVariable = function (columnName) {
    state.activeFacets = [];
    if (columnName) addMetadataFacet(columnName);
    else { syncColorFacetKey(); notifyFacetsChanged(); }
  };
  window.setGroupingFilter = function (groupValue) {
    const key = getColorFacetKey() || (getMetadataFacets()[0] && getMetadataFacets()[0].key);
    if (!key) return;
    setMetadataFacetLevel(key, groupValue);
  };
  window.renderParticipantGroups = renderActiveFacets;
}

const stored = getStoredTheme();
document.documentElement.setAttribute("data-theme", stored ?? "auto");
updateThemeLabel();

// Left panel tabs (samples / groups / settings). Settings lives inline in its own
// left tab instead of a floating popup, so openMenu just switches to it.
function getActiveLeftTab() {
  return gsLocalStorage.getItem("genomeshader.leftTab") || "samples";
}
function updateLeftTab() {
  const active = getActiveLeftTab();
  const scope = getCurrentRoot() || root || document;
  scope.querySelectorAll(".left-tab-pane").forEach(p => {
    p.classList.toggle("active", p.dataset.leftTab === active);
  });
  scope.querySelectorAll(".sidebar-left-command-strip .command-strip-icon").forEach(ic => {
    ic.classList.toggle("active", ic.dataset.leftTab === active);
  });
}
function setLeftTab(name, openIfCollapsed) {
  if (!name) return;
  gsLocalStorage.setItem("genomeshader.leftTab", name);
  updateLeftTab();
  if (openIfCollapsed && getSidebarCollapsed()) setSidebarCollapsed(false);
}
function openMenu() {
  setLeftTab("settings", true);
  updateVariantLayoutModeLabel();
  updateAggregateRareAllelesControls();
}
function closeMenu() { /* settings is a persistent tab now; nothing to close */ }
function toggleMenu() { openMenu(); }

// Wire the left command-strip icons (VSCode-style activity bar):
//  - collapsed: open the panel to the clicked tab.
//  - open + clicked tab already active: collapse the panel.
//  - open + a different tab: switch to it.
(function wireLeftCommandStrip() {
  const scope = getCurrentRoot() || root || document;
  scope.querySelectorAll(".sidebar-left-command-strip .command-strip-icon").forEach(ic => {
    ic.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      const name = ic.dataset.leftTab;
      if (!name) return;
      if (getSidebarCollapsed()) { setLeftTab(name); setSidebarCollapsed(false); }
      else if (getActiveLeftTab() === name) { setSidebarCollapsed(true); }
      else { setLeftTab(name); }
    });
  });
  updateLeftTab();
})();

if (menuBtn && ctxMenu) {
  // Track if we've already handled this interaction to prevent double-toggle
  let menuButtonHandled = false;
  
  const handleMenuButtonClick = (e) => {
    // If we already handled this interaction (e.g., pointerdown), ignore subsequent events (click)
    if (menuButtonHandled && e.type !== 'pointerdown') {
      return;
    }
    e.stopPropagation(); 
    e.preventDefault();
    
    // Mark as handled and reset after a short delay
    menuButtonHandled = true;
    setTimeout(() => { menuButtonHandled = false; }, 300);
    
    toggleMenu(); 
  };
  
  // Use pointerdown as primary handler (fires first), click as fallback
  menuBtn.addEventListener("pointerdown", handleMenuButtonClick, true);
  menuBtn.addEventListener("click", handleMenuButtonClick, true);
  menuBtn.addEventListener("mousedown", handleMenuButtonClick, true);
  
  // Ensure menu button is clickable
  menuBtn.style.pointerEvents = "auto";
  menuBtn.style.cursor = "pointer";
  menuBtn.style.zIndex = "150";
  // Keep absolute positioning for bottom-left placement
  menuBtn.style.position = "absolute";
  
  // Also set onclick as fallback
  menuBtn.onclick = handleMenuButtonClick;

  // Close menu when clicking outside, but check if click is outside menu/button
  // In inline mode, use root-scoped handler to avoid Jupyter wrapper interference
  if (hostMode === 'inline' && root) {
    // Track when menu was just opened to avoid immediate close
    let menuJustOpened = false;
    const originalToggleMenu = toggleMenu;
    toggleMenu = function() {
      menuJustOpened = true;
      originalToggleMenu();
      // Reset flag after a short delay
      setTimeout(() => { menuJustOpened = false; }, 100);
    };
    
    // Use pointerdown with capturing to catch events before they bubble
    const onPointerDown = (e) => {
      // Don't close if menu was just opened (same click event)
      if (menuJustOpened) {
        return;
      }
      // Only close if menu is open and click is outside menu/button
      if (ctxMenu.classList.contains("open") && 
          !ctxMenu.contains(e.target) && 
          !menuBtn.contains(e.target)) {
        closeMenu();
      }
    };
    root.addEventListener("pointerdown", onPointerDown, true);
  } else {
    // Popup mode: use document-level handler
    document.addEventListener("click", (e) => {
      if (!ctxMenu.contains(e.target) && !menuBtn.contains(e.target)) {
        closeMenu();
      }
    });
  }
}
ctxMenu.addEventListener("click", (e) => e.stopPropagation());

themeItem.addEventListener("click", () => {
  const cur = document.documentElement.getAttribute("data-theme") || "auto";
  const next = cur === "dark" ? "light" : (cur === "light" ? "auto" : "dark");
  setTheme(next);
  renderAll();
});

if (addFacetSelect) {
  addFacetSelect.addEventListener("change", () => {
    const val = addFacetSelect.value;
    if (val) addMetadataFacet(val);
  });
}

orientationItem.addEventListener("click", () => {
  const cur = getStoredOrientation() ?? "horizontal";
  const next = (cur === "horizontal") ? "vertical" : "horizontal";
  setOrientation(next);
  renderAll();
});

// Settings: clear the on-disk + in-memory local cache on demand. Cache-only, so
// safe/reversible (re-fetched on next access) — no confirm dialog, just feedback.
const clearCacheItem = getElementById("clearCacheItem");
if (clearCacheItem) {
  clearCacheItem.addEventListener("click", () => {
    const lbl = getElementById("clearCacheLabel");
    if (typeof sendCommMessage !== "function") {
      if (window.__GS_MODAL) window.__GS_MODAL(
        "Cache clearing needs the live kernel connection, which isn't available here.",
        { title: "Local cache" });
      return;
    }
    if (lbl) lbl.textContent = "Clearing…";
    sendCommMessage("clear_cache", {}, 30000).then((resp) => {
      const files = (resp && resp.files) || 0;
      const mb = (((resp && resp.bytes) || 0) / (1024 * 1024));
      if (lbl) lbl.textContent = "Clear";
      const msg = `Local cache cleared — ${files.toLocaleString()} file(s), `
        + `${mb.toFixed(mb < 10 ? 1 : 0)} MB freed.`;
      if (window.__GS_STATUS) window.__GS_STATUS(msg, { autoHide: 3500 });
    }).catch((e) => {
      if (lbl) lbl.textContent = "Clear";
      if (window.__GS_MODAL) window.__GS_MODAL(
        "Failed to clear the local cache: " + (e && e.message ? e.message : e),
        { title: "Local cache" });
    });
  });
}

// Variant layout mode toggle in settings menu
const variantLayoutModeItem = getElementById("variantLayoutModeItem");

if (variantLayoutModeItem) {
  variantLayoutModeItem.addEventListener("click", () => {
    const cur = getVariantLayoutMode();
    const next = (cur === "equidistant") ? "genomic" : "equidistant";
    setVariantLayoutMode(next);
    renderAll();
  });
}

if (lockAllelesItem && lockAllelesToggle) {
  lockAllelesItem.addEventListener("click", (e) => {
    if (e.target === lockAllelesToggle) return;
    setLockAlleles(!(state.lockAlleles === true));
  });
  lockAllelesToggle.addEventListener("change", () => {
    setLockAlleles(lockAllelesToggle.checked);
  });
}
if (chromClickJumpItem && chromClickJumpToggle) {
  chromClickJumpItem.addEventListener("click", (e) => {
    if (e.target === chromClickJumpToggle) return;
    setChromClickJump(!(state.chromClickJump === true));
  });
  chromClickJumpToggle.addEventListener("change", () => {
    setChromClickJump(chromClickJumpToggle.checked);
  });
}
if (aggregateRareAllelesItem && aggregateRareAllelesToggle) {
  aggregateRareAllelesItem.addEventListener("click", (e) => {
    if (e.target === aggregateRareAllelesToggle) return;
    const next = !(state.aggregateRareAlleles === true);
    setAggregateRareAlleles(next);
    renderAll();
  });
  aggregateRareAllelesToggle.addEventListener("change", () => {
    setAggregateRareAlleles(aggregateRareAllelesToggle.checked);
    renderAll();
  });
}
if (aggregateRareAllelesCutoffItem && aggregateRareAllelesCutoffInput) {
  aggregateRareAllelesCutoffItem.addEventListener("click", (e) => {
    if (e.target === aggregateRareAllelesCutoffInput) return;
    aggregateRareAllelesCutoffInput.focus();
  });
  const applyCutoffFromInput = () => {
    const raw = parseFloat(aggregateRareAllelesCutoffInput.value);
    const next = isFinite(raw) ? raw : 2.0;
    setAggregateRareAllelesCutoff(next);
    renderAll();
  };
  aggregateRareAllelesCutoffInput.addEventListener("change", applyCutoffFromInput);
  aggregateRareAllelesCutoffInput.addEventListener("blur", applyCutoffFromInput);
  aggregateRareAllelesCutoffInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      applyCutoffFromInput();
      aggregateRareAllelesCutoffInput.blur();
    }
  });
}

// Load Reads button in settings menu
const loadReadsItem = getElementById("loadReadsItem");
const loadReadsLabel = getElementById("loadReadsLabel");

if (loadReadsItem) {
  loadReadsItem.addEventListener("click", () => {
    if (readsLoading) return; // Already loading
    
    loadReadsLabel.textContent = "⏳";
    fetchReadsFromPython()
      .then(() => {
        loadReadsLabel.textContent = "✓";
        setTimeout(() => { loadReadsLabel.textContent = "▶"; }, 2000);
      })
      .catch((err) => {
        loadReadsLabel.textContent = "\u00D7";  // U+00D7 (U+2717 tofu'd on some fonts)
        console.error("Failed to load reads:", err);
        setTimeout(() => { loadReadsLabel.textContent = "▶"; }, 2000);
      });
  });
}


// Fullscreen mode setup
const fullscreenItem = getElementById("fullscreenItem");
const fullscreenLabel = getElementById("fullscreenLabel");

// Resize callback for focus mode
function triggerResize() {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (webgpuCore && webgpuSupported) {
        try {
          webgpuCore.handleResize();
        } catch (error) {
          // WebGPU resize error
        }
      }
      renderAll();
    });
  });
}

// Focus mode implementation (inlined from focus_mode.js)
function installFocusMode({ viewerEl, toggleEl, viewId, onEnter, onExit }) {
  if (!viewerEl || !toggleEl || !viewId) {
    return;
  }

  let isActive = false;
  let overlay = null;
  let modal = null;
  let topbar = null;
  let placeholder = null;
  let originalParent = null;
  let originalNextSibling = null;
  let prevViewerStyle = null;

  const overlayId = `genomeshader-overlay-${viewId}`;
  const modalId = `genomeshader-modal-${viewId}`;
  const topbarId = `genomeshader-topbar-${viewId}`;
  const placeholderId = `genomeshader-placeholder-${viewId}`;
  
  // Clean up any stale overlays from previous sessions on initialization
  const staleOverlay = document.getElementById(overlayId);
  if (staleOverlay) {
    console.log(`Cleaning up stale overlay: ${overlayId}`);
    staleOverlay.remove();
  }

  function createOverlay() {
    // Remove any existing overlay with this ID first
    const existingOverlay = document.getElementById(overlayId);
    if (existingOverlay) {
      existingOverlay.remove();
    }
    
    overlay = document.createElement('div');
    overlay.id = overlayId;
    overlay.style.cssText = `
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      background: rgba(0, 0, 0, 0.75);
      display: flex;
      align-items: center;
      justify-content: center;
      pointer-events: auto;
    `;

    modal = document.createElement('div');
    modal.id = modalId;
    modal.style.cssText = `
      position: absolute;
      inset: 24px;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      background: var(--bg, #0b0d10);
      border-radius: 12px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
      pointer-events: auto;
    `;

    topbar = document.createElement('div');
    topbar.id = topbarId;
    topbar.style.cssText = `
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      border-bottom: 1px solid var(--border, rgba(255,255,255,0.10));
      background: var(--panel, #11151b);
      flex-shrink: 0;
    `;

    const title = document.createElement('div');
    title.textContent = 'Genomeshader — Full screen';
    title.style.cssText = `
      font-size: 14px;
      font-weight: 600;
      color: var(--text, rgba(255,255,255,0.92));
    `;

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '\u00D7';  // U+00D7 (U+2715 tofu'd on some fonts)
    closeBtn.setAttribute('aria-label', 'Close full screen');
    closeBtn.style.cssText = `
      width: 32px;
      height: 32px;
      border: 1px solid var(--border2, rgba(255,255,255,0.08));
      background: var(--panel2, rgba(255,255,255,0.03));
      color: var(--text, rgba(255,255,255,0.92));
      border-radius: 8px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 18px;
      line-height: 1;
      transition: all 0.15s ease;
    `;
    closeBtn.addEventListener('mouseenter', () => {
      closeBtn.style.filter = 'brightness(1.1)';
    });
    closeBtn.addEventListener('mouseleave', () => {
      closeBtn.style.filter = '';
    });
    closeBtn.addEventListener('click', exit);

    topbar.appendChild(title);
    topbar.appendChild(closeBtn);

    const modalBody = document.createElement('div');
    modalBody.style.cssText = `
      flex: 1;
      overflow: hidden;
      position: relative;
      pointer-events: auto;
      touch-action: none;
    `;

    modal.appendChild(topbar);
    modal.appendChild(modalBody);
    overlay.appendChild(modal);

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        exit();
      }
    });

    // Close menu when clicking on modal body in full-screen mode
    const handleModalBodyClick = (e) => {
      // Check if menu is open and click is outside menu and menu button
      const menuBtn = document.getElementById('menuBtn');
      const ctxMenu = document.getElementById('ctxMenu');
      if (ctxMenu && ctxMenu.classList.contains('open') &&
          !ctxMenu.contains(e.target) && 
          menuBtn && !menuBtn.contains(e.target)) {
        // Close the menu
        if (typeof closeMenu === 'function') {
          closeMenu();
        }
      }
    };
    modalBody.addEventListener('click', handleModalBodyClick, true);
    overlay._menuCloseHandler = handleModalBodyClick;
    overlay._modalBody = modalBody;

    const handleEscape = (e) => {
      if (e.key === 'Escape') {
        // First check if menu is open, close it if so
        const ctxMenu = document.getElementById('ctxMenu');
        if (ctxMenu && ctxMenu.classList.contains('open') && typeof closeMenu === 'function') {
          closeMenu();
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        // Otherwise exit full-screen mode
        if (isActive) {
          exit();
        }
      }
    };
    document.addEventListener('keydown', handleEscape);
    overlay._escapeHandler = handleEscape;

    return { overlay, modal, modalBody };
  }

  function enter() {
    if (isActive) return;

    const { overlay, modal, modalBody } = createOverlay();
    
    originalParent = viewerEl.parentNode;
    originalNextSibling = viewerEl.nextSibling;

    placeholder = document.createElement('div');
    placeholder.id = placeholderId;
    placeholder.style.cssText = `
      width: ${viewerEl.offsetWidth}px;
      height: ${viewerEl.offsetHeight}px;
      min-height: 600px;
    `;

    if (originalNextSibling) {
      originalParent.insertBefore(placeholder, originalNextSibling);
    } else {
      originalParent.appendChild(placeholder);
    }

    modalBody.appendChild(viewerEl);
    // viewerEl is the #genomeshader-root container. Its inline style pins
    // height:600px for the notebook cell; in fullscreen it must fill the modal
    // body so the whole scoped subtree — and every container-scoped CSS rule —
    // renders on the same basis as inline, just larger. Restored on exit.
    prevViewerStyle = viewerEl.getAttribute('style');
    viewerEl.style.width = '100%';
    viewerEl.style.height = '100%';
    document.body.appendChild(overlay);

    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    overlay._originalOverflow = originalOverflow;

    isActive = true;
    updateToggleLabel();

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        // Rebind interactions after DOM move
        if (typeof interactionBinding !== 'undefined' && interactionBinding) {
          interactionBinding.destroy();
        }
        // Re-find main element within the moved viewer element
        const mainAfterMove = viewerEl.querySelector ? viewerEl.querySelector("#main") : byId(root, "main");
        if (mainAfterMove && typeof bindInteractions !== 'undefined') {
          // Use root to maintain scoping, but mainAfterMove is the actual element
          interactionBinding = bindInteractions(root, state, mainAfterMove);
        }
        if (onEnter) {
          onEnter();
        }
      });
    });
  }

  function exit() {
    if (!isActive) return;

    if (overlay && overlay._originalOverflow !== undefined) {
      document.body.style.overflow = overlay._originalOverflow;
    } else {
      document.body.style.overflow = '';
    }

    if (overlay && overlay._escapeHandler) {
      document.removeEventListener('keydown', overlay._escapeHandler);
    }

    // Remove menu close handler from modal body
    if (overlay && overlay._menuCloseHandler && overlay._modalBody) {
      overlay._modalBody.removeEventListener('click', overlay._menuCloseHandler, true);
    }

    if (prevViewerStyle !== null) {
      viewerEl.setAttribute('style', prevViewerStyle);
      prevViewerStyle = null;
    }

    if (placeholder && originalParent) {
      // insertBefore throws if the reference sibling was removed from the parent
      // while we were in full screen (external DOM edits) — fall back to append
      // so exiting full screen never leaves the viewer stranded in the modal.
      try {
        if (originalNextSibling && originalNextSibling.parentNode === originalParent) {
          originalParent.insertBefore(viewerEl, originalNextSibling);
        } else {
          originalParent.appendChild(viewerEl);
        }
      } catch (e) {
        try { originalParent.appendChild(viewerEl); } catch (e2) {}
      }
      placeholder.remove();
      placeholder = null;
    }

    if (overlay) {
      overlay.remove();
      overlay = null;
      modal = null;
      topbar = null;
    }

    isActive = false;
    updateToggleLabel();

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        // Rebind interactions after DOM move
        if (typeof interactionBinding !== 'undefined' && interactionBinding) {
          interactionBinding.destroy();
        }
        // Re-find main element within the moved viewer element
        const mainAfterMove = viewerEl.querySelector ? viewerEl.querySelector("#main") : byId(root, "main");
        if (mainAfterMove && typeof bindInteractions !== 'undefined') {
          // Use root to maintain scoping, but mainAfterMove is the actual element
          interactionBinding = bindInteractions(root, state, mainAfterMove);
        }
        if (onExit) {
          onExit();
        }
      });
    });
  }

  function updateToggleLabel() {
    if (fullscreenLabel) {
      fullscreenLabel.textContent = isActive ? 'Exit full screen' : 'Enter full screen';
    }
  }

  toggleEl.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isActive) {
      exit();
    } else {
      enter();
    }
  });

  updateToggleLabel();

  return {
    enter,
    exit,
    isActive: () => isActive
  };
}

// Initialize focus mode after app is ready
// Declare interactionBinding early so it's accessible to overlay callbacks
let interactionBinding = null;

const viewId = window.GENOMESHADER_VIEW_ID || document.querySelector('[data-view-id]')?.dataset.viewId || 'default';
let focusModeController = null;
if (fullscreenItem && root && app) {
  focusModeController = installFocusMode({
    // Move the whole #genomeshader-root container (not just .app) so the
    // container-scoped CSS from widget.py keeps matching in fullscreen —
    // otherwise .app leaves its scope and the viewer falls back to unscoped
    // styles.css, diverging from inline rendering.
    viewerEl: root,
    toggleEl: fullscreenItem,
    viewId: viewId,
    onEnter: triggerResize,
    onExit: triggerResize
  });

}

// Hotkeys for Settings menu items
const handleSettingsHotkeys = (e) => {
  // Check if we're in an input field (to avoid interfering with typing)
  const isInputField = e.target.tagName === 'INPUT' || 
                      e.target.tagName === 'TEXTAREA' || 
                      e.target.isContentEditable;
  
  // Only process if not in input field and no modifier keys are pressed
  if (isInputField || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) {
    return;
  }

  const key = e.key.toLowerCase();
  
  // Theme toggle: 't'
  if (key === 't' && themeItem) {
    e.preventDefault();
    e.stopPropagation();
    const cur = document.documentElement.getAttribute("data-theme") || "auto";
    const next = cur === "dark" ? "light" : (cur === "light" ? "auto" : "dark");
    setTheme(next);
    renderAll();
    return;
  }

  // Orientation toggle: 'o'
  if (key === 'o' && orientationItem) {
    e.preventDefault();
    e.stopPropagation();
    const cur = getStoredOrientation() ?? "horizontal";
    const next = (cur === "horizontal") ? "vertical" : "horizontal";
    setOrientation(next);
    renderAll();
    return;
  }

  // Variant Layout toggle: 'v'
  if (key === 'v' && variantLayoutModeItem) {
    e.preventDefault();
    e.stopPropagation();
    const cur = getVariantLayoutMode();
    const next = (cur === "equidistant") ? "genomic" : "equidistant";
    setVariantLayoutMode(next);
    renderAll();
    return;
  }

  // Full screen toggle: 'f' (enter when off, exit when on)
  if (key === 'f' && fullscreenItem && focusModeController) {
    e.preventDefault();
    e.stopPropagation();
    if (focusModeController.isActive()) focusModeController.exit();
    else focusModeController.enter();
    return;
  }

  // Load Reads: 'r'
  if (key === 'r' && loadReadsItem && !readsLoading) {
    e.preventDefault();
    e.stopPropagation();
    loadReadsLabel.textContent = "⏳";
    fetchReadsFromPython()
      .then(() => {
        loadReadsLabel.textContent = "✓";
        setTimeout(() => { loadReadsLabel.textContent = "▶"; }, 2000);
      })
      .catch((err) => {
        loadReadsLabel.textContent = "\u00D7";  // U+00D7 (U+2717 tofu'd on some fonts)
        console.error("Failed to load reads:", err);
        setTimeout(() => { loadReadsLabel.textContent = "▶"; }, 2000);
      });
    return;
  }
};

// Add hotkey listener for all Settings menu items
document.addEventListener('keydown', handleSettingsHotkeys, true);

const mq = window.matchMedia?.("(prefers-color-scheme: light)");
mq?.addEventListener?.("change", () => {
  if ((document.documentElement.getAttribute("data-theme") || "auto") === "auto") {
    updateThemeLabel();
    renderAll();
  }
});

// Hint tooltips: show an element's title= text after a short dwell (snappier
// than the browser's native ~500ms popup and styled like the rest of the UI).
// Cost is a single timer + delegated mouseover/out — no per-frame or render
// work, so it never affects pan/zoom responsiveness.
(function setupHintTooltips() {
  const host = root || document.body;
  if (!host || host._hintTipInstalled) return;
  host._hintTipInstalled = true;
  const DWELL_MS = 375; // 75% of the ~500ms native default
  let tip = null, timer = null, current = null;
  let px = 0, py = 0; // last pointer position, so the hint shows next to the cursor

  function ensureTip() {
    if (tip && tip.isConnected) return tip;
    tip = document.createElement("div");
    tip.className = "hint-tooltip";
    tip.setAttribute("role", "tooltip");
    (getCurrentRoot() || root || document.body).appendChild(tip);
    return tip;
  }
  function hide() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (current && current.dataset && current.dataset._hintTitle != null) {
      current.setAttribute("title", current.dataset._hintTitle);
      delete current.dataset._hintTitle;
    }
    current = null;
    if (tip) tip.classList.remove("visible");
  }
  host.addEventListener("mouseover", (e) => {
    const el = e.target && e.target.closest ? e.target.closest("[title]") : null;
    if (!el || el === current) return;
    hide();
    const text = el.getAttribute("title");
    if (!text) return;
    current = el;
    px = e.clientX; py = e.clientY;
    // Suppress the native tooltip while we own this hint.
    el.dataset._hintTitle = text;
    el.removeAttribute("title");
    timer = setTimeout(() => {
      const t = ensureTip();
      t.textContent = text;
      t.classList.add("visible"); // must be displayed to measure size + origin
      // The tip is position:fixed, but a transformed/contained ancestor (the
      // widget container) can become its containing block — so clientX/Y (which
      // are viewport-relative) don't map straight to left/top. Measure the
      // containing-block origin in viewport space and subtract it.
      t.style.left = "0px"; t.style.top = "0px";
      const originRect = t.getBoundingClientRect();
      const cbX = originRect.left, cbY = originRect.top;
      const w = t.offsetWidth || 160, h = t.offsetHeight || 24;
      // Next to the cursor (viewport coords), clamped on-screen.
      let vx = px + 12, vy = py + 16;
      if (vx + w > window.innerWidth - 6) vx = Math.max(6, px - w - 12);
      if (vy + h > window.innerHeight - 6) vy = Math.max(6, py - h - 12);
      t.style.left = (vx - cbX) + "px";
      t.style.top = (vy - cbY) + "px";
      timer = null; // shown — stop tracking the pointer
    }, DWELL_MS);
  }, true);
  // Track the pointer only while a hint is pending, so the tip lands where the
  // cursor actually is (no cost outside the 375ms dwell).
  host.addEventListener("mousemove", (e) => {
    if (timer) { px = e.clientX; py = e.clientY; }
  }, true);
  host.addEventListener("mouseout", (e) => {
    // Can't match on [title] here — we removed it to suppress the native popup.
    // Hide when the pointer actually leaves `current` (into a node outside it).
    if (current && (e.target === current || current.contains(e.target))
        && (!e.relatedTarget || !current.contains(e.relatedTarget))) {
      hide();
    }
  }, true);
  host.addEventListener("click", hide, true);
})();

// Bottom status bar controller. Call window.__GS_STATUS(message, opts):
//   message   string to show, or null/false to hide the bar.
//   opts.busy      show an indeterminate progress animation.
//   opts.progress  0..1 for a determinate bar.
//   opts.autoHide  ms after which the bar hides itself.
// Available to all later scripts so any long-running action can report status.
(function setupStatusBar() {
  const bar = (typeof byId === "function" ? byId(root, "statusBar") : null)
    || document.getElementById("statusBar");
  if (!bar) { if (!window.__GS_STATUS) window.__GS_STATUS = function () {}; return; }
  const textEl = bar.querySelector(".status-text");
  const fillEl = bar.querySelector(".status-progress-fill");
  let hideTimer = null;
  function hide() {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    bar.classList.remove("visible", "has-progress", "indeterminate");
  }
  window.__GS_STATUS = function (message, opts) {
    opts = opts || {};
    if (message == null || message === false) { hide(); return; }
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    if (textEl) textEl.textContent = String(message);
    bar.classList.add("visible");
    const determinate = typeof opts.progress === "number";
    bar.classList.toggle("has-progress", determinate || !!opts.busy);
    if (determinate) {
      bar.classList.remove("indeterminate");
      if (fillEl) fillEl.style.width = Math.max(0, Math.min(100, opts.progress * 100)) + "%";
    } else if (opts.busy) {
      bar.classList.add("indeterminate");
    } else {
      bar.classList.remove("indeterminate");
    }
    if (opts.autoHide) hideTimer = setTimeout(hide, opts.autoHide);
  };
})();

// Centered blocking modal with an OK button. window.__GS_MODAL(message, opts):
//   opts.title    heading text; opts.okLabel button label (default "OK");
//   opts.onClose  called after dismiss. Dismiss via OK / Enter / Esc / backdrop.
// Overlays the widget root so it centers on the viewer, not the whole page.
(function setupModal() {
  window.__GS_MODAL = function (message, opts) {
    opts = opts || {};
    const host = (typeof getCurrentRoot === "function" ? getCurrentRoot() : null) || document.body;
    const backdrop = document.createElement("div");
    backdrop.className = "gs-modal-backdrop";
    const box = document.createElement("div");
    box.className = "gs-modal";
    box.setAttribute("role", "alertdialog");
    if (opts.title) {
      const h = document.createElement("div");
      h.className = "gs-modal-title";
      h.textContent = String(opts.title);
      box.appendChild(h);
    }
    const msg = document.createElement("div");
    msg.className = "gs-modal-msg";
    msg.textContent = String(message == null ? "" : message);
    box.appendChild(msg);
    const actions = document.createElement("div");
    actions.className = "gs-modal-actions";
    const ok = document.createElement("button");
    ok.className = "gs-modal-ok";
    ok.textContent = opts.okLabel || "OK";
    actions.appendChild(ok);
    box.appendChild(actions);
    backdrop.appendChild(box);
    host.appendChild(backdrop);

    function close() {
      try { backdrop.remove(); } catch (e) {}
      document.removeEventListener("keydown", onKey, true);
      if (typeof opts.onClose === "function") { try { opts.onClose(); } catch (e) {} }
    }
    function onKey(e) {
      if (e.key === "Escape" || e.key === "Enter") { e.preventDefault(); e.stopPropagation(); close(); }
    }
    ok.addEventListener("click", close);
    backdrop.addEventListener("mousedown", function (e) { if (e.target === backdrop) close(); });
    document.addEventListener("keydown", onKey, true);
    setTimeout(function () { try { ok.focus(); } catch (e) {} }, 0);
    return close;
  };
})();
