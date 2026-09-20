// Multi-locus tile chrome: strip DOM, pills, resize, flip, arcs, context menu.

const GS_TILE_MIN_WIDTH_PX = 280;

function gsTileRootEl(tileId) {
  const rootEl = (typeof getCurrentRoot === "function") ? getCurrentRoot() : document;
  return rootEl.querySelector(`.gs-tile[data-tile-id="${CSS.escape(tileId)}"]`);
}

function gsTileStripEl() {
  const rootEl = (typeof getCurrentRoot === "function") ? getCurrentRoot() : document;
  return rootEl.querySelector("#tileStrip");
}

/** Build the inner body markup for a non-primary tile (unique ids per tile). */
function gsTileBodyHtml(tileId) {
  const sid = (suffix) => `${suffix}-${tileId}`;
  return `
    <div class="tracks" id="${sid("tracksContainer")}">
      <svg id="${sid("tracksSvg")}" width="100%" height="100%"></svg>
      <canvas id="${sid("tracksWebGPU")}" class="webgpu-canvas" width="100%" height="100%"></canvas>
    </div>
    <div class="flow" id="${sid("flow")}">
      <canvas class="canvas" id="${sid("flowCanvas")}"></canvas>
      <canvas id="${sid("flowWebGPU")}" class="webgpu-canvas" width="100%" height="100%"></canvas>
      <svg class="overlay" id="${sid("flowOverlay")}"></svg>
    </div>
    <svg class="flow-indel-overlay" id="${sid("flowIndelOverlay")}"></svg>
    <div id="${sid("trackControls")}"></div>`;
}

function gsTileHeaderHtml() {
  return `
    <div class="gs-tile-header" data-tile-header>
      <span class="gs-tile-letter" data-tile-letter title="Click to rename tile"></span>
      <input class="gs-tile-letter-input" data-tile-letter-input type="text" hidden
             placeholder="Name" spellcheck="false" autocomplete="off" maxlength="32">
      <span class="gs-tile-locus" data-tile-locus title="Click to edit locus"></span>
      <input class="gs-tile-locus-input" data-tile-locus-input type="text" hidden
             placeholder="chr:start-end" spellcheck="false" autocomplete="off">
      <span class="gs-tile-header-spacer" aria-hidden="true"></span>
      <div class="gs-tile-orient-seg" data-tile-orient-seg role="group" aria-label="Display orientation">
        <button type="button" class="gs-tile-orient-btn" data-orient-choice="fwd"
                title="5′ → 3′" aria-label="5′ to 3′">▶</button>
        <button type="button" class="gs-tile-orient-btn" data-orient-choice="unknown"
                title="Orientation unconfirmed" aria-label="Unconfirmed">?</button>
        <button type="button" class="gs-tile-orient-btn" data-orient-choice="rev"
                title="3′ → 5′" aria-label="3′ to 5′">◀</button>
      </div>
      <button type="button" class="gs-tile-close" data-tile-close title="Close tile" aria-label="Close tile">×</button>
    </div>
    <div class="gs-tile-orient-banner" data-tile-orient-banner hidden></div>`;
}

/**
 * Default resize handle width; widen when SA/PE-linked tiles need ribbon room.
 */
const GS_TILE_DIVIDER_PX = 8;
const GS_TILE_RIBBON_GUTTER_PX = 64;

function gsDesiredTileGutterPx() {
  if (typeof gsIsMultiTile === "function" && !gsIsMultiTile()) return GS_TILE_DIVIDER_PX;
  if (state.preferRibbonGutters) return GS_TILE_RIBBON_GUTTER_PX;
  const tiles = state.tiles || [];
  if (tiles.some((t) => t && t.linkedFromId)) return GS_TILE_RIBBON_GUTTER_PX;
  if (state.tileBundles && state.tileBundles.length) return GS_TILE_RIBBON_GUTTER_PX;
  return GS_TILE_DIVIDER_PX;
}

/** Apply divider widths + strip class for ribbon gutters. */
function gsApplyTileGutterWidths() {
  const strip = gsTileStripEl();
  if (!strip) return;
  const w = gsDesiredTileGutterPx();
  const wide = w > GS_TILE_DIVIDER_PX;
  strip.classList.toggle("has-ribbon-gutters", wide);
  strip.style.setProperty("--gs-tile-gutter", `${w}px`);
  strip.querySelectorAll(".gs-tile-divider:not(.gs-tile-end-resize)").forEach((d) => {
    d.style.flex = `0 0 ${w}px`;
    d.style.width = `${w}px`;
  });
}

/**
 * Ensure the strip DOM matches state.tiles. The first tile (t0 / original)
 * keeps the classic global ids (tracksContainer, flow, …). Extra tiles get
 * suffixed ids.
 */
function gsEnsureTileStripDom() {
  gsEnsureTilesInitialized();
  const strip = gsTileStripEl();
  if (!strip) return;

  // Remove dividers; we'll rebuild.
  strip.querySelectorAll(".gs-tile-divider").forEach((d) => d.remove());

  const existing = new Map();
  strip.querySelectorAll(".gs-tile").forEach((el) => {
    existing.set(el.getAttribute("data-tile-id"), el);
  });

  const arc = strip.querySelector("#tileArcOverlay");
  const frag = document.createDocumentFragment();

  state.tiles.forEach((tile, i) => {
    let el = existing.get(tile.id);
    if (!el) {
      el = document.createElement("div");
      el.className = "gs-tile";
      el.setAttribute("data-tile-id", tile.id);
      el.id = `tile-${tile.id}`;
      el.innerHTML = gsTileHeaderHtml() + `<div class="gs-tile-body">${gsTileBodyHtml(tile.id)}</div>`;
      gsBindTileHeaderEvents(el, tile.id);
    } else {
      existing.delete(tile.id);
      // Migrate legacy two-row headers (edit icon + separate flip switch).
      const header = el.querySelector("[data-tile-header]");
      const flipEl = header && header.querySelector("[data-tile-flip]");
      const needsMigrate = !!(header && (
        header.querySelector(".gs-tile-header-sub")
        || header.querySelector("[data-tile-edit]")
        || (flipEl && flipEl.tagName === "INPUT")
        || !header.querySelector("[data-tile-orient-seg]")
        || !el.querySelector(":scope > [data-tile-orient-banner]")
        || !header.querySelector(".gs-tile-header-spacer")
        || !header.querySelector("[data-tile-letter-input]")
      ));
      if (needsMigrate) {
        const body = el.querySelector(".gs-tile-body");
        const tmp = document.createElement("div");
        tmp.innerHTML = gsTileHeaderHtml();
        const newHeader = tmp.querySelector("[data-tile-header]");
        const newBanner = tmp.querySelector("[data-tile-orient-banner]");
        if (header && newHeader) header.replaceWith(newHeader);
        const oldBanner = el.querySelector(":scope > [data-tile-orient-banner]");
        if (newBanner) {
          if (oldBanner) oldBanner.replaceWith(newBanner);
          else if (newHeader && newHeader.nextSibling !== newBanner) {
            newHeader.insertAdjacentElement("afterend", newBanner);
          }
        }
        // Re-bind on the tile root (idempotent via __gsBound on the new header).
        if (newHeader) delete newHeader.__gsBound;
        gsBindTileHeaderEvents(el, tile.id);
        if (!body) {
          const bodyWrap = document.createElement("div");
          bodyWrap.className = "gs-tile-body";
          bodyWrap.innerHTML = gsTileBodyHtml(tile.id);
          el.appendChild(bodyWrap);
        }
      }
    }
    if (state.tiles.length === 1) {
      // Single tile always fills the strip — never keep a stale half-width.
      tile.widthPx = null;
      el.style.flex = "1 1 auto";
      el.style.width = "100%";
      el.style.maxWidth = "none";
    } else if (Number.isFinite(tile.widthPx) && tile.widthPx > 0) {
      el.style.flex = `0 0 ${tile.widthPx}px`;
      el.style.width = `${tile.widthPx}px`;
    } else {
      el.style.flex = "1 1 auto";
      el.style.width = "";
    }
    el.classList.toggle("is-focused", tile.id === state.focusedTileId);
    el.classList.toggle("is-reversed", !!tile.reversed);
    frag.appendChild(el);
    if (i < state.tiles.length - 1) {
      const div = document.createElement("div");
      div.className = "gs-tile-divider";
      div.setAttribute("data-divider-after", tile.id);
      div.title = "Drag to resize";
      gsBindDivider(div, tile.id);
      frag.appendChild(div);
    }
  });

  // Trailing resize handle on the last tile (grow/shrink width at constant pxPerBp).
  if (state.tiles.length > 1) {
    const last = state.tiles[state.tiles.length - 1];
    const end = document.createElement("div");
    end.className = "gs-tile-divider gs-tile-end-resize";
    end.setAttribute("data-resize-tile", last.id);
    end.title = "Drag to resize tile width";
    gsBindEndResize(end, last.id);
    frag.appendChild(end);
  }

  // Drop tiles no longer in state (never drop the live primary stack if it
  // somehow still holds global ids — those move with their tile id).
  existing.forEach((el) => {
    // Don't destroy the original tracksContainer ids if this was t0 renamed —
    // only remove orphaned nodes. Release the column's GPU resources first.
    if (typeof gsDisposeCanvasGpu === "function") {
      el.querySelectorAll("canvas").forEach((cv) => gsDisposeCanvasGpu(cv));
    }
    el.remove();
  });

  // Rebuild strip contents, keeping arc overlay on top.
  while (strip.firstChild) strip.removeChild(strip.firstChild);
  strip.appendChild(frag);
  if (arc) strip.appendChild(arc);
  else {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("id", "tileArcOverlay");
    svg.setAttribute("class", "gs-tile-arc-overlay");
    strip.appendChild(svg);
  }
  strip.classList.toggle("gs-single-tile", state.tiles.length <= 1);
  strip.classList.toggle("gs-multi-tile", state.tiles.length > 1);

  // Sync primary globals if focused tile is the original id set.
  gsBindTileDom(gsFocusedTile());
  // Hoist any legacy nested #trackControls out of .tracks so pills sit above .flow.
  strip.querySelectorAll(".gs-tile-body").forEach((body) => {
    const nested = body.querySelector(".tracks > #trackControls, .tracks > [id^='trackControls-']");
    if (nested && nested.parentElement !== body) body.appendChild(nested);
  });
  gsUpdateTileChrome();
  gsUpdateOrientationGate();
  gsApplyTileGutterWidths();
  if (typeof gsUpdateTileStripScrollChrome === "function") gsUpdateTileStripScrollChrome();
}

