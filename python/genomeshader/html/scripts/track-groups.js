// User-defined track groups: lightweight tags for sharing drawer field values.
// Distinct from sample-facet `.smart-track-group-block` clustering.

const TRACK_GROUP_PALETTE = Object.freeze([
  "#4e79a7", "#f28e2b", "#e15759", "#76b7b2",
  "#59a14f", "#edc948", "#b07aa1", "#ff9d97",
  "#9c755f", "#bab0ac", "#86bcb6", "#8cd17d",
]);

const TRACK_GROUPS_STORAGE_KEY = "genomeshader.trackGroups";

function _tgId() {
  return `tg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function loadTrackGroupsFromStorage() {
  try {
    const raw = gsLocalStorage.getItem(TRACK_GROUPS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((g) => g && g.id && Array.isArray(g.memberTrackIds))
      .map((g) => ({
        id: String(g.id),
        name: String(g.name || "Group"),
        color: String(g.color || TRACK_GROUP_PALETTE[0]),
        memberTrackIds: g.memberTrackIds.map(String),
        // Missing → true so older saved groups keep sharing edits.
        applyToGroup: g.applyToGroup !== false,
      }));
  } catch (_) {
    return [];
  }
}

function saveTrackGroupsToStorage() {
  try {
    const list = (state.trackGroups || []).map((g) => ({
      id: g.id,
      name: g.name,
      color: g.color,
      memberTrackIds: (g.memberTrackIds || []).slice(),
      applyToGroup: g.applyToGroup !== false,
    }));
    gsLocalStorage.setItem(TRACK_GROUPS_STORAGE_KEY, JSON.stringify(list));
  } catch (_) {}
}

function persistTrackGroupIds() {
  (state.smartTracks || []).forEach((t) => {
    if (!t) return;
    if (t.groupId) t.groupId = String(t.groupId);
    else t.groupId = null;
  });
  saveTrackGroupsToStorage();
  try {
    const map = {};
    (state.smartTracks || []).forEach((t) => {
      if (t && t.id && t.groupId) map[t.id] = t.groupId;
    });
    gsLocalStorage.setItem("genomeshader.trackGroupByTrack", JSON.stringify(map));
  } catch (_) {}
}

/** Refresh sidebar list + on-canvas control pills after group membership/color changes. */
function refreshTrackGroupChrome() {
  if (typeof renderSmartTracksSidebar === "function") renderSmartTracksSidebar();
  if (typeof renderAll === "function") renderAll();
  else if (typeof renderTrackControls === "function") renderTrackControls();
}

function restoreTrackGroupIdsOntoTracks() {
  let map = {};
  try {
    const raw = gsLocalStorage.getItem("genomeshader.trackGroupByTrack");
    map = raw ? JSON.parse(raw) : {};
  } catch (_) {}
  (state.smartTracks || []).forEach((t) => {
    if (!t || !t.id) return;
    const gid = map[t.id];
    t.groupId = gid ? String(gid) : null;
  });
}

function initTrackGroups() {
  if (!Array.isArray(state.trackGroups) || !state.trackGroups.length) {
    state.trackGroups = loadTrackGroupsFromStorage();
  }
  restoreTrackGroupIdsOntoTracks();
  // Drop groups whose members no longer exist; dissolve underfilled.
  const live = new Set((state.smartTracks || []).map((t) => t && t.id).filter(Boolean));
  state.trackGroups = (state.trackGroups || []).filter((g) => {
    g.memberTrackIds = (g.memberTrackIds || []).filter((id) => live.has(id));
    if (g.applyToGroup === undefined) g.applyToGroup = true;
    return g.memberTrackIds.length >= 2;
  });
  (state.smartTracks || []).forEach((t) => {
    if (!t) return;
    if (t.groupId && !getTrackGroup(t.groupId)) t.groupId = null;
  });
  persistTrackGroupIds();
}

function getTrackGroup(groupId) {
  if (!groupId) return null;
  return (state.trackGroups || []).find((g) => g && g.id === groupId) || null;
}

function getSmartTrackById(trackId) {
  return (state.smartTracks || []).find((t) => t && t.id === trackId) || null;
}

function nextTrackGroupName() {
  const used = new Set((state.trackGroups || []).map((g) => String(g.name || "")));
  let n = 1;
  while (used.has(`Group ${n}`)) n += 1;
  return `Group ${n}`;
}

function nextTrackGroupColor() {
  const used = new Set((state.trackGroups || []).map((g) => String(g.color || "").toLowerCase()));
  for (const c of TRACK_GROUP_PALETTE) {
    if (!used.has(c.toLowerCase())) return c;
  }
  return TRACK_GROUP_PALETTE[(state.trackGroups || []).length % TRACK_GROUP_PALETTE.length];
}

function _seedShareableFromResolved(track, fieldKey) {
  if (!track || !track.readDisplay) return;
  if (fieldKey === "coverageScale") {
    const resolved = resolveCoverageScale(track);
    track.readDisplay.coverageScale = {
      mode: resolved.mode,
      fixedMin: resolved.fixedMin,
      fixedMax: resolved.fixedMax,
    };
  }
}

function _revertGroupSourcesToTrack(track) {
  if (!track || !track.readDisplay) return;
  const fields = (typeof GROUP_SHAREABLE_FIELDS !== "undefined" && GROUP_SHAREABLE_FIELDS)
    || (window.__GS_GROUP_SHAREABLE_FIELDS) || ["coverageScale"];
  for (const field of fields) {
    const srcKey = `${field}Source`;
    if (track.readDisplay[srcKey] === "group") {
      _seedShareableFromResolved(track, field);
      track.readDisplay[srcKey] = "track";
    }
  }
  if (typeof saveReadDisplayForTrack === "function") saveReadDisplayForTrack(track);
}

function _setJoinGroupSources(track) {
  if (!track || !track.readDisplay) return;
  const fields = (typeof GROUP_SHAREABLE_FIELDS !== "undefined" && GROUP_SHAREABLE_FIELDS)
    || (window.__GS_GROUP_SHAREABLE_FIELDS) || ["coverageScale"];
  for (const field of fields) {
    track.readDisplay[`${field}Source`] = "group";
  }
  if (typeof saveReadDisplayForTrack === "function") saveReadDisplayForTrack(track);
}

function _ensureGroupMemberConsistency(group) {
  if (!group) return;
  group.memberTrackIds = (group.memberTrackIds || []).filter((id) => !!getSmartTrackById(id));
  if (group.memberTrackIds.length < 2) {
    dissolveTrackGroup(group.id);
  }
}

function dissolveTrackGroup(groupId) {
  const group = getTrackGroup(groupId);
  if (!group) return;
  const members = (group.memberTrackIds || []).slice();
  // Seed overrides from resolved values while group still exists.
  members.forEach((id) => {
    const t = getSmartTrackById(id);
    if (!t) return;
    _revertGroupSourcesToTrack(t);
    t.groupId = null;
  });
  state.trackGroups = (state.trackGroups || []).filter((g) => g.id !== groupId);
  persistTrackGroupIds();
  refreshTrackGroupChrome();
}

function removeTrackFromGroup(trackId) {
  const track = getSmartTrackById(trackId);
  if (!track || !track.groupId) return;
  const group = getTrackGroup(track.groupId);
  if (!group) {
    track.groupId = null;
    persistTrackGroupIds();
    return;
  }
  _revertGroupSourcesToTrack(track);
  track.groupId = null;
  group.memberTrackIds = (group.memberTrackIds || []).filter((id) => id !== trackId);
  persistTrackGroupIds();
  _ensureGroupMemberConsistency(group);
  refreshTrackGroupChrome();
}

function addTracksToGroup(groupId, trackIds) {
  const group = getTrackGroup(groupId);
  if (!group) return null;
  const ids = (trackIds || []).map(String).filter(Boolean);
  for (const id of ids) {
    const t = getSmartTrackById(id);
    if (!t) continue;
    if (t.groupId && t.groupId !== groupId) continue; // don't silently steal
    if (t.groupId === groupId) continue;
    t.groupId = groupId;
    if (!group.memberTrackIds.includes(id)) group.memberTrackIds.push(id);
    _setJoinGroupSources(t);
  }
  persistTrackGroupIds();
  refreshTrackGroupChrome();
  return group;
}

function createTrackGroup(trackIds, opts) {
  const ids = Array.from(new Set((trackIds || []).map(String).filter((id) => !!getSmartTrackById(id))));
  if (ids.length < 2) return null;

  // Pull members out of prior groups first.
  ids.forEach((id) => {
    const t = getSmartTrackById(id);
    if (t && t.groupId) removeTrackFromGroup(id);
  });

  const group = {
    id: _tgId(),
    name: (opts && opts.name) || nextTrackGroupName(),
    color: (opts && opts.color) || nextTrackGroupColor(),
    memberTrackIds: ids.slice(),
    applyToGroup: (opts && opts.applyToGroup === false) ? false : true,
  };
  state.trackGroups = state.trackGroups || [];
  state.trackGroups.push(group);
  ids.forEach((id) => {
    const t = getSmartTrackById(id);
    if (!t) return;
    t.groupId = group.id;
    _setJoinGroupSources(t);
  });
  persistTrackGroupIds();
  refreshTrackGroupChrome();
  return group;
}

function renameTrackGroup(groupId, name) {
  const group = getTrackGroup(groupId);
  if (!group) return;
  const next = String(name || "").trim();
  if (!next) return;
  group.name = next;
  persistTrackGroupIds();
}

function recolorTrackGroup(groupId, color) {
  const group = getTrackGroup(groupId);
  if (!group || !color) return;
  group.color = String(color);
  persistTrackGroupIds();
  refreshTrackGroupChrome();
}

function setTrackGroupApplyToGroup(groupId, enabled) {
  const group = getTrackGroup(groupId);
  if (!group) return;
  group.applyToGroup = !!enabled;
  persistTrackGroupIds();
}

/** Copy the source track's read-display settings onto every other group member. */
function applyReadDisplayToGroupMembers(sourceTrack, needsLayout) {
  if (!sourceTrack || !sourceTrack.groupId) return;
  const group = getTrackGroup(sourceTrack.groupId);
  if (!group || group.applyToGroup === false) return;
  const srcDisplay = sourceTrack.readDisplay;
  if (!srcDisplay) return;
  const cloneFn = (typeof cloneReadDisplayConfig === "function")
    ? cloneReadDisplayConfig
    : (window.__GS_cloneReadDisplayConfig);
  if (typeof cloneFn !== "function") return;

  for (const id of (group.memberTrackIds || [])) {
    if (id === sourceTrack.id) continue;
    const t = getSmartTrackById(id);
    if (!t) continue;
    t.readDisplay = cloneFn(srcDisplay);
    if (typeof syncTrackCollapsedFromVisibility === "function") {
      syncTrackCollapsedFromVisibility(t);
    }
    // Keep layout entry in sync when it's a separate object.
    const layoutTrack = (state.tracks || []).find((x) => x && x.id === id);
    if (layoutTrack && layoutTrack !== t) {
      layoutTrack.readDisplay = t.readDisplay;
      layoutTrack.collapsed = t.collapsed;
      layoutTrack.hidden = t.hidden;
      layoutTrack._hiddenByEmptyVisibility = t._hiddenByEmptyVisibility;
    }
    if (typeof saveReadDisplayForTrack === "function") saveReadDisplayForTrack(t);
    if (needsLayout && typeof layoutSmartTrackReads === "function") {
      layoutSmartTrackReads(t);
    }
  }
}

function resolveCoverageScale(track) {
  const fallback = (typeof DEFAULT_READ_DISPLAY !== "undefined" && DEFAULT_READ_DISPLAY.coverageScale)
    || { mode: "track", fixedMin: 0, fixedMax: 30 };
  if (!track || !track.readDisplay) return { ...fallback };
  const display = track.readDisplay;
  const useGroup = track.groupId
    && display.coverageScaleSource === "group"
    && getTrackGroup(track.groupId);
  if (useGroup) {
    const group = getTrackGroup(track.groupId);
    const lead = getSmartTrackById(group.memberTrackIds[0]);
    if (lead && lead.readDisplay && lead.readDisplay.coverageScale) {
      const s = lead.readDisplay.coverageScale;
      // Group-shared scale acts as Fixed (§6).
      return {
        mode: "fixed",
        fixedMin: Number.isFinite(Number(s.fixedMin)) ? Number(s.fixedMin) : 0,
        fixedMax: Number.isFinite(Number(s.fixedMax)) ? Number(s.fixedMax) : 30,
      };
    }
  }
  const s = display.coverageScale || fallback;
  return {
    mode: (s.mode === "view" || s.mode === "fixed") ? s.mode : "track",
    fixedMin: Number.isFinite(Number(s.fixedMin)) ? Number(s.fixedMin) : 0,
    fixedMax: Number.isFinite(Number(s.fixedMax)) ? Number(s.fixedMax) : 30,
  };
}

function setCoverageScaleSource(track, source) {
  if (!track || !track.readDisplay) return;
  if (source === "group") {
    if (!track.groupId) return;
    track.readDisplay.coverageScaleSource = "group";
  } else {
    if (track.readDisplay.coverageScaleSource === "group") {
      _seedShareableFromResolved(track, "coverageScale");
    }
    track.readDisplay.coverageScaleSource = "track";
  }
  if (typeof saveReadDisplayForTrack === "function") saveReadDisplayForTrack(track);
}

function computeTrackCoverageMax(track, genomeW, xGenomeFn, viewLo, viewHi) {
  // Multi-tile: the reads THIS tile shows for the track, never the focused
  // tile's live payload.
  let layout = track && track.readsLayout;
  if (track && typeof gsIsMultiTile === "function" && gsIsMultiTile()
      && typeof gsActiveTile === "function" && typeof smartTrackReadsLayoutForTile === "function") {
    layout = smartTrackReadsLayoutForTile(track, gsActiveTile());
  }
  const reads = layout && layout.reads;
  if (!Array.isArray(reads) || !reads.length) return 0;
  const bins = Math.max(1, Math.ceil(genomeW || 1));
  const depths = new Float32Array(bins);
  let maxD = 0;
  for (const read of reads) {
    if (read.end < viewLo || read.start > viewHi) continue;
    const xa = xGenomeFn(Math.max(read.start, viewLo), genomeW);
    const xb = xGenomeFn(Math.min(read.end, viewHi), genomeW);
    const i0 = Math.max(0, Math.min(bins - 1, Math.floor(Math.min(xa, xb))));
    const i1 = Math.max(0, Math.min(bins - 1, Math.floor(Math.max(xa, xb))));
    for (let i = i0; i <= i1; i++) {
      const d = (depths[i] += 1);
      if (d > maxD) maxD = d;
    }
  }
  return maxD;
}

function computeViewCoverageMax(genomeW, xGenomeFn, viewLo, viewHi) {
  let maxD = 0;
  for (const track of (state.smartTracks || [])) {
    if (!track || track.hidden) continue;
    const display = track.readDisplay || {};
    if (display.summaryField !== "coverage") continue;
    if (display.visibility && display.visibility.summary === false) continue;
    const d = computeTrackCoverageMax(track, genomeW, xGenomeFn, viewLo, viewHi);
    if (d > maxD) maxD = d;
  }
  return maxD;
}

function linkTracksByDrag(draggedId, targetId) {
  const dragged = getSmartTrackById(draggedId);
  const target = getSmartTrackById(targetId);
  if (!dragged || !target || draggedId === targetId) return { ok: false, reason: "invalid" };

  if (target.groupId && dragged.groupId && target.groupId !== dragged.groupId) {
    return { ok: false, reason: "already_in_group" };
  }
  if (target.groupId && !dragged.groupId) {
    // Spec: dropping onto a different-group track is no-op; dropping ungrouped
    // onto grouped — treat as add-to-target-group (dragged onto grouped).
    addTracksToGroup(target.groupId, [draggedId]);
    return { ok: true, group: getTrackGroup(target.groupId) };
  }
  if (dragged.groupId && !target.groupId) {
    addTracksToGroup(dragged.groupId, [targetId]);
    return { ok: true, group: getTrackGroup(dragged.groupId) };
  }
  if (dragged.groupId && target.groupId && dragged.groupId === target.groupId) {
    return { ok: true, group: getTrackGroup(dragged.groupId) };
  }
  // Neither grouped.
  const group = createTrackGroup([draggedId, targetId]);
  return group ? { ok: true, group } : { ok: false, reason: "invalid" };
}

function createTrackGroupFromSelection(selectedIds) {
  return createTrackGroup(selectedIds);
}

if (typeof window !== "undefined") {
  window.__GS_TRACK_GROUP_PALETTE = TRACK_GROUP_PALETTE;
  window.__GS_initTrackGroups = initTrackGroups;
  window.__GS_getTrackGroup = getTrackGroup;
  window.__GS_createTrackGroup = createTrackGroup;
  window.__GS_dissolveTrackGroup = dissolveTrackGroup;
  window.__GS_removeTrackFromGroup = removeTrackFromGroup;
  window.__GS_addTracksToGroup = addTracksToGroup;
  window.__GS_renameTrackGroup = renameTrackGroup;
  window.__GS_recolorTrackGroup = recolorTrackGroup;
  window.__GS_resolveCoverageScale = resolveCoverageScale;
  window.__GS_setCoverageScaleSource = setCoverageScaleSource;
  window.__GS_linkTracksByDrag = linkTracksByDrag;
  window.__GS_createTrackGroupFromSelection = createTrackGroupFromSelection;
  window.__GS_computeViewCoverageMax = computeViewCoverageMax;
  window.__GS_computeTrackCoverageMax = computeTrackCoverageMax;
  window.__GS_setTrackGroupApplyToGroup = setTrackGroupApplyToGroup;
  window.__GS_applyReadDisplayToGroupMembers = applyReadDisplayToGroupMembers;
}