function gsBindTileDom(tile) {
  if (!tile) return;
  const el = gsTileRootEl(tile.id);
  if (!el) return;
  const body = el.querySelector(".gs-tile-body");
  if (!body) return;

  // Each tile keeps its own body permanently. Primary (t0) uses classic ids;
  // extra tiles use suffixed ids. Bind globals to whichever set this tile owns.
  const q = (id) => body.querySelector(`#${CSS.escape(id)}`)
    || body.querySelector(`#${CSS.escape(id + "-" + tile.id)}`);

  if (typeof tracksContainer !== "undefined") tracksContainer = q("tracksContainer") || tracksContainer;
  if (typeof tracksSvg !== "undefined") tracksSvg = q("tracksSvg") || tracksSvg;
  if (typeof tracksWebGPU !== "undefined") tracksWebGPU = q("tracksWebGPU") || tracksWebGPU;
  if (typeof flow !== "undefined") flow = q("flow") || flow;
  if (typeof flowCanvas !== "undefined") flowCanvas = q("flowCanvas") || flowCanvas;
  if (typeof flowWebGPU !== "undefined") flowWebGPU = q("flowWebGPU") || flowWebGPU;
  if (typeof flowOverlay !== "undefined") flowOverlay = q("flowOverlay") || flowOverlay;
  if (typeof flowIndelOverlay !== "undefined") flowIndelOverlay = q("flowIndelOverlay") || flowIndelOverlay;
  // The GPU objects follow the canvases (no-ops until the shared device exists).
  if (typeof gsBindTileGpu === "function") gsBindTileGpu();
  if (typeof gsInstallRepeatHover === "function" && tracksContainer) gsInstallRepeatHover(tracksContainer);
}

function gsBindTileHeaderEvents(el, tileId) {
  const header = el.querySelector("[data-tile-header]");
  if (!header || header.__gsBound) return;
  header.__gsBound = true;

  header.addEventListener("click", (e) => {
    if (e.target.closest("[data-tile-orient-seg], [data-tile-orient-banner]") || e.target.closest("[data-tile-close]")
        || e.target.closest("[data-tile-locus]") || e.target.closest("[data-tile-locus-input]")
        || e.target.closest("[data-tile-letter]") || e.target.closest("[data-tile-letter-input]")) {
      return;
    }
    if (typeof gsFocusTile === "function") gsFocusTile(tileId);
  });

  // Hover-to-focus (Settings → Interaction) and click-anywhere-to-focus.
  // Bound on the tile root so the whole column counts, not just the header.
  if (!el.__gsTileFocusBound) {
    el.__gsTileFocusBound = true;
    el.addEventListener("pointerenter", () => {
      state._pointerOverTileStrip = true;
      if (state.focusFollowsMouse === false) {
        if (typeof gsUpdateTileChrome === "function") gsUpdateTileChrome();
        if (typeof gsUpdateLocusBarMode === "function") gsUpdateLocusBarMode();
        return;
      }
      if (typeof gsIsMultiTile === "function" && !gsIsMultiTile()) return;
      if (state.focusedTileId === tileId) {
        if (typeof gsUpdateTileChrome === "function") gsUpdateTileChrome();
        if (typeof gsUpdateLocusBarMode === "function") gsUpdateLocusBarMode();
        return;
      }
      // Don't steal focus mid-gesture or while editing a locus/name.
      if (state.dragging || state.trackResizeState || state.trackDragState) return;
      if (state.pointers && state.pointers.size > 0) return;
      const editing = document.querySelector(
        ".gs-tile [data-tile-locus-input]:not([hidden]), .gs-tile [data-tile-letter-input]:not([hidden])"
      );
      if (editing) return;
      // Debounce hover-focus: rapid A↔B mouse travel was thrashing freeze/hydrate
      // and blanking the unfocused column.
      if (el.__gsHoverFocusTimer) clearTimeout(el.__gsHoverFocusTimer);
      el.__gsHoverFocusTimer = setTimeout(() => {
        el.__gsHoverFocusTimer = null;
        if (state.focusedTileId === tileId) return;
        if (state.dragging || (state.pointers && state.pointers.size > 0)) return;
        if (typeof gsFocusTile === "function") gsFocusTile(tileId, { scroll: false });
        else {
          if (typeof gsUpdateTileChrome === "function") gsUpdateTileChrome();
          if (typeof gsUpdateLocusBarMode === "function") gsUpdateLocusBarMode();
        }
      }, 140);
    });
    el.addEventListener("pointerleave", () => {
      if (el.__gsHoverFocusTimer) {
        clearTimeout(el.__gsHoverFocusTimer);
        el.__gsHoverFocusTimer = null;
      }
    });
    // pointerdown so focus switches before a pan/zoom gesture starts on this tile.
    el.addEventListener("pointerdown", (e) => {
      state._pointerOverTileStrip = true;
      if (el.__gsHoverFocusTimer) {
        clearTimeout(el.__gsHoverFocusTimer);
        el.__gsHoverFocusTimer = null;
      }
      if (typeof gsIsMultiTile === "function" && !gsIsMultiTile()) return;
      if (state.focusedTileId === tileId) return;
      if (e.target.closest("[data-tile-orient-seg], [data-tile-orient-banner], [data-tile-close], [data-tile-locus], [data-tile-locus-input], [data-tile-letter], [data-tile-letter-input]")) {
        return;
      }
      if (typeof gsFocusTile === "function") gsFocusTile(tileId, { scroll: false });
    });
  }

  const orientSeg = el.querySelector("[data-tile-orient-seg]");
  if (orientSeg && !orientSeg.__gsBound) {
    orientSeg.__gsBound = true;
    orientSeg.addEventListener("pointerdown", (e) => { e.stopPropagation(); });
    orientSeg.addEventListener("click", (e) => {
      e.stopPropagation();
      const btn = e.target.closest("[data-orient-choice]");
      if (!btn) return;
      const choice = btn.getAttribute("data-orient-choice");
      if (typeof gsSetTileOrientationChoice === "function") {
        gsSetTileOrientationChoice(tileId, choice);
      }
    });
  }
  const banner = el.querySelector("[data-tile-orient-banner]");
  if (banner && !banner.__gsBound) {
    banner.__gsBound = true;
    banner.addEventListener("pointerdown", (e) => { e.stopPropagation(); });
    banner.addEventListener("click", (e) => {
      const apply = e.target.closest("[data-orient-apply]");
      if (!apply) return;
      e.stopPropagation();
      if (typeof gsApplySuggestedOrientation === "function") {
        gsApplySuggestedOrientation(tileId);
      }
    });
  }

  const close = el.querySelector("[data-tile-close]");
  if (close) {
    close.addEventListener("pointerdown", (e) => { e.stopPropagation(); });
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      if (typeof gsRemoveTile === "function") gsRemoveTile(tileId);
    });
  }

  const startEdit = () => gsBeginTileLocusEdit(tileId);
  const locusSpan = el.querySelector("[data-tile-locus]");
  if (locusSpan) {
    locusSpan.addEventListener("pointerdown", (e) => { e.stopPropagation(); });
    locusSpan.addEventListener("click", (e) => {
      e.stopPropagation();
      startEdit();
    });
  }

  const letterSpan = el.querySelector("[data-tile-letter]");
  if (letterSpan) {
    letterSpan.addEventListener("pointerdown", (e) => { e.stopPropagation(); });
    letterSpan.addEventListener("click", (e) => {
      e.stopPropagation();
      gsBeginTileNameEdit(tileId);
    });
  }

  const letterInput = el.querySelector("[data-tile-letter-input]");
  if (letterInput) {
    letterInput.addEventListener("pointerdown", (e) => { e.stopPropagation(); });
    letterInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        gsCommitTileNameEdit(tileId);
      } else if (e.key === "Escape") {
        gsCancelTileNameEdit(tileId);
      }
    });
    let letterArmed = false;
    letterInput.addEventListener("focus", () => {
      letterArmed = false;
      setTimeout(() => { letterArmed = true; }, 50);
    });
    letterInput.addEventListener("blur", () => {
      if (letterArmed) gsCommitTileNameEdit(tileId);
      else gsCancelTileNameEdit(tileId);
    });
  }

  const input = el.querySelector("[data-tile-locus-input]");
  if (input) {
    input.addEventListener("pointerdown", (e) => { e.stopPropagation(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        gsCommitTileLocusEdit(tileId);
      } else if (e.key === "Escape") {
        gsCancelTileLocusEdit(tileId);
      }
    });
    // Avoid committing on the synthetic blur that can follow focus() during a
    // re-render; only commit after the user has actually interacted.
    let armed = false;
    input.addEventListener("focus", () => {
      armed = false;
      setTimeout(() => { armed = true; }, 50);
    });
    input.addEventListener("blur", () => {
      if (armed) gsCommitTileLocusEdit(tileId);
      else gsCancelTileLocusEdit(tileId);
    });
  }
}

function gsBeginTileLocusEdit(tileId) {
  const el = gsTileRootEl(tileId);
  if (!el) return;
  const tile = (state.tiles || []).find((t) => t.id === tileId);
  if (!tile) return;
  // Focus without a full renderAll first — otherwise the input we are about to
  // show loses focus immediately (blur → commit → hide).
  if (state.focusedTileId !== tileId) {
    gsPullAliasesIntoFocused();
    state.focusedTileId = tileId;
    gsSyncFocusedAliases();
    if (typeof gsUpdateLocusBarMode === "function") gsUpdateLocusBarMode();
    if (typeof gsUpdateTileChrome === "function") gsUpdateTileChrome();
  }
  const input = el.querySelector("[data-tile-locus-input]");
  const locus = el.querySelector("[data-tile-locus]");
  if (!input) return;
  input.hidden = false;
  if (locus) locus.style.display = "none";
  input.value = tile.blank ? "" : `${tile.contig}:${Math.round(tile.startBp)}-${Math.round(tile.endBp)}`;
  // Defer focus so we don't race a concurrent render/blur.
  requestAnimationFrame(() => {
    try {
      input.focus();
      input.select();
    } catch (_) { /* ignore */ }
  });
}

function gsCancelTileLocusEdit(tileId) {
  const el = gsTileRootEl(tileId);
  if (!el) return;
  const input = el.querySelector("[data-tile-locus-input]");
  const locus = el.querySelector("[data-tile-locus]");
  if (input) input.hidden = true;
  if (locus) locus.style.display = "";
}

function gsCommitTileLocusEdit(tileId) {
  const el = gsTileRootEl(tileId);
  if (!el) return;
  const input = el.querySelector("[data-tile-locus-input]");
  if (!input || input.hidden) return;
  const text = (input.value || "").trim();
  gsCancelTileLocusEdit(tileId);
  if (!text) return;
  const cfg = window.GENOMESHADER_CONFIG || {};
  const lens = cfg.chrom_lengths || (typeof chrLengths !== "undefined" ? chrLengths : {});
  const parsed = (typeof gsParseLocusInput === "function")
    ? gsParseLocusInput(text, (state.tiles.find((t) => t.id === tileId) || {}).contig, lens)
    : null;
  if (!parsed || parsed.error) {
    if (window.__GS_STATUS) window.__GS_STATUS((parsed && parsed.error) || "Bad locus", { autoHide: 3000 });
    return;
  }
  let start = parsed.start, end = parsed.end;
  if (start == null || end == null) {
    const span = 1000;
    start = 1;
    end = 1 + span;
  }
  if (typeof gsSetTileLocus === "function") {
    gsSetTileLocus(tileId, parsed.contig, start, end);
  }
  // Also drive the classic navigate path when this is the focused tile.
  if (state.focusedTileId === tileId && typeof gsGoToLocus === "function") {
    gsGoToLocus(`${parsed.contig}:${start}-${end}`);
  }
}

function gsUpdateTileChrome() {
  gsEnsureTilesInitialized();
  const multi = state.tiles.length > 1;
  // Visual focus only while the pointer is over the tile strip (multi-tile).
  const showFocus = !multi || state._pointerOverTileStrip !== false;
  state.tiles.forEach((tile) => {
    const el = gsTileRootEl(tile.id);
    if (!el) return;
    const focused = showFocus && tile.id === state.focusedTileId;
    el.classList.toggle("is-focused", focused);
    el.classList.toggle("is-reversed", !!tile.reversed);
    el.classList.toggle("is-orientation-pending", tile.orientationConfirmed === false);
    const letter = el.querySelector("[data-tile-letter]");
    const locus = el.querySelector("[data-tile-locus]");
    const orientSeg = el.querySelector("[data-tile-orient-seg]");
    const banner = el.querySelector("[data-tile-orient-banner]");
    const close = el.querySelector("[data-tile-close]");
    if (letter) {
      const display = (typeof gsTileDisplayName === "function")
        ? gsTileDisplayName(tile)
        : (tile.name || tile.letter || "");
      letter.textContent = display;
      letter.title = "Click to rename tile";
      letter.classList.toggle("is-custom", !!(tile.name && String(tile.name).trim()));
    }
    if (locus) {
      if (tile.blank) {
        locus.textContent = "(enter locus)";
        locus.title = "Click to edit locus";
      } else {
        const s = (typeof gsTileLocusString === "function") ? gsTileLocusString(tile) : "";
        const spanBp = (typeof gsTileSpanBp === "function") ? gsTileSpanBp(tile) : Math.max(1, (tile.endBp || 0) - (tile.startBp || 0));
        const spanTxt = (typeof gsFormatTileSpan === "function")
          ? gsFormatTileSpan(spanBp)
          : `${Math.round(spanBp / 1000)} kb`;
        locus.textContent = s ? `${s} (${spanTxt})` : "";
        locus.title = s ? `${s} · ${spanTxt}` : "Click to edit locus";
      }
    }
    if (orientSeg) {
      const pending = tile.orientationConfirmed === false;
      const choice = pending ? "unknown" : (tile.reversed ? "rev" : "fwd");
      orientSeg.querySelectorAll("[data-orient-choice]").forEach((btn) => {
        const c = btn.getAttribute("data-orient-choice");
        btn.classList.toggle("is-active", c === choice);
        btn.setAttribute("aria-pressed", c === choice ? "true" : "false");
      });
    }
    if (banner) {
      const pending = tile.orientationConfirmed === false;
      const ev = tile.orientationEvidence;
      if (pending && ev && ev.total > 0) {
        banner.hidden = false;
        banner.innerHTML = `Suggested: <strong>${ev.label}</strong> — `
          + `${ev.agree} of ${ev.total} split reads agree `
          + `<button type="button" class="gs-tile-orient-apply" data-orient-apply>Apply</button>`;
      } else {
        banner.hidden = true;
        banner.innerHTML = "";
      }
    }
    if (close) close.hidden = !multi;
  });
}

function gsBeginTileNameEdit(tileId) {
  const el = gsTileRootEl(tileId);
  if (!el) return;
  const tile = (state.tiles || []).find((t) => t.id === tileId);
  if (!tile) return;
  if (state.focusedTileId !== tileId) {
    gsPullAliasesIntoFocused();
    state.focusedTileId = tileId;
    gsSyncFocusedAliases();
    if (typeof gsUpdateLocusBarMode === "function") gsUpdateLocusBarMode();
    if (typeof gsUpdateTileChrome === "function") gsUpdateTileChrome();
  }
  // Cancel an open locus edit in this header first.
  const locusInput = el.querySelector("[data-tile-locus-input]");
  const locusSpan = el.querySelector("[data-tile-locus]");
  if (locusInput && !locusInput.hidden) {
    locusInput.hidden = true;
    if (locusSpan) locusSpan.style.display = "";
  }
  const input = el.querySelector("[data-tile-letter-input]");
  const letter = el.querySelector("[data-tile-letter]");
  if (!input) return;
  input.hidden = false;
  if (letter) letter.style.display = "none";
  input.value = (tile.name && String(tile.name).trim())
    ? String(tile.name).trim()
    : (tile.letter || "");
  requestAnimationFrame(() => {
    try {
      input.focus();
      input.select();
    } catch (_) {}
  });
}

function gsCancelTileNameEdit(tileId) {
  const el = gsTileRootEl(tileId);
  if (!el) return;
  const input = el.querySelector("[data-tile-letter-input]");
  const letter = el.querySelector("[data-tile-letter]");
  if (input) input.hidden = true;
  if (letter) letter.style.display = "";
}

function gsCommitTileNameEdit(tileId) {
  const el = gsTileRootEl(tileId);
  if (!el) return;
  const tile = (state.tiles || []).find((t) => t.id === tileId);
  const input = el.querySelector("[data-tile-letter-input]");
  if (!tile || !input) {
    gsCancelTileNameEdit(tileId);
    return;
  }
  const raw = String(input.value || "").trim();
  // Empty (or equal to the default letter) clears the custom name.
  if (!raw || raw === tile.letter) tile.name = null;
  else tile.name = raw.slice(0, 32);
  gsCancelTileNameEdit(tileId);
  if (typeof gsUpdateTileChrome === "function") gsUpdateTileChrome();
  if (typeof gsUpdateLocusBarMode === "function") gsUpdateLocusBarMode();
}

function gsScrollTileIntoView(tileId) {
  const el = gsTileRootEl(tileId);
  if (el && el.scrollIntoView) {
    el.scrollIntoView({ behavior: "smooth", inline: "nearest", block: "nearest" });
  }
  // Keep the matching locus-bar pill visible too.
  const pills = document.querySelector(".gs-tile-pills");
  const pill = pills && pills.querySelector(`.gs-tile-pill[data-tile-id="${CSS.escape(tileId)}"]`);
  if (pill && pill.scrollIntoView) {
    pill.scrollIntoView({ behavior: "smooth", inline: "nearest", block: "nearest" });
  }
}

/** True when the multi-tile strip overflows and can scroll horizontally. */
function gsTileStripCanScroll() {
  if (typeof gsIsMultiTile === "function" && !gsIsMultiTile()) return false;
  const strip = gsTileStripEl();
  if (!strip) return false;
  return strip.scrollWidth > strip.clientWidth + 1;
}

/**
 * Scroll the tile strip by dx pixels. Returns true if the scroll position changed.
 * Wheel uses instant scrolling; chevron clicks may pass smooth:true.
 */
function gsScrollTileStripBy(dx, { smooth = false } = {}) {
  const strip = gsTileStripEl();
  if (!strip || !Number.isFinite(dx) || dx === 0) return false;
  const max = strip.scrollWidth - strip.clientWidth;
  if (max <= 0) return false;
  const next = Math.max(0, Math.min(max, strip.scrollLeft + dx));
  if (Math.abs(next - strip.scrollLeft) < 0.5) return false;
  if (smooth) strip.scrollTo({ left: next, behavior: "smooth" });
  else strip.scrollLeft = next;
  gsUpdateTileStripScrollChrome();
  return true;
}

/** Scroll roughly one viewport of tiles left (dir=-1) or right (dir=+1). */
function gsScrollTileStripPage(dir) {
  const strip = gsTileStripEl();
  if (!strip) return false;
  const amount = Math.max(200, Math.floor(strip.clientWidth * 0.8)) * (dir < 0 ? -1 : 1);
  return gsScrollTileStripBy(amount, { smooth: true });
}

/**
 * Route a wheel event to tile-strip scrolling when appropriate.
 * Returns true if the event was consumed (caller should not pan/zoom).
 *
 * Only non-track chrome scrolls panes — headers, dividers, locus-bar pills /
 * chevrons, and strip gaps outside .gs-tile-body. Gestures over track canvases
 * keep normal genomic pan / zoom / reads-scroll behavior.
 */
function gsMaybeScrollTileStripFromWheel(e) {
  if (typeof gsIsMultiTile === "function" && !gsIsMultiTile()) return false;
  if (e.ctrlKey || e.metaKey) return false;
  if (!gsTileStripCanScroll()) return false;

  const t = e.target;
  const closest = (sel) => (t && t.closest ? t.closest(sel) : null);
  const strip = gsTileStripEl();

  // Track content must never be intercepted for pane scrolling.
  if (closest(".gs-tile-body")) return false;

  const overPills = !!closest(".gs-tile-pills, .gs-tile-pill");
  const overHeader = !!closest(".gs-tile-header");
  const overDivider = !!closest(".gs-tile-divider");
  const overChevron = !!closest(".gs-tile-strip-chevron");
  const overStripChrome = !!(strip && (strip === t || (
    strip.contains(t) && !closest(".gs-tile-body")
  )));

  const inChrome = overHeader || overDivider || overChevron || overPills || overStripChrome;
  if (!inChrome) return false;

  const dx = e.deltaX || 0;
  const dy = e.deltaY || 0;
  const delta = Math.abs(dx) > Math.abs(dy) ? dx : dy;
  if (!delta) return false;

  e.preventDefault();
  e.stopPropagation();
  gsScrollTileStripBy(delta);
  return true;
}

function gsEnsureTileStripChevrons() {
  const bar = document.getElementById("locusBar");
  if (!bar) return;
  // Migrate: chevrons used to live on #main over tile titles.
  const mainEl = (typeof main !== "undefined" && main) ? main : document.getElementById("main");
  if (mainEl) {
    mainEl.querySelectorAll(":scope > .gs-tile-strip-chevron").forEach((b) => b.remove());
  }
  const pills = gsEnsurePillStrip();
  if (!pills) return;

  const make = (side) => {
    const cls = side === "left" ? "gs-tile-strip-chevron-left" : "gs-tile-strip-chevron-right";
    let btn = bar.querySelector("." + cls);
    if (btn) return btn;
    btn = document.createElement("button");
    btn.type = "button";
    btn.className = "gs-tile-strip-chevron " + cls;
    btn.title = side === "left" ? "Scroll tiles left" : "Scroll tiles right";
    btn.setAttribute("aria-label", btn.title);
    btn.textContent = side === "left" ? "‹" : "›";
    btn.hidden = true;
    btn.addEventListener("pointerdown", (e) => { e.stopPropagation(); });
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      gsScrollTileStripPage(side === "left" ? -1 : 1);
    });
    return btn;
  };
  const left = make("left");
  const right = make("right");
  // Flank the pill strip: ‹ [pills…] › [lock] [fullscreen]
  if (left.parentElement !== bar || left.nextElementSibling !== pills) {
    bar.insertBefore(left, pills);
  }
  if (right.parentElement !== bar || pills.nextElementSibling !== right) {
    const afterPills = pills.nextSibling;
    bar.insertBefore(right, afterPills);
  }
  gsUpdateTileStripScrollChrome();
}

function gsUpdateTileStripScrollChrome() {
  const bar = document.getElementById("locusBar");
  const strip = gsTileStripEl();
  const left = bar && bar.querySelector(".gs-tile-strip-chevron-left");
  const right = bar && bar.querySelector(".gs-tile-strip-chevron-right");
  const multi = typeof gsIsMultiTile === "function" && gsIsMultiTile();
  const can = multi && strip && strip.scrollWidth > strip.clientWidth + 1;
  if (left) {
    left.hidden = !can;
    left.disabled = !can || strip.scrollLeft <= 1;
  }
  if (right) {
    right.hidden = !can;
    const max = strip ? strip.scrollWidth - strip.clientWidth : 0;
    right.disabled = !can || strip.scrollLeft >= max - 1;
  }
  // Sync locus-bar pill strip so the focused pill stays in view while scrolling.
  if (multi && state.focusedTileId) {
    const pills = document.querySelector(".gs-tile-pills");
    const pill = pills && pills.querySelector(
      `.gs-tile-pill[data-tile-id="${CSS.escape(state.focusedTileId)}"]`
    );
    if (pill && pills && pills.scrollWidth > pills.clientWidth + 1) {
      const pr = pills.getBoundingClientRect();
      const br = pill.getBoundingClientRect();
      if (br.left < pr.left) pills.scrollLeft += br.left - pr.left - 8;
      else if (br.right > pr.right) pills.scrollLeft += br.right - pr.right + 8;
    }
  }
}

function gsBindTileStripPointerFocus() {
  const strip = gsTileStripEl();
  if (!strip || strip.__gsPointerFocusBound) return;
  strip.__gsPointerFocusBound = true;
  // Default: treat as hovered until the first leave (so initial focus ring shows).
  if (state._pointerOverTileStrip == null) state._pointerOverTileStrip = true;
  strip.addEventListener("pointerleave", (e) => {
    if (typeof gsIsMultiTile === "function" && !gsIsMultiTile()) return;
    // Only when leaving the strip entirely (not moving between tiles).
    const next = e.relatedTarget;
    if (next && strip.contains(next)) return;
    state._pointerOverTileStrip = false;
    if (typeof gsUpdateTileChrome === "function") gsUpdateTileChrome();
    if (typeof gsUpdateLocusBarMode === "function") gsUpdateLocusBarMode();
  });
  strip.addEventListener("pointerenter", () => {
    if (typeof gsIsMultiTile === "function" && !gsIsMultiTile()) return;
    state._pointerOverTileStrip = true;
    if (typeof gsUpdateTileChrome === "function") gsUpdateTileChrome();
    if (typeof gsUpdateLocusBarMode === "function") gsUpdateLocusBarMode();
  });
}

function gsBindTileStripScrollInteractions() {
  const strip = gsTileStripEl();
  if (strip && !strip.__gsStripScrollChrome) {
    strip.__gsStripScrollChrome = true;
    strip.addEventListener("scroll", () => {
      gsUpdateTileStripScrollChrome();
      if (typeof gsDrawTileArcs === "function") gsDrawTileArcs();
    }, { passive: true });
  }
  // Pills live outside #main — give them their own wheel → strip scroll path.
  const bar = document.getElementById("locusBar");
  if (bar && !bar.__gsPillWheel) {
    bar.__gsPillWheel = true;
    bar.addEventListener("wheel", (e) => {
      if (typeof gsMaybeScrollTileStripFromWheel === "function"
          && gsMaybeScrollTileStripFromWheel(e)) {
        return;
      }
      // Strip can't scroll (or not multi-tile): scroll the pills row itself when
      // it overflows.
      const pills = bar.querySelector(".gs-tile-pills");
      if (!pills || !e.target.closest || !e.target.closest(".gs-tile-pills")) return;
      if (pills.scrollWidth <= pills.clientWidth + 1) return;
      const dx = e.deltaX || 0;
      const dy = e.deltaY || 0;
      e.preventDefault();
      pills.scrollLeft += (Math.abs(dx) > Math.abs(dy) ? dx : dy);
    }, { passive: false });
  }
  gsEnsureTileStripChevrons();
  // Keep chevron visibility current on resize.
  if (typeof ResizeObserver !== "undefined" && strip && !strip.__gsStripRo) {
    strip.__gsStripRo = true;
    new ResizeObserver(() => gsUpdateTileStripScrollChrome()).observe(strip);
  }
}

function gsBindDivider(div, leftTileId) {
  if (div.__gsBound) return;
  div.__gsBound = true;
  div.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    gsEnsureTilesInitialized();
    const idx = state.tiles.findIndex((t) => t.id === leftTileId);
    if (idx < 0 || idx >= state.tiles.length - 1) return;
    const left = state.tiles[idx];
    const right = state.tiles[idx + 1];
    const leftEl = gsTileRootEl(left.id);
    const rightEl = gsTileRootEl(right.id);
    if (!leftEl || !rightEl) return;

    const startX = e.clientX;
    const leftW0 = leftEl.getBoundingClientRect().width;
    const rightW0 = rightEl.getBoundingClientRect().width;
    // Resize at constant pxPerBp: width change → span change.
    const leftPxPerBp = (left.pxPerBp > 0) ? left.pxPerBp : (state.pxPerBp || 1);
    const rightPxPerBp = (right.pxPerBp > 0) ? right.pxPerBp : (state.pxPerBp || 1);
    left.widthPx = leftW0;
    right.widthPx = rightW0;

    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      let newLeft = Math.max(GS_TILE_MIN_WIDTH_PX, leftW0 + dx);
      let newRight = Math.max(GS_TILE_MIN_WIDTH_PX, rightW0 - dx);
      // Preserve total width.
      const total = leftW0 + rightW0;
      if (newLeft + newRight !== total) {
        newRight = Math.max(GS_TILE_MIN_WIDTH_PX, total - newLeft);
        newLeft = total - newRight;
      }
      left.widthPx = newLeft;
      right.widthPx = newRight;
      // Grow/shrink endBp at constant resolution (left edge fixed).
      left.endBp = left.startBp + newLeft / leftPxPerBp;
      right.endBp = right.startBp + newRight / rightPxPerBp;
      left.pxPerBp = leftPxPerBp;
      right.pxPerBp = rightPxPerBp;
      leftEl.style.flex = `0 0 ${newLeft}px`;
      leftEl.style.width = `${newLeft}px`;
      rightEl.style.flex = `0 0 ${newRight}px`;
      rightEl.style.width = `${newRight}px`;
      if (state.focusedTileId === left.id || state.focusedTileId === right.id) {
        if (typeof gsSyncFocusedAliases === "function") gsSyncFocusedAliases();
      }
      if (typeof gsUpdateTileChrome === "function") gsUpdateTileChrome();
      if (typeof gsUpdateLocusBarMode === "function") gsUpdateLocusBarMode();
      if (typeof gsDrawTileArcs === "function") gsDrawTileArcs();
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (typeof renderAll === "function") renderAll();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
}

/** Resize handle after the last tile — only that tile's width/span changes. */
function gsBindEndResize(div, tileId) {
  if (div.__gsBound) return;
  div.__gsBound = true;
  div.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    gsEnsureTilesInitialized();
    const tile = (state.tiles || []).find((t) => t.id === tileId);
    const el = gsTileRootEl(tileId);
    if (!tile || !el) return;

    const startX = e.clientX;
    const w0 = el.getBoundingClientRect().width;
    const pxPerBp = (tile.pxPerBp > 0) ? tile.pxPerBp : (state.pxPerBp || 1);
    tile.widthPx = w0;

    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      const newW = Math.max(GS_TILE_MIN_WIDTH_PX, w0 + dx);
      tile.widthPx = newW;
      tile.pxPerBp = pxPerBp;
      // Keep the left genomic edge fixed; grow/shrink the span with width.
      tile.endBp = tile.startBp + newW / pxPerBp;
      el.style.flex = `0 0 ${newW}px`;
      el.style.width = `${newW}px`;
      if (state.focusedTileId === tile.id) {
        if (typeof gsSyncFocusedAliases === "function") gsSyncFocusedAliases();
      }
      if (typeof gsUpdateTileChrome === "function") gsUpdateTileChrome();
      if (typeof gsUpdateLocusBarMode === "function") gsUpdateLocusBarMode();
      if (typeof gsDrawTileArcs === "function") gsDrawTileArcs();
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (typeof renderAll === "function") renderAll();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
}

function gsUpdateOrientationGate() {
  const multi = typeof gsIsMultiTile === "function" && gsIsMultiTile();
  const item = (typeof orientationItem !== "undefined") ? orientationItem : document.getElementById("orientationItem");
  if (item) {
    item.style.opacity = multi ? "0.4" : "";
    item.style.pointerEvents = multi ? "none" : "";
    item.title = multi ? "Vertical mode disabled with multiple tiles" : "";
  }
  if (multi && typeof isVerticalMode === "function" && isVerticalMode() && typeof setOrientation === "function") {
    setOrientation("horizontal");
  }
}

// ---- Locus bar pills (multi-tile mode) ----

function gsEnsurePillStrip() {
  const bar = document.getElementById("locusBar");
  if (!bar) return null;
  let pills = bar.querySelector(".gs-tile-pills");
  if (!pills) {
    pills = document.createElement("div");
    pills.className = "gs-tile-pills";
    pills.setAttribute("role", "tablist");
    // Insert before the connect / lock buttons.
    const lock = document.getElementById("locusConnectBtn") || document.getElementById("locusLockBtn");
    if (lock) bar.insertBefore(pills, lock);
    else bar.appendChild(pills);
  }
  return pills;
}

function gsUpdateLocusBarMode() {
  gsEnsureTilesInitialized();
  const bar = document.getElementById("locusBar");
  if (!bar) return;
  const multi = state.tiles.length > 1;
  bar.classList.toggle("gs-multi-tile", multi);
  const pills = gsEnsurePillStrip();
  if (!pills) return;
  if (!multi) {
    pills.innerHTML = "";
    if (typeof gsUpdateTileStripScrollChrome === "function") gsUpdateTileStripScrollChrome();
    return;
  }
  pills.innerHTML = "";
  const showFocus = state._pointerOverTileStrip !== false;
  state.tiles.forEach((tile, index) => {
    const pill = document.createElement("div");
    const focused = showFocus && tile.id === state.focusedTileId;
    pill.className = "gs-tile-pill"
      + (focused ? " is-focused" : "")
      + (tile.reversed ? " is-reversed" : " is-forward");
    pill.setAttribute("role", "tab");
    pill.setAttribute("tabindex", "0");
    pill.setAttribute("aria-selected", focused ? "true" : "false");
    pill.setAttribute("data-tile-id", tile.id);
    pill.setAttribute("draggable", "true");
    const locus = tile.blank ? "(empty)" : (typeof gsTileLocusString === "function" ? gsTileLocusString(tile) : "");
    const tickColor = tile.linkColor || "transparent";
    const display = (typeof gsTileDisplayName === "function")
      ? gsTileDisplayName(tile)
      : (tile.name || tile.letter);
    pill.innerHTML = `
      <span class="gs-tile-pill-handle" title="Drag to reorder">⋮⋮</span>
      <span class="gs-tile-pill-tick" style="background:${tickColor}"></span>
      <span class="gs-tile-pill-label" title="${locus.replace(/"/g, "&quot;")}">${display} · ${locus}</span>
      <span class="gs-tile-pill-orient ${tile.reversed ? "is-reversed" : "is-forward"}" title="${tile.reversed ? "3′ → 5′" : "5′ → 3′"}" aria-hidden="true">${tile.reversed ? "←" : "→"}</span>
      <button type="button" class="gs-tile-pill-close" data-tile-pill-close
              title="Close tile" aria-label="Close tile">×</button>`;
    const focusPill = () => {
      state._pointerOverTileStrip = true;
      if (typeof gsFocusTile === "function") gsFocusTile(tile.id);
    };
    pill.addEventListener("click", (e) => {
      if (e.target.closest("[data-tile-pill-close]")) return;
      focusPill();
    });
    pill.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        focusPill();
      }
    });
    const closeBtn = pill.querySelector("[data-tile-pill-close]");
    if (closeBtn) {
      closeBtn.addEventListener("pointerdown", (e) => { e.stopPropagation(); });
      closeBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (typeof gsRemoveTile === "function") gsRemoveTile(tile.id);
      });
    }
    pill.addEventListener("dragstart", (e) => {
      if (e.target.closest && e.target.closest("[data-tile-pill-close]")) {
        e.preventDefault();
        return;
      }
      e.dataTransfer.setData("text/tile-index", String(index));
      e.dataTransfer.effectAllowed = "move";
    });
    pill.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; });
    pill.addEventListener("drop", (e) => {
      e.preventDefault();
      const from = parseInt(e.dataTransfer.getData("text/tile-index"), 10);
      if (!Number.isFinite(from)) return;
      if (typeof gsReorderTiles === "function") gsReorderTiles(from, index);
    });
    pills.appendChild(pill);
  });
  if (typeof gsUpdateTileStripScrollChrome === "function") gsUpdateTileStripScrollChrome();
}

// ---- Add-tile button ----

function gsInitAddTileButton() {
  const rootEl = (typeof getCurrentRoot === "function") ? getCurrentRoot() : document;
  const btn = (rootEl.querySelector && rootEl.querySelector("#addTileBtn"))
    || document.getElementById("addTileBtn");
  if (!btn || btn.__gsBound) return;
  btn.__gsBound = true;
  btn.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
  });
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const focused = (typeof gsFocusedTile === "function") ? gsFocusedTile() : null;
    const copyLocus = !!(focused && !focused.blank && focused.contig);
    const tile = typeof gsAddTile === "function"
      ? gsAddTile({
          insertAfterId: state.focusedTileId,
          contig: copyLocus ? focused.contig : undefined,
          startBp: copyLocus ? focused.startBp : undefined,
          endBp: copyLocus ? focused.endBp : undefined,
          reversed: focused ? !!focused.reversed : false,
          blank: !copyLocus,
        })
      : null;
    // Only prompt for a locus when we couldn't clone one.
    if (tile && tile.blank) {
      requestAnimationFrame(() => gsBeginTileLocusEdit(tile.id));
    }
  });
}

// ---- SA parsing + arcs + context menu (Phase 7) ----

function gsParseSaTag(saTag) {
  if (!saTag || typeof saTag !== "string") return [];
  const out = [];
  for (const part of saTag.split(";")) {
    const s = part.trim();
    if (!s) continue;
    const bits = s.split(",");
    if (bits.length < 4) continue;
    const contig = bits[0];
    const pos = parseInt(bits[1], 10);
    const strand = bits[2] || "+";
    const cigar = bits[3] || "";
    const mapq = bits.length > 4 ? parseInt(bits[4], 10) : 0;
    if (!contig || !Number.isFinite(pos)) continue;
    out.push({ contig, pos, strand, cigar, mapq });
  }
  return out;
}

function gsTileContainsLocus(tile, contig, pos) {
  if (!tile || tile.blank) return false;
  if (tile.contig !== contig) return false;
  return pos >= tile.startBp && pos <= tile.endBp;
}

function gsFindOpenTileForMate(contig, pos, excludeId) {
  gsEnsureTilesInitialized();
  return state.tiles.find((t) => t.id !== excludeId && gsTileContainsLocus(t, contig, pos)) || null;
}

function gsOpenLinkedTile(opts) {
  // opts: { contig, pos, strand, sourceTileId, sourceStrand }
  const source = (state.tiles || []).find((t) => t.id === opts.sourceTileId) || gsFocusedTile();
  const existing = gsFindOpenTileForMate(opts.contig, opts.pos, source && source.id);
  if (existing) {
    if (typeof gsFocusTile === "function") gsFocusTile(existing.id);
    return existing;
  }
  // Widen gutters so aggregate SA/PE ribbons have room to draw.
  state.preferRibbonGutters = true;
  // Clear fixed widths before add so both columns flex evenly.
  if (source) source.widthPx = null;
  // Never auto-apply display orientation — linked tiles open unconfirmed
  // (same direction as source) with a suggestion banner from bundle evidence.
  const tile = gsAddTile({
    contig: opts.contig,
    centerBp: opts.pos,
    reversed: !!(source && source.reversed),
    linkedFromId: source ? source.id : null,
    insertAfterId: source ? source.id : null,
    orientationConfirmed: false,
    suggestedReversed: null,
    // Let both columns flex — never inherit a stale fixed widthPx.
    widthPx: null,
  });
  gsApplyTileGutterWidths();
  // Redraw arcs after layout settles on the wider gutter.
  requestAnimationFrame(() => {
    if (typeof gsDrawTileArcs === "function") gsDrawTileArcs();
  });
  return tile;
}

function gsHideContextMenu() {
  const m = document.getElementById("gsContextMenu");
  if (m) m.remove();
}

/** Host for floating UI: fullscreen overlay when active, else document.body. */
function gsFloatingUiHost() {
  // Overlay is z-index:2147483647 on body — menus appended to body sit UNDER it.
  const overlay = document.querySelector('[id^="genomeshader-overlay-"]');
  if (overlay && overlay.isConnected) return overlay;
  return document.body;
}

function gsShowContextMenu(x, y, items) {
  gsHideContextMenu();
  const menu = document.createElement("div");
  menu.id = "gsContextMenu";
  menu.className = "gs-context-menu";
  menu.style.left = `${Math.max(4, x)}px`;
  menu.style.top = `${Math.max(4, y)}px`;
  menu.style.zIndex = "2147483647";
  items.forEach((it) => {
    if (it === "---") {
      const sep = document.createElement("div");
      sep.className = "gs-ctx-sep";
      menu.appendChild(sep);
      return;
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = it.label;
    if (typeof it.action !== "function") {
      btn.disabled = true;
      btn.classList.add("is-disabled");
    } else {
      btn.addEventListener("click", () => {
        gsHideContextMenu();
        it.action();
      });
    }
    menu.appendChild(btn);
  });
  // Mount inside the fullscreen overlay when present so we aren't covered by it.
  // Overlay is position:fixed without transform, so fixed+viewport coords still work.
  gsFloatingUiHost().appendChild(menu);
  const dismiss = (e) => {
    if (!menu.contains(e.target)) {
      gsHideContextMenu();
      document.removeEventListener("pointerdown", dismiss, true);
    }
  };
  setTimeout(() => document.addEventListener("pointerdown", dismiss, true), 0);
}

function gsDrawTileArcs() {
  // Overridden by tile-arcs.js when that script loads (aggregate ribbons).
}


function gsSoftClipMode(track) {
  const m = track && track.readDisplay && track.readDisplay.softClipMode;
  return (m === "bases" || m === "hide") ? m : "marker";
}

/** Collect distal loci for a read: SA segments, PE mate, same-qname alts in other tiles. */
function gsLinkedLociForRead(read, sourceTileId) {
  const out = [];
  const seen = new Set();
  const push = (kind, contig, pos, strand, sourceStrand) => {
    if (!contig || !Number.isFinite(Number(pos)) || Number(pos) <= 0) return;
    const key = `${kind}|${contig}:${pos}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      kind,
      contig,
      pos: Number(pos),
      strand: strand || "+",
      sourceStrand: sourceStrand || (read.isForward === false ? "-" : "+"),
    });
  };

  const sourceStrand = read.isForward === false ? "-" : "+";
  for (const m of gsParseSaTag(read.saTag || "")) {
    push(read.isSupplementary ? "SA (primary)" : "SA", m.contig, m.pos, m.strand, sourceStrand);
  }
  if (read.isPaired && read.mateContig && read.matePos) {
    // Skip mate if it clearly lands inside this same alignment span on the same contig.
    const sameLocal = read.contig === read.mateContig
      && read.matePos >= read.start - 50
      && read.matePos <= read.end + 50;
    if (!sameLocal) {
      push("PE mate", read.mateContig, read.matePos, "+", sourceStrand);
    }
  }
  // Same query name already open in another tile (secondary / other segment).
  if (Array.isArray(state.smartTracks) && read.name) {
    for (const track of state.smartTracks) {
      if (!track) continue;
      for (const otherTile of (state.tiles || [])) {
        if (!otherTile || otherTile.blank) continue;
        const lay = (typeof smartTrackReadsLayoutForTile === "function")
          ? smartTrackReadsLayoutForTile(track, otherTile) : null;
        const reads = lay && lay.reads;
        if (!Array.isArray(reads)) continue;
        for (const other of reads) {
          if (!other || other === read || other.name !== read.name) continue;
          if (other.contig === read.contig
              && other.start <= read.end && other.end >= read.start) continue;
          const kind = other.isSecondary ? "Secondary"
            : (other.isSupplementary ? "Supplementary" : "Mate alignment");
          push(kind, other.contig || otherTile.contig, other.start, other.isForward === false ? "-" : "+", sourceStrand);
        }
      }
    }
  }
  return out;
}

/**
 * Hit-test a smart-track read under the pointer.
 * Uses each track's renderer container bounds (positioned inside #smartScroll).
 * Returns { track, read, tileId } or null.
 */
function gsHitTestSmartRead(clientX, clientY, tile) {
  const renderers = (tile && tile._smartRenderers instanceof Map)
    ? tile._smartRenderers
    : state.smartTrackRenderers;
  if (!renderers || typeof renderers.forEach !== "function") {
    return null;
  }
  const genomeW = (typeof renderWidthPx === "function" && renderWidthPx() > 0)
    ? renderWidthPx()
    : ((typeof tracksWidthPx === "function" && tracksWidthPx() > 0) ? tracksWidthPx() : 0);

  let hit = null;
  let hitArea = Infinity;
  renderers.forEach((renderer, trackId) => {
    if (!renderer || !renderer.container) return;
    const box = renderer.container.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return;
    if (clientX < box.left || clientX > box.right || clientY < box.top || clientY > box.bottom) {
      return;
    }
    const track = (state.smartTracks || []).find((t) => t.id === trackId)
      || (state.tracks || []).find((t) => t.id === trackId);
    if (!track) return;
    // The reads THIS tile shows for the track (not the focused tile's payload).
    const tileLayout = (tile && typeof smartTrackReadsLayoutForTile === "function")
      ? smartTrackReadsLayoutForTile(track, tile)
      : track.readsLayout;
    if (!tileLayout || !Array.isArray(tileLayout.reads)) return;

    const scrollTop = renderer.container.scrollTop || 0;
    const localY = clientY - box.top + scrollTop;
    const w = genomeW > 0 ? genomeW : box.width;
    const bp = (typeof bpFromXGenome === "function")
      ? bpFromXGenome(clientX - box.left, w, tile)
      : null;
    if (!Number.isFinite(bp)) return;

    // Geometry matches renderSmartTrack (horizontal).
    const labelH = 24;
    const closedSlot = track.closedHeight || 30;
    const summaryH = Math.max(12, labelH - 2);
    const summaryY = Math.max(0, Math.floor((closedSlot - summaryH) / 2));
    const top = summaryY;
    const showSummary = !track.readDisplay || track.readDisplay.visibility.summary !== false;
    const overviewH = track.collapsed ? 0
      : (showSummary ? (summaryY + summaryH + 4 - top) : 0);
    const readsTop = top + overviewH;
    const rowH = (typeof SMART_TRACK_ROW_H === "number") ? SMART_TRACK_ROW_H : 18;

    const pickNearest = (candidates, maxDist) => {
      let best = null;
      let bestDist = Infinity;
      for (const read of candidates) {
        const dist = (bp >= read.start && bp <= read.end)
          ? 0
          : Math.min(Math.abs(bp - read.start), Math.abs(bp - read.end));
        if (dist < bestDist) {
          bestDist = dist;
          best = read;
        }
      }
      return (best && bestDist <= maxDist) ? best : null;
    };

    let read = null;
    if (track.collapsed || localY < readsTop) {
      const linked = tileLayout.reads.filter((r) =>
        r.saTag || (r.mateContig && r.matePos) || Number(r.clipLength) > 0
        || (bp >= r.start - 50 && bp <= r.end + 50));
      read = pickNearest(linked.length ? linked : tileLayout.reads, 400);
    } else {
      const onRow = tileLayout.reads.filter((r) => {
        const y0 = readsTop + (Number(r.row) || 0) * rowH + Number(r.groupOffsetPx || 0);
        return localY >= y0 && localY < y0 + rowH;
      });
      read = pickNearest(onRow, 80)
        || pickNearest(onRow, 300)
        || pickNearest(tileLayout.reads.filter((r) =>
          bp >= r.start - 100 && bp <= r.end + 100), 200);
    }
    if (!read) return;
    const area = box.width * box.height;
    // Prefer the smallest containing container (avoids a stale 100%-height overlay).
    if (area < hitArea) {
      hitArea = area;
      hit = { track, read, tileId: tile && tile.id };
    }
  });
  return hit;
}

/** True when the pointer is over the sample-track stack (even through pointer-events:none canvases). */
function gsPointerOverSmartTracks(clientX, clientY) {
  const overRect = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0
      && clientX >= r.left && clientX <= r.right
      && clientY >= r.top && clientY <= r.bottom;
  };
  const rootEl = (typeof getCurrentRoot === "function" && getCurrentRoot()) || document;
  for (const w of rootEl.querySelectorAll(".gs-smart-scroll")) {
    if (overRect(w)) return true;
  }
  let over = false;
  const scan = (renderers) => {
    if (!renderers || typeof renderers.forEach !== "function") return;
    renderers.forEach((renderer) => {
      if (over || !renderer || !renderer.container) return;
      const box = renderer.container.getBoundingClientRect();
      if (box.width < 1 || box.height < 1) return;
      if (clientX >= box.left && clientX <= box.right
          && clientY >= box.top && clientY <= box.bottom) {
        over = true;
      }
    });
  };
  for (const t of (state.tiles || [])) scan(t && t._smartRenderers);
  if (!over) scan(state.smartTrackRenderers);
  return over;
}

function gsEventInGenomeshader(e) {
  const t = e.target;
  if (!t) return false;
  if (t.closest && t.closest(
    ".gs-tile, #main, .gs-smart-scroll, .smart-track-container, .app, "
    + "[id^='genomeshader-root-'], [id^='genomeshader-modal-']"
  )) {
    return true;
  }
  // Canvases use pointer-events:none — fall back to geometry.
  if (gsPointerOverSmartTracks(e.clientX, e.clientY)) return true;
  const main = (typeof getElementById === "function" ? getElementById("main") : null)
    || document.getElementById("main");
  return !!(main && main.contains(t));
}

function gsOnTileContextMenu(e) {
  if (!gsEventInGenomeshader(e)) return;

  const tileEl = (e.target.closest && e.target.closest(".gs-tile"))
    || document.querySelector(".gs-tile.is-focused")
    || document.querySelector(".gs-tile");
  const tileId = tileEl ? tileEl.getAttribute("data-tile-id") : (state.focusedTileId || "t0");
  const tile = (state.tiles || []).find((t) => t.id === tileId)
    || (typeof gsFocusedTile === "function" ? gsFocusedTile() : null);

  // Variant BND hit-test.
  const nodes = window._alleleNodePositions || [];
  if (nodes.length && tileEl) {
    const flowEl = tileEl.querySelector(".flow") || document.getElementById("flow");
    if (flowEl) {
      const fr = flowEl.getBoundingClientRect();
      const lx = e.clientX - fr.left;
      const ly = e.clientY - fr.top;
      const alleleHit = nodes.find((n) =>
        n.mateContig && Number.isFinite(Number(n.matePos))
        && lx >= n.x && lx <= n.x + n.w && ly >= n.y && ly <= n.y + n.h);
      if (alleleHit) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        gsShowContextMenu(e.clientX, e.clientY, [{
          label: `Open linked tile at ${alleleHit.mateContig}:${Number(alleleHit.matePos).toLocaleString()} (BND)`,
          action: () => gsOpenLinkedTile({
            contig: alleleHit.mateContig,
            pos: Number(alleleHit.matePos),
            strand: alleleHit.mateStrand || "+",
            sourceTileId: tileId,
          }),
        }]);
        return;
      }
    }
  }

  const overReads = gsPointerOverSmartTracks(e.clientX, e.clientY);
  const hitRead = gsHitTestSmartRead(e.clientX, e.clientY, tile);
  if (!hitRead && !overReads) return;

  // Own the menu whenever the pointer is over sample reads — beat Jupyter/browser.
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();

  const items = [];
  if (!hitRead) {
    items.push({ label: "No read under cursor", action: null });
  } else {
    const links = gsLinkedLociForRead(hitRead.read, tileId);
    if (!links.length) {
      items.push({ label: "No linked locus on this read", action: null });
    } else {
      for (const m of links) {
        items.push({
          label: `Open ${m.kind} → ${m.contig}:${Number(m.pos).toLocaleString()}`,
          action: () => gsOpenLinkedTile({
            contig: m.contig,
            pos: m.pos,
            strand: m.strand,
            sourceStrand: m.sourceStrand,
            sourceTileId: tileId,
          }),
        });
      }
    }
  }
  gsShowContextMenu(e.clientX, e.clientY, items);
}

function gsInitTileContextMenus() {
  // window capture runs BEFORE document — JupyterLab binds contextmenu on document
  // with capture, so a document-only listener loses the registration race.
  const prev = window.__gsOnTileContextMenu;
  if (prev) {
    try { window.removeEventListener("contextmenu", prev, true); } catch (err) {}
    try { document.removeEventListener("contextmenu", prev, true); } catch (err) {}
  }
  window.__gsOnTileContextMenu = gsOnTileContextMenu;
  window.addEventListener("contextmenu", gsOnTileContextMenu, true);
  document.addEventListener("contextmenu", gsOnTileContextMenu, true);

  const bind = (el) => {
    if (!el || el === document || el === window) return;
    if (el.__gsTileCtxHandler && el.__gsTileCtxHandler !== gsOnTileContextMenu) {
      try { el.removeEventListener("contextmenu", el.__gsTileCtxHandler, true); } catch (err) {}
    }
    el.__gsTileCtxHandler = gsOnTileContextMenu;
    el.addEventListener("contextmenu", gsOnTileContextMenu, true);
  };

  const root = (typeof getCurrentRoot === "function" && getCurrentRoot()) || null;
  bind(root);
  const mainEl = (typeof getElementById === "function" ? getElementById("main") : null)
    || document.getElementById("main");
  bind(mainEl);
  // Fullscreen overlay covers the viewport at max z-index — bind there too.
  const overlay = document.querySelector('[id^="genomeshader-overlay-"]');
  bind(overlay);
}

function gsInitTileUi() {
  gsEnsureTilesInitialized();
  // Bind header events on the primary tile baked into body.html.
  const primary = document.querySelector('.gs-tile[data-tile-id="t0"]')
    || document.querySelector(".gs-tile");
  if (primary) {
    const id = primary.getAttribute("data-tile-id") || "t0";
    // Ensure state tile id matches the DOM primary id.
    if (state.tiles && state.tiles[0] && state.tiles[0].id !== id) {
      // Keep state id; retarget DOM.
      primary.setAttribute("data-tile-id", state.tiles[0].id);
      primary.id = `tile-${state.tiles[0].id}`;
    }
    gsBindTileHeaderEvents(primary, state.tiles[0].id);
  }
  gsEnsureTileStripDom();
  gsInitAddTileButton();
  gsUpdateLocusBarMode();
  gsUpdateTileChrome();
  gsInitTileContextMenus();
  gsBindTileStripScrollInteractions();
  gsBindTileStripPointerFocus();

  const strip = gsTileStripEl();
  if (strip && !strip.__gsArcScroll) {
    // scroll chrome + arcs are bound in gsBindTileStripScrollInteractions.
    strip.__gsArcScroll = true;
  }
}

// Hook into ready.
if (typeof window !== "undefined") {
  window.gsEnsureTileStripDom = gsEnsureTileStripDom;
  window.gsApplyTileGutterWidths = gsApplyTileGutterWidths;
  window.gsUpdateTileChrome = gsUpdateTileChrome;
  window.gsUpdateLocusBarMode = gsUpdateLocusBarMode;
  window.gsScrollTileIntoView = gsScrollTileIntoView;
  window.gsScrollTileStripBy = gsScrollTileStripBy;
  window.gsScrollTileStripPage = gsScrollTileStripPage;
  window.gsTileStripCanScroll = gsTileStripCanScroll;
  window.gsTileStripEl = gsTileStripEl;
  window.gsMaybeScrollTileStripFromWheel = gsMaybeScrollTileStripFromWheel;
  window.gsUpdateTileStripScrollChrome = gsUpdateTileStripScrollChrome;
  window.gsBindTileStripScrollInteractions = gsBindTileStripScrollInteractions;
  window.gsDrawTileArcs = gsDrawTileArcs;
  window.gsParseSaTag = gsParseSaTag;
  window.gsOpenLinkedTile = gsOpenLinkedTile;
  window.gsFindOpenTileForMate = gsFindOpenTileForMate;
  window.gsHitTestSmartRead = gsHitTestSmartRead;
  window.gsLinkedLociForRead = gsLinkedLociForRead;
  window.gsInitTileUi = gsInitTileUi;
  window.gsBindTileDom = gsBindTileDom;
}
