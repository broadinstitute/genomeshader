// Canvas helpers
// -----------------------------
function resizeCanvasTo(el, canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.floor(rectW(el) * dpr);
  const h = Math.floor(rectH(el) * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return dpr;
}

function visibleVariantWindow() {
  // Return all variants in the visible genomic range, not limited by state.K
  const visibleVariants = variants.filter(v => v.pos >= state.startBp && v.pos <= state.endBp);
  return visibleVariants;
}

function visibleVariantWindowFor(variantsList) {
  if (!variantsList || !Array.isArray(variantsList)) return [];
  return variantsList.filter(v => v.pos >= state.startBp && v.pos <= state.endBp);
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w/2, h/2);
  ctx.moveTo(x+rr, y);
  ctx.arcTo(x+w, y,   x+w, y+h, rr);
  ctx.arcTo(x+w, y+h, x,   y+h, rr);
  ctx.arcTo(x,   y+h, x,   y,   rr);
  ctx.arcTo(x,   y,   x+w, y,   rr);
  ctx.closePath();
}

// -----------------------------
// Sankey placeholder (Canvas2D)
// -----------------------------
function renderFlowCanvas() {
  const variantOrderKeyFor = (trackId, variantId) => (
    window.makeVariantOrderKey
      ? window.makeVariantOrderKey(trackId, variantId)
      : String(variantId)
  );
  const selectionKeyFor = (trackId, variantId, alleleIndex) => (
    window.makeAlleleSelectionKey
      ? window.makeAlleleSelectionKey(trackId, variantId, alleleIndex)
      : `${variantId}:${alleleIndex}`
  );
  const findBandFlowTrackEl = (trackId) => {
    const flowEl = document.getElementById("flow");
    if (!flowEl) return null;
    const target = String(trackId || "");
    const tracks = flowEl.querySelectorAll(".flow-track");
    for (const el of tracks) {
      if ((el.dataset.trackId || "") === target) return el;
    }
    return null;
  };

  const layout = getTrackLayout();
  const variantTracksConfig = (window.GENOMESHADER_CONFIG && window.GENOMESHADER_CONFIG.variant_tracks) || [];
  const flowLayouts = layout.filter(l => l.track.id === "flow" || (l.track.id && l.track.id.startsWith("flow-")));
  const visibleFlowLayouts = flowLayouts.filter(l => !l.track.collapsed);
  if (visibleFlowLayouts.length === 0) {
    window._alleleNodePositions = [];
    const fc = document.getElementById("flowCanvas") || document.getElementById("flowCanvas-0");
    if (fc) {
      const ctx = fc.getContext("2d");
      if (ctx) ctx.clearRect(0, 0, fc.width, fc.height);
    }
    if (flowInstancedRenderer) flowInstancedRenderer.clear();
    return;
  }

  const multiTrack = variantTracksConfig.length > 1;
  const isVertical = isVerticalMode();
  const variantMode = getVariantLayoutMode();
  const junctionY = 40;
  const junctionX = 40;
  const W = flowWidthPx();
  const totalFlowH = flowHeightPx();

  // Build list of bands: one per variant track (or single band when using legacy single "flow")
  const flowBands = [];
  if (variantTracksConfig.length > 0) {
    let bandOffset = 0;
    for (let i = 0; i < variantTracksConfig.length; i++) {
      const trackConfig = variantTracksConfig[i];
      const trackLayout = layout.find(l => l.track.id === trackConfig.id);
      if (!trackLayout || trackLayout.track.collapsed) continue;
      const bandHeight = isVertical ? trackLayout.contentWidth : trackLayout.contentHeight;
      flowBands.push({
        track: trackConfig,
        flowLayout: trackLayout,
        bandOffset,
        bandHeight,
      });
      bandOffset += bandHeight;
    }
  } else {
    const flowLayout = layout.find(l => l.track.id === "flow");
    if (flowLayout && !flowLayout.track.collapsed) {
      const bandHeight = isVertical ? flowLayout.contentWidth : flowLayout.contentHeight;
      flowBands.push({
        track: { variants_data: variants, variants_phased: (window.GENOMESHADER_CONFIG && window.GENOMESHADER_CONFIG.variants_phased) !== false },
        flowLayout,
        bandOffset: 0,
        bandHeight,
      });
    }
  }

  if (!multiTrack && flowBands.length > 0) {
    const dpr = resizeCanvasTo(flow, flowCanvas);
    const ctx = flowCanvas.getContext("2d");
    ctx.setTransform(1,0,0,1,0,0);
    ctx.clearRect(0,0,flowCanvas.width,flowCanvas.height);
    ctx.scale(dpr, dpr);
  }
  if (flowInstancedRenderer) flowInstancedRenderer.clear();
  if (flowRibbonRenderer) flowRibbonRenderer.clear();
  const allBandNodePositions = [];

  for (let bandIdx = 0; bandIdx < flowBands.length; bandIdx++) {
    const band = flowBands[bandIdx];
    const { track, flowLayout, bandOffset, bandHeight } = band;
    const variants = track.variants_data || [];
    const win = visibleVariantWindowFor(variants);
    const variantsPhased = track.variants_phased !== false;
    const H = bandHeight;

    let ctx;
    if (multiTrack) {
      const flowEl = document.getElementById("flow");
      let bandFlowEl = findBandFlowTrackEl(track.id);
      if (!bandFlowEl) {
        const candidate = document.getElementById(track.id);
        if (candidate && candidate.classList && candidate.classList.contains("flow-track")) {
          bandFlowEl = candidate;
        }
      }
      let bandCanvas = bandFlowEl ? bandFlowEl.querySelector("canvas.canvas") : null;
      // Fallback by track order if id/data-track-id lookup fails.
      if ((!bandFlowEl || !bandCanvas) && flowEl) {
        const trackEls = Array.from(flowEl.querySelectorAll(".flow-track"));
        const orderTrack = trackEls[bandIdx] || trackEls[0] || null;
        if (orderTrack) {
          bandFlowEl = orderTrack;
          bandCanvas = orderTrack.querySelector("canvas.canvas") || orderTrack.querySelector("canvas");
        }
      }
      // Final fallback to shared flow canvas to avoid dropping all hit-test nodes.
      if (!bandFlowEl && flowEl) {
        bandFlowEl = flowEl;
      }
      if (!bandCanvas) {
        bandCanvas = document.getElementById("flowCanvas");
      }
      if (!bandFlowEl || !bandCanvas) continue;
      const dpr = resizeCanvasTo(bandFlowEl, bandCanvas);
      ctx = bandCanvas.getContext("2d");
      ctx.setTransform(1,0,0,1,0,0);
      ctx.clearRect(0, 0, bandCanvas.width, bandCanvas.height);
      ctx.scale(dpr, dpr);
    } else {
      ctx = flowCanvas.getContext("2d");
      ctx.save();
      ctx.translate(0, bandOffset);
      ctx.beginPath();
      ctx.rect(0, 0, W, bandHeight);
      ctx.clip();
    }

    // yBandToFlow / xBandToFlow: add bandOffset for WebGPU (multi-track); for 2D multi-track we draw in local 0..H
    const yBandToFlow = (y) => y + bandOffset;
    const xBandToFlow = (x) => x + (isVertical ? bandOffset : 0);

    (function drawOneFlowBand() {
  const colLines = cssVar("--grid");
  const colGrid  = cssVar("--grid2");
  const colText  = cssVar("--muted");
  const colBlue  = cssVar("--blue");
  const colGray  = "rgba(127,127,127,0.5)"; // Gray for non-hovered lines

  // drawRibbon: WebGPU Bezier ribbon renderer (replaces Canvas2D tessellation)
  // Note: srcInfo/dstInfo coordinates are in Canvas2D logical pixels (scaled by dpr)
  // WebGPU uses physical pixels, so we need to scale by devicePixelRatio
  const drawRibbon = (srcInfo, dstInfo, srcY0, srcY1, dstY0, dstY1, color) => {
    if (!srcInfo || !dstInfo) return;

    // Scale coordinates from logical pixels (Canvas2D) to physical pixels (WebGPU)
    const devicePixelRatio = window.devicePixelRatio || 1;

    // Clamp to node bounds so ribbons meet nodes flush
    const srcY0C = Math.max(srcInfo.top, Math.min(srcY0, srcInfo.bottom));
    const srcY1C = Math.max(srcInfo.top, Math.min(srcY1, srcInfo.bottom));
    const dstY0C = Math.max(dstInfo.top, Math.min(dstY0, dstInfo.bottom));
    const dstY1C = Math.max(dstInfo.top, Math.min(dstY1, dstInfo.bottom));

    // Ensure consistent top/bottom ordering (prevents "candy-wrapper twist")
    let sTop = Math.min(srcY0C, srcY1C);
    let sBot = Math.max(srcY0C, srcY1C);
    let dTop = Math.min(dstY0C, dstY1C);
    let dBot = Math.max(dstY0C, dstY1C);

    // Apply slight endpoint taper (classic alluvial aesthetic)
    // Shrink endpoints toward midpoint by ~6% for intentional joins
    const taperFrac = 0.06;
    const sMid = (sTop + sBot) / 2;
    const sHalfH = (sBot - sTop) / 2;
    sTop = sMid - sHalfH * (1 - taperFrac);
    sBot = sMid + sHalfH * (1 - taperFrac);
    
    const dMid = (dTop + dBot) / 2;
    const dHalfH = (dBot - dTop) / 2;
    dTop = dMid - dHalfH * (1 - taperFrac);
    dBot = dMid + dHalfH * (1 - taperFrac);

    const srcX = srcInfo.right;
    const dstX = dstInfo.left;
    const dx = dstX - srcX;
    if (!(dx > 1.0)) return;

    // Handle length: no fixed 10px minimum; clamp by dx to avoid loops when zoomed out
    const base = dx * 0.40;
    const handle = Math.max(1.0, Math.min(base, dx * 0.45));

    // Scale all coordinates to physical pixels for WebGPU (yBandToFlow for multi-track offset)
    const topP0 = [srcX * devicePixelRatio, yBandToFlow(sTop) * devicePixelRatio];
    const topP3 = [dstX * devicePixelRatio, yBandToFlow(dTop) * devicePixelRatio];
    const botP0 = [srcX * devicePixelRatio, yBandToFlow(sBot) * devicePixelRatio];
    const botP3 = [dstX * devicePixelRatio, yBandToFlow(dBot) * devicePixelRatio];

    // Horizontal tangents at endpoints (classic Sankey look)
    const topP1 = [(srcX + handle) * devicePixelRatio, yBandToFlow(sTop) * devicePixelRatio];
    const topP2 = [(dstX - handle) * devicePixelRatio, yBandToFlow(dTop) * devicePixelRatio];
    const botP1 = [(srcX + handle) * devicePixelRatio, yBandToFlow(sBot) * devicePixelRatio];
    const botP2 = [(dstX - handle) * devicePixelRatio, yBandToFlow(dBot) * devicePixelRatio];

    // Parse color string to RGBA floats (expects "rgba(r,g,b,a)" or similar)
    const m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
    let rgba = [0.47, 0.71, 1.0, 0.20];
    if (m) {
      rgba = [parseInt(m[1])/255, parseInt(m[2])/255, parseInt(m[3])/255, m[4] !== undefined ? parseFloat(m[4]) : 1.0];
    }

    if (webgpuSupported && flowRibbonRenderer) {
      flowRibbonRenderer.addRibbon(topP0, topP1, topP2, topP3, botP0, botP1, botP2, botP3, rgba);
      return;
    }

    // Fallback (optional): if you want, keep your old Canvas2D path here.
  };

  // drawRibbonVertical: WebGPU Bezier ribbon renderer for vertical mode
  // In vertical mode with inverted Y axis (bottom=start, top=end):
  // - Source (earlier variant) is at BOTTOM (higher Y)
  // - Destination (later variant) is at TOP (lower Y)
  // - Ribbons flow UPWARD from srcInfo.top to dstInfo.bottom
  const drawRibbonVertical = (srcInfo, dstInfo, srcX0, srcX1, dstX0, dstX1, color) => {
    if (!srcInfo || !dstInfo) return;

    // Scale coordinates from logical pixels (Canvas2D) to physical pixels (WebGPU)
    const devicePixelRatio = window.devicePixelRatio || 1;

    // Clamp to node bounds so ribbons meet nodes flush (using left/right for horizontal extent)
    const srcX0C = Math.max(srcInfo.left, Math.min(srcX0, srcInfo.right));
    const srcX1C = Math.max(srcInfo.left, Math.min(srcX1, srcInfo.right));
    const dstX0C = Math.max(dstInfo.left, Math.min(dstX0, dstInfo.right));
    const dstX1C = Math.max(dstInfo.left, Math.min(dstX1, dstInfo.right));

    // Ensure consistent left/right ordering (prevents "candy-wrapper twist")
    let sLeft = Math.min(srcX0C, srcX1C);
    let sRight = Math.max(srcX0C, srcX1C);
    let dLeft = Math.min(dstX0C, dstX1C);
    let dRight = Math.max(dstX0C, dstX1C);

    // Apply slight endpoint taper (classic alluvial aesthetic)
    // Shrink endpoints toward midpoint by ~6% for intentional joins
    const taperFrac = 0.06;
    const sMid = (sLeft + sRight) / 2;
    const sHalfW = (sRight - sLeft) / 2;
    sLeft = sMid - sHalfW * (1 - taperFrac);
    sRight = sMid + sHalfW * (1 - taperFrac);
    
    const dMid = (dLeft + dRight) / 2;
    const dHalfW = (dRight - dLeft) / 2;
    dLeft = dMid - dHalfW * (1 - taperFrac);
    dRight = dMid + dHalfW * (1 - taperFrac);

    // With inverted Y axis: source is at bottom (higher Y), dest is at top (lower Y)
    // Ribbons flow UPWARD: from srcInfo.top (top edge of source node) to dstInfo.bottom (bottom edge of dest node)
    const srcY = srcInfo.top;      // Top edge of source node (which is at bottom of screen)
    const dstY = dstInfo.bottom;   // Bottom edge of dest node (which is at top of screen)
    const dy = srcY - dstY;        // srcY > dstY, so this is positive
    if (!(dy > 1.0)) return;

    // Handle length: no fixed 10px minimum; clamp by dy to avoid loops when zoomed out
    const base = dy * 0.40;
    const handle = Math.max(1.0, Math.min(base, dy * 0.45));

    // Scale all coordinates to physical pixels for WebGPU (vertical: xBandToFlow for x, yBandToFlow for y)
    const leftP0 = [xBandToFlow(sLeft) * devicePixelRatio, yBandToFlow(srcY) * devicePixelRatio];
    const leftP3 = [xBandToFlow(dLeft) * devicePixelRatio, yBandToFlow(dstY) * devicePixelRatio];
    const rightP0 = [xBandToFlow(sRight) * devicePixelRatio, yBandToFlow(srcY) * devicePixelRatio];
    const rightP3 = [xBandToFlow(dRight) * devicePixelRatio, yBandToFlow(dstY) * devicePixelRatio];

    const leftP1 = [xBandToFlow(sLeft) * devicePixelRatio, yBandToFlow(srcY - handle) * devicePixelRatio];
    const leftP2 = [xBandToFlow(dLeft) * devicePixelRatio, yBandToFlow(dstY + handle) * devicePixelRatio];
    const rightP1 = [xBandToFlow(sRight) * devicePixelRatio, yBandToFlow(srcY - handle) * devicePixelRatio];
    const rightP2 = [xBandToFlow(dRight) * devicePixelRatio, yBandToFlow(dstY + handle) * devicePixelRatio];

    // Parse color string to RGBA floats (expects "rgba(r,g,b,a)" or similar)
    const m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
    let rgba = [0.47, 0.71, 1.0, 0.20];
    if (m) {
      rgba = [parseInt(m[1])/255, parseInt(m[2])/255, parseInt(m[3])/255, m[4] !== undefined ? parseFloat(m[4]) : 1.0];
    }

    if (webgpuSupported && flowRibbonRenderer) {
      // For vertical ribbons, we pass left/right edges as top/bottom edges to the renderer
      flowRibbonRenderer.addRibbon(leftP0, leftP1, leftP2, leftP3, rightP0, rightP1, rightP2, rightP3, rgba);
      return;
    }

    // Fallback (optional): if you want, keep your old Canvas2D path here.
  };

  // Helper function to parse rgba string and convert to hex for WebGPU
  function rgbaToHex(rgbaStr) {
    const match = rgbaStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
    if (match) {
      const r = parseInt(match[1]);
      const g = parseInt(match[2]);
      const b = parseInt(match[3]);
      return (r << 16) | (g << 8) | b;
    }
    // Fallback to blue if parsing fails
    return 0x78B4FF;
  }

  // background
  ctx.fillStyle = "rgba(127,127,127,0.035)";
  ctx.fillRect(0,0,W,H);

  // connectors (diagonal lines - make them meet the ruler variant position precisely)
  // Use this band's win (from visibleVariantWindowFor(variants) above), not global visibleVariantWindow()
  
  // Use WebGPU for variant columns if available, otherwise fall back to Canvas 2D
  // Use flowWebGPU instead of tracksWebGPU for variant columns
  const useWebGPU = webgpuSupported && flowInstancedRenderer;
  const devicePixelRatio = window.devicePixelRatio || 1;
  const blueHex = rgbaToHex(colBlue);
  const grayHex = rgbaToHex(colGray);
  
  if (isVertical) {
    // In vertical mode, sort variants by position for consistent ordering
    const sortedWin = [...win].sort((a, b) => a.pos - b.pos);
    
    // columns (horizontal lines in vertical mode) - shortened to end near where allele nodes start
    // Calculate where allele nodes start (left + margin + horizontal offset)
    const left = 70;
    const marginPercent = 0.1;
    const minMargin = 10;
    const trackWidth = flowLayout ? flowLayout.contentWidth : 300;
    const margin = Math.max(minMargin, trackWidth * marginPercent);
    // Estimate where nodes start - use a reasonable default if we can't calculate exactly
    const nodeStartX = left + margin + 20; // Add some buffer for centering offset
    const stemEndXFull = Math.min(nodeStartX + 30, W - 18); // End stem 30px after nodes start, but don't go past right edge
    // Reduce stem length by half
    const stemEndX = junctionX + (stemEndXFull - junctionX) / 2;
    
    if (useWebGPU) {
      for (let i=0;i<sortedWin.length;i++) {
        const v = sortedWin[i];
        const variantIdx = variants.findIndex(v2 => v2.id === v.id);
        const isHovered = (state.hoveredVariantId != null && v.id === state.hoveredVariantId);
        const color = isHovered ? blueHex : grayHex;
        const alpha = isHovered ? 0.7 : 0.5;
        // Position column based on mode
        const y = variantMode === "genomic" 
          ? yGenomeCanonical(v.pos, H)
          : yColumn(i, sortedWin.length);
        const yScaled = yBandToFlow(y) * devicePixelRatio;
        flowInstancedRenderer.addLine(
          junctionX * devicePixelRatio, yScaled,
          stemEndX * devicePixelRatio, yScaled,
          color, alpha
        );
      }
    } else {
      for (let i=0;i<sortedWin.length;i++) {
        const v = sortedWin[i];
        const variantIdx = variants.findIndex(v2 => v2.id === v.id);
        const isHovered = (state.hoveredVariantId != null && v.id === state.hoveredVariantId);
        ctx.strokeStyle = isHovered ? colBlue : colGray;
        ctx.globalAlpha = isHovered ? 0.7 : 0.5;
        ctx.lineWidth = isHovered ? 2.5 : 1;
        // Position column based on mode
        const y = variantMode === "genomic" 
          ? yGenomeCanonical(v.pos, H)
          : yColumn(i, sortedWin.length);
        ctx.beginPath();
        ctx.moveTo(junctionX, y);
        ctx.lineTo(stemEndX, y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1.0;
    }

    // Text labels (still use Canvas 2D for text)
    // Group variants by position to handle multiple variants at same position
    const variantsByPos = new Map();
    for (const v of sortedWin) {
      const pos = v.pos;
      if (!variantsByPos.has(pos)) {
        variantsByPos.set(pos, []);
      }
      variantsByPos.get(pos).push(v);
    }
    
    // Helper function to draw multi-line text (for variants at same position)
    const drawMultiLineText = (text, x, y, lineHeight = 12) => {
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        ctx.fillText(lines[i], x, y + i * lineHeight);
      }
    };
    
    // Calculate if we have enough space to show all labels
    // In vertical mode, labels are rotated 90 degrees, so text width becomes vertical height
    ctx.font = "12px ui-sans-serif, system-ui";
    const uniquePositions = Array.from(variantsByPos.keys()).sort((a, b) => a - b);
    const maxLabelWidth = Math.max(...uniquePositions.map(pos => {
      const idsAtPos = variantsByPos.get(pos).map(v => v.id).join('\n');
      return ctx.measureText(idsAtPos).width;
    }), 30);
    // When rotated, the label takes up maxLabelWidth pixels vertically
    // We need spacing between labels, so add some padding
    const minSpacing = maxLabelWidth + 10; // minimum pixels between label centers
    
    // Check spacing between consecutive variant positions
    // For genomic mode, check actual Y positions; for equidistant, use calculated spacing
    let hasEnoughSpace = uniquePositions.length === 0;
    if (uniquePositions.length > 0) {
      if (variantMode === "genomic") {
        // In genomic mode, check minimum spacing between actual positions
        const positions = uniquePositions.map(pos => yGenomeCanonical(pos, H)).sort((a, b) => a - b);
        let minActualSpacing = Infinity;
        for (let i = 1; i < positions.length; i++) {
          const spacing = positions[i] - positions[i - 1];
          if (spacing < minActualSpacing) {
            minActualSpacing = spacing;
          }
        }
        hasEnoughSpace = minActualSpacing >= minSpacing;
      } else {
        // In equidistant mode, calculate spacing
        const avgSpacing = H / uniquePositions.length;
        hasEnoughSpace = avgSpacing >= minSpacing;
      }
    }
    
    // Store variant label positions for hit testing
    const variantLabelPositions = [];
    
    ctx.fillStyle = colText;
    // Iterate over unique positions
    for (let posIdx = 0; posIdx < uniquePositions.length; posIdx++) {
      const pos = uniquePositions[posIdx];
      const variantsAtPos = variantsByPos.get(pos);
      const firstVariant = variantsAtPos[0];
      const variantIdx = variants.findIndex(v2 => v2.id === firstVariant.id);
      
      // Calculate Y position for this position
      // For equidistant mode, use the position index (not variant index) so variants at same position overlap
      let y;
      if (variantMode === "genomic") {
        y = yGenomeCanonical(pos, H);
      } else {
        // Use position index so all variants at same position get same Y coordinate
        y = yColumn(posIdx, uniquePositions.length);
      }
      
      // Determine if we should show this label
      const isHovered = variantsAtPos.some(v => state.hoveredVariantId === v.id);
      const isPinned = variantsAtPos.some(v => state.pinnedVariantLabels.has(v.id));
      const shouldShow = isHovered || isPinned || hasEnoughSpace;
      
      if (shouldShow) {
        // Show first ID (or count if multiple)
        const displayText = variantsAtPos.length > 1 
          ? `${variantsAtPos[0].id} (+${variantsAtPos.length - 1})`
          : variantsAtPos[0].id;
        
        ctx.save();
        ctx.translate(14, y + 6);
        ctx.rotate(-Math.PI/2);
        ctx.fillText(displayText, 0, 0);
        ctx.restore();
      }
      
      // Store position for hit testing (for click-to-pin and tooltip) - one entry per position
      const firstVariantIdx = variants.findIndex(v2 => v2.id === firstVariant.id);
      const displayText = variantsAtPos.length > 1 
        ? `${variantsAtPos[0].id} (+${variantsAtPos.length - 1})`
        : variantsAtPos[0].id;
      const labelWidth = ctx.measureText(displayText).width;
      const labelIds = (firstVariant.displayIds && firstVariant.displayIds.length > 0)
        ? firstVariant.displayIds
        : [firstVariant.id];
      variantLabelPositions.push({
        variantId: firstVariant.id, // Use first variant ID for compatibility
        variantIdx: firstVariantIdx,
        x: 14,
        y: y,
        width: labelWidth, // When rotated, this is the vertical extent
        height: labelWidth, // Same as width when rotated
        allIds: labelIds, // Store all IDs for tooltip
        position: pos
      });
    }
    
    // Store positions globally for click detection
    window._variantLabelPositions = variantLabelPositions;

    // Connector lines from ruler to columns
    const x0 = 6;
    if (useWebGPU) {
      for (let i=0; i<sortedWin.length; i++) {
        const v = sortedWin[i];
        const variantIdx = variants.findIndex(v2 => v2.id === v.id);
        const isHovered = (state.hoveredVariantId != null && v.id === state.hoveredVariantId);
        const color = isHovered ? blueHex : grayHex;
        const alpha = isHovered ? 0.7 : 0.5;
        const vy = yGenomeCanonical(v.pos, H); // always use genomic position for ruler connection
        const cy = variantMode === "genomic"
          ? yGenomeCanonical(v.pos, H)
          : yColumn(i, sortedWin.length);
        flowInstancedRenderer.addLine(
          x0 * devicePixelRatio, yBandToFlow(vy) * devicePixelRatio,
          junctionX * devicePixelRatio, yBandToFlow(cy) * devicePixelRatio,
          color, alpha
        );
      }
    } else {
      for (let i=0; i<sortedWin.length; i++) {
        const v = sortedWin[i];
        const variantIdx = variants.findIndex(v2 => v2.id === v.id);
        const isHovered = (state.hoveredVariantId != null && v.id === state.hoveredVariantId);
        ctx.strokeStyle = isHovered ? colBlue : colGray;
        ctx.globalAlpha = isHovered ? 0.7 : 0.5;
        ctx.lineWidth = isHovered ? 2.5 : 1;
        const vy = yGenomeCanonical(v.pos, H);
        const cy = variantMode === "genomic"
          ? yGenomeCanonical(v.pos, H)
          : yColumn(i, sortedWin.length);
        ctx.beginPath();
        ctx.moveTo(x0, vy);
        ctx.lineTo(junctionX, cy);
        ctx.stroke();
      }
      ctx.globalAlpha = 1.0;
    }
  } else {
    // columns (vertical lines) - shortened to end near where allele nodes start
    // Calculate where allele nodes start (top + margin + vertical offset)
    const top = 0;
    const marginPercent = 0.1;
    const minMargin = 10;
    const trackHeight = flowLayout ? flowLayout.contentHeight : 300;
    const margin = Math.max(minMargin, trackHeight * marginPercent);
    // Estimate where nodes start - use a reasonable default if we can't calculate exactly
    const nodeStartY = top + margin + 20; // Add some buffer for centering offset
    const stemEndYFull = Math.min(nodeStartY + 30, H - 18); // End stem 30px after nodes start, but don't go past bottom
    // Reduce stem length by half
    const stemEndY = junctionY + (stemEndYFull - junctionY) / 2;
    
    if (useWebGPU) {
      for (let i=0;i<win.length;i++) {
        const v = win[i];
        const variantIdx = variants.findIndex(v2 => v2.id === v.id);
        const isHovered = (state.hoveredVariantId != null && v.id === state.hoveredVariantId);
        const color = isHovered ? blueHex : grayHex;
        const alpha = isHovered ? 0.7 : 0.5;
        // Position column based on mode
        const x = variantMode === "genomic"
          ? xGenomeCanonical(v.pos, W)
          : xColumn(i, win.length);
        const xScaled = x * devicePixelRatio;
        flowInstancedRenderer.addLine(
          xScaled, yBandToFlow(junctionY) * devicePixelRatio,
          xScaled, yBandToFlow(stemEndY) * devicePixelRatio,
          color, alpha
        );
      }
    } else {
      for (let i=0;i<win.length;i++) {
        const v = win[i];
        const variantIdx = variants.findIndex(v2 => v2.id === v.id);
        const isHovered = (state.hoveredVariantId != null && v.id === state.hoveredVariantId);
        ctx.strokeStyle = isHovered ? colBlue : colGray;
        ctx.globalAlpha = isHovered ? 0.7 : 0.5;
        ctx.lineWidth = isHovered ? 2.5 : 1;
        // Position column based on mode
        const x = variantMode === "genomic"
          ? xGenomeCanonical(v.pos, W)
          : xColumn(i, win.length);
        ctx.beginPath();
        ctx.moveTo(x, junctionY);
        ctx.lineTo(x, stemEndY);
        ctx.stroke();
      }
      ctx.globalAlpha = 1.0;
    }

    // Text labels (still use Canvas 2D for text)
    // Group variants by position to handle multiple variants at same position
    const variantsByPos = new Map();
    for (const v of win) {
      const pos = v.pos;
      if (!variantsByPos.has(pos)) {
        variantsByPos.set(pos, []);
      }
      variantsByPos.get(pos).push(v);
    }
    
    // Helper function to draw multi-line text (for variants at same position)
    const drawMultiLineText = (text, x, y, lineHeight = 12) => {
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        ctx.fillText(lines[i], x, y + i * lineHeight);
      }
    };
    
    // Calculate if we have enough space to show all labels
    // Estimate label width (measure text to be more accurate)
    ctx.font = "12px ui-sans-serif, system-ui";
    const uniquePositions = Array.from(variantsByPos.keys()).sort((a, b) => a - b);
    const maxLabelWidth = Math.max(...uniquePositions.map(pos => {
      const idsAtPos = variantsByPos.get(pos).map(v => v.id).join('\n');
      return ctx.measureText(idsAtPos).width;
    }), 50);
    const minSpacing = maxLabelWidth + 20; // minimum pixels between labels
    const hasEnoughSpace = uniquePositions.length === 0 || (W / uniquePositions.length) >= minSpacing;
    
    // Store variant label positions for hit testing
    const variantLabelPositions = [];
    
    ctx.fillStyle = colText;
    // Iterate over unique positions
    for (let posIdx = 0; posIdx < uniquePositions.length; posIdx++) {
      const pos = uniquePositions[posIdx];
      const variantsAtPos = variantsByPos.get(pos);
      const firstVariant = variantsAtPos[0];
      const variantIdx = variants.findIndex(v2 => v2.id === firstVariant.id);
      
      // Calculate X position for this position
      // For equidistant mode, use the position index (not variant index) so variants at same position overlap
      let x;
      if (variantMode === "genomic") {
        x = xGenomeCanonical(pos, W);
      } else {
        // Use position index so all variants at same position get same X coordinate
        x = xColumn(posIdx, uniquePositions.length);
      }
      
      // Determine if we should show this label
      const isHovered = variantsAtPos.some(v => state.hoveredVariantId === v.id);
      const isPinned = variantsAtPos.some(v => state.pinnedVariantLabels.has(v.id));
      const shouldShow = isHovered || isPinned || hasEnoughSpace;
      
      if (shouldShow) {
        // Show first ID (or count if multiple)
        const displayText = variantsAtPos.length > 1 
          ? `${variantsAtPos[0].id} (+${variantsAtPos.length - 1})`
          : variantsAtPos[0].id;
        ctx.fillText(displayText, x - 10, 14);
      }
      
      // Store position for hit testing (for click-to-pin and tooltip) - one entry per position
      const firstVariantIdx = variants.findIndex(v2 => v2.id === firstVariant.id);
      const displayText = variantsAtPos.length > 1 
        ? `${variantsAtPos[0].id} (+${variantsAtPos.length - 1})`
        : variantsAtPos[0].id;
      const labelWidth = ctx.measureText(displayText).width;
      const labelIds = (firstVariant.displayIds && firstVariant.displayIds.length > 0)
        ? firstVariant.displayIds
        : [firstVariant.id];
      variantLabelPositions.push({
        variantId: firstVariant.id, // Use first variant ID for compatibility
        variantIdx: firstVariantIdx,
        x: x - 10,
        y: 2, // Text baseline is at y=14, but text extends upward, so hit box starts at y=2
        width: labelWidth,
        height: 14, // Single line height
        allIds: labelIds, // Store all IDs for tooltip
        position: pos
      });
    }
    
    // Store positions globally for click detection
    window._variantLabelPositions = variantLabelPositions;

    // Connector lines from ruler to columns
    const y0 = 6;
    if (useWebGPU) {
      for (let i=0; i<win.length; i++) {
        const v = win[i];
        const variantIdx = variants.findIndex(v2 => v2.id === v.id);
        const isHovered = (state.hoveredVariantId != null && v.id === state.hoveredVariantId);
        const color = isHovered ? blueHex : grayHex;
        const alpha = isHovered ? 0.7 : 0.5;
        const vx = xGenomeCanonical(v.pos, W);
        const cx = variantMode === "genomic"
          ? xGenomeCanonical(v.pos, W)
          : xColumn(i, win.length);
        flowInstancedRenderer.addLine(
          vx * devicePixelRatio, yBandToFlow(y0) * devicePixelRatio,
          cx * devicePixelRatio, yBandToFlow(junctionY) * devicePixelRatio,
          color, alpha
        );
      }
    } else {
      for (let i=0; i<win.length; i++) {
        const v = win[i];
        const variantIdx = variants.findIndex(v2 => v2.id === v.id);
        const isHovered = (state.hoveredVariantId != null && v.id === state.hoveredVariantId);
        ctx.strokeStyle = isHovered ? colBlue : colGray;
        ctx.globalAlpha = isHovered ? 0.7 : 0.5;
        ctx.lineWidth = isHovered ? 2.5 : 1;
        const vx = xGenomeCanonical(v.pos, W);
        const cx = variantMode === "genomic"
          ? xGenomeCanonical(v.pos, W)
          : xColumn(i, win.length);
        ctx.beginPath();
        ctx.moveTo(vx, y0);
        ctx.lineTo(cx, junctionY);
        ctx.stroke();
      }
      ctx.globalAlpha = 1.0;
    }
  }

  // Helper function to format allele with length suffix
  // Make it globally accessible for drag handlers
  // Uses precomputed formatted labels from backend if available for performance
  window.formatAlleleLabel = function formatAlleleLabel(allele, variant) {
    // If variant is provided and has precomputed formatted labels, use them
    if (variant) {
      // Check for no-call
      if (!allele || allele === ".") {
        return ". (no-call)";
      }
      // Check for reference allele
      if (variant.hasOwnProperty('formattedRefAllele') && variant.refAllele === allele) {
        return variant.formattedRefAllele;
      }
      // Check for alt alleles
      if (variant.hasOwnProperty('formattedAltAlleles') && variant.altAlleles) {
        const altIndex = variant.altAlleles.indexOf(allele);
        if (altIndex >= 0 && altIndex < variant.formattedAltAlleles.length) {
          return variant.formattedAltAlleles[altIndex];
        }
      }
    }
    // Fallback to computation for backward compatibility or when variant not provided
    if (!allele || allele === ".") {
      return ". (no-call)";
    }
    const length = allele.length;
    const lengthLabel = length === 1 ? "1 bp" : `${length} bp`;
    // Truncate to 50 bp and add "..." if longer
    const displayAllele = length > 50 ? allele.substring(0, 50) + "..." : allele;
    return `${displayAllele} (${lengthLabel})`;
  };
  
  // Helper function to get all formatted labels for a variant
  // Uses precomputed formatted labels from backend if available for performance
  // Exposed on window for handleVariantRectClick (main.js)
  window.getFormattedLabelsForVariant = function getFormattedLabelsForVariant(variant) {
    const labels = [];
    const labelToAllele = new Map();
    
    // Use precomputed formatted labels if available
    if (variant.hasOwnProperty('formattedRefAllele') && variant.hasOwnProperty('formattedAltAlleles')) {
      // Add no-call label
      const noCallLabel = ". (no-call)";
      labels.push(noCallLabel);
      labelToAllele.set(noCallLabel, ".");
      
      // Add reference allele label
      if (variant.formattedRefAllele) {
        labels.push(variant.formattedRefAllele);
        labelToAllele.set(variant.formattedRefAllele, variant.refAllele || ".");
      }
      
      // Add alt allele labels
      if (variant.formattedAltAlleles && variant.altAlleles) {
        for (let i = 0; i < variant.formattedAltAlleles.length && i < variant.altAlleles.length; i++) {
          const label = variant.formattedAltAlleles[i];
          const allele = variant.altAlleles[i];
          labels.push(label);
          labelToAllele.set(label, allele);
        }
      }
    } else {
      // Fallback to computation for backward compatibility
      const noCallLabel = formatAlleleLabel(".");
      labels.push(noCallLabel);
      labelToAllele.set(noCallLabel, ".");
      
      if (variant.refAllele) {
        const refLabel = formatAlleleLabel(variant.refAllele);
        labels.push(refLabel);
        labelToAllele.set(refLabel, variant.refAllele);
      }
      
      if (variant.altAlleles && Array.isArray(variant.altAlleles)) {
        for (let k = 0; k < variant.altAlleles.length; k++) {
          const altLabel = formatAlleleLabel(variant.altAlleles[k]);
          labels.push(altLabel);
          labelToAllele.set(altLabel, variant.altAlleles[k]);
        }
      }
    }
    
    return { labels, labelToAllele };
  };
  
  // Helper function to extract allele string from formatted label
  function extractAlleleFromLabel(label) {
    // Label format is "ALLELE (X bp)" or ". (no-call)"
    if (label.startsWith(". (no-call)")) return ".";
    const match = label.match(/^(.+?)\s*\([^)]+\)$/);
    return match ? match[1] : label;
  }
  
  // Convert HSLA to RGBA so WebGPU path (which only parses rgba) can draw all nodes opaque
  function hslaToRgba(h, s, l, a) {
    s /= 100;
    l /= 100;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m = l - c / 2;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; b = 0; } else if (h < 120) { r = x; g = c; b = 0; }
    else if (h < 180) { r = 0; g = c; b = x; } else if (h < 240) { r = 0; g = x; b = c; }
    else if (h < 300) { r = x; g = 0; b = c; } else { r = c; g = 0; b = x; }
    return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255), a];
  }

  // Helper function to get node colors based on allele type
  // Always returns rgba() so WebGPU fill path works for all colors (red/purple were hsla and were skipped)
  function getAlleleNodeColors(label, variant, actualAllele, isDragging) {
    const noCallLabel = formatAlleleLabel(".");
    const currentOpacity = 1.0; // Opaque nodes (WebGPU only parses rgba, so we always use rgba)
    
    let fillColor, strokeColor;
    
    if (label === noCallLabel) {
      fillColor = `rgba(200,200,200,${currentOpacity})`;
      strokeColor = `rgba(200,200,200,${currentOpacity})`;
    } else {
      const allele = actualAllele || extractAlleleFromLabel(label);
      const refLen = variant.refAllele ? variant.refAllele.length : 0;
      const alleleLen = allele.length;
      
      if (alleleLen === 1) {
        fillColor = `rgba(100,150,255,${currentOpacity})`;
        strokeColor = `rgba(100,150,255,${currentOpacity})`;
      } else {
        let isDeletion = false;
        let isInsertion = false;
        
        if (variant.hasOwnProperty('variantType')) {
          const variantType = variant.variantType;
          isDeletion = variantType === 'deletion' || variantType === 'complex';
          isInsertion = variantType === 'insertion' || variantType === 'complex';
        } else {
          if (variant.altAlleles && Array.isArray(variant.altAlleles) && variant.altAlleles.length > 0) {
            const hasShorterAlt = variant.altAlleles.some(alt => alt.length < refLen);
            const hasLongerAlt = variant.altAlleles.some(alt => alt.length > refLen);
            if (hasShorterAlt && !hasLongerAlt) isDeletion = true;
            else if (hasLongerAlt && !hasShorterAlt) isInsertion = true;
          }
        }
        
        if (isDeletion) {
          // Single consistent red for all deletions (no lightness gradient)
          const [r, g, b] = hslaToRgba(0, 70, 55, currentOpacity);
          fillColor = `rgba(${r},${g},${b},${currentOpacity})`;
          strokeColor = `rgba(${r},${g},${b},${currentOpacity})`;
        } else if (isInsertion) {
          // Single consistent purple for all insertions
          const [r, g, b] = hslaToRgba(280, 70, 55, currentOpacity);
          fillColor = `rgba(${r},${g},${b},${currentOpacity})`;
          strokeColor = `rgba(${r},${g},${b},${currentOpacity})`;
        } else {
          fillColor = `rgba(100,150,255,${currentOpacity})`;
          strokeColor = `rgba(100,150,255,${currentOpacity})`;
        }
      }
    }
    
    return { fillColor, strokeColor };
  }
  
  // Helper function to calculate allele node sizes based on frequencies
  // Make it globally accessible for drag handlers
  window.calculateAlleleSizes = function calculateAlleleSizes(variant, totalSpace, minSize, gap, numAlleles) {
    const alleleFrequencies = variant.alleleFrequencies || {};
    
    // Add margins to make the display more comfortable
    // Use 10% margin on each side (20% total), with a minimum of 20 pixels total
    const marginPercent = 0.1;
    const minMargin = 10;
    const margin = Math.max(minMargin, totalSpace * marginPercent);
    const availableSpace = totalSpace - (2 * margin);
    
    // If no frequencies available, return equal sizes
    if (!alleleFrequencies || Object.keys(alleleFrequencies).length === 0) {
      const equalSize = Math.max(minSize, (availableSpace - (numAlleles - 1) * gap) / numAlleles);
      const sizes = {};
      
      // Use helper function to get formatted labels (uses precomputed values if available)
      const { labels, labelToAllele } = getFormattedLabelsForVariant(variant);
      
      // Get precomputed labels for key mapping
      const noCallLabel = ". (no-call)";
      const refLabel = variant.hasOwnProperty('formattedRefAllele') && variant.formattedRefAllele
        ? variant.formattedRefAllele
        : (variant.refAllele ? formatAlleleLabel(variant.refAllele) : null);
      
      for (const label of labels) {
        // Map label to allele key
        let key = ".";
        if (label === noCallLabel) {
          key = ".";
        } else if (label === refLabel) {
          key = "ref";
        } else {
          // Find which alt allele this is using labelToAllele map or fallback
          const actualAllele = labelToAllele.get(label);
          if (actualAllele && variant.altAlleles && Array.isArray(variant.altAlleles)) {
            const altIndex = variant.altAlleles.indexOf(actualAllele);
            if (altIndex >= 0) {
              key = `a${altIndex + 1}`;
            }
          } else if (variant.altAlleles && Array.isArray(variant.altAlleles)) {
            // Fallback: find by comparing formatted labels
            const altIndex = variant.altAlleles.findIndex(alt => formatAlleleLabel(alt) === label);
            if (altIndex >= 0) {
              key = `a${altIndex + 1}`;
            }
          }
        }
        sizes[key] = equalSize;
      }
      return sizes;
    }
    
    // Calculate total minimum size needed
    const totalMinSize = numAlleles * minSize;
    const totalGapSize = (numAlleles - 1) * gap;
    const remainingSpace = availableSpace - totalMinSize - totalGapSize;
    
    if (remainingSpace < 0) {
      // Edge case: minimum sizes exceed available space
      // Just use minimum sizes
      const sizes = {};
      for (const key of Object.keys(alleleFrequencies)) {
        sizes[key] = minSize;
      }
      return sizes;
    }
    
    // Redistribute remaining space proportionally
    const finalSizes = {};
    for (const [allele, freq] of Object.entries(alleleFrequencies)) {
      const proportional = freq * remainingSpace;
      finalSizes[allele] = minSize + proportional;
    }
    
    return finalSizes;
  }
  
  // Get track dimensions for sizing (current band's flowLayout)
  const trackDimension = isVertical 
    ? (flowLayout ? flowLayout.contentWidth : 300)
    : (flowLayout ? flowLayout.contentHeight : 300);
  
  // Allele nodes with drag-and-drop support
  // Define constants at function scope so they're accessible in nested functions
  const baseNodeW = 4, baseNodeH = 14, gap = 8;
  const MIN_NODE_SIZE = 4;
  
  // Make constants available globally for drag handlers
  window._alleleNodeConstants = { baseNodeW, baseNodeH, gap, MIN_NODE_SIZE };
  const nodePositions = []; // Store positions for hit testing: [{ variantId, alleleIndex, x, y, w, h }]
  
  // Store node info for ribbon drawing: Map<variantIndex, Map<alleleLabel, {x, y, w, h, top, bottom, left, right}>>
  const nodeInfoByVariant = new Map();
  
  // Collect all labels to draw at the very end (after all nodes and indicators)
  const allLabelsToDraw = [];
  
  if (isVertical) {
    const sortedWin = [...win].sort((a, b) => a.pos - b.pos);
    const left = 70;
    
    // Calculate margin for allele nodes (same as in calculateAlleleSizes)
    const marginPercent = 0.1;
    const minMargin = 10;
    const margin = Math.max(minMargin, trackDimension * marginPercent);
    
    for (let i=0;i<sortedWin.length;i++){
      const v = sortedWin[i];
      const variantIdx = variants.findIndex(v2 => v2.id === v.id);
      
      // Get allele labels with actual alleles: ['.', refAllele, altAllele1, altAllele2, ...]
      // Use helper function to get formatted labels (uses precomputed values if available)
      const { labels, labelToAllele } = getFormattedLabelsForVariant(v);
      
      // Get order from state, or use default
      const variantOrderKey = variantOrderKeyFor(track.id, v.id);
      let order = state.variantAlleleOrder.get(variantOrderKey);
      if (!order || order.length !== labels.length) {
        order = [...labels];
        state.variantAlleleOrder.set(variantOrderKey, order);
      }
      
      // Calculate allele sizes based on frequencies
      const alleleSizes = calculateAlleleSizes(v, trackDimension, MIN_NODE_SIZE, gap, order.length);
      
      // Map labels to allele keys for size lookup
      // Use precomputed labels if available
      const noCallLabel = ". (no-call)";
      const refLabel = v.hasOwnProperty('formattedRefAllele') && v.formattedRefAllele
        ? v.formattedRefAllele
        : (v.refAllele ? formatAlleleLabel(v.refAllele) : null);
      function getAlleleKey(label) {
        if (label === noCallLabel) return ".";
        if (label === refLabel) return "ref";
        // Use labelToAllele map for efficient lookup
        const actualAllele = labelToAllele.get(label);
        if (actualAllele && v.altAlleles && Array.isArray(v.altAlleles)) {
          const altIndex = v.altAlleles.indexOf(actualAllele);
          if (altIndex >= 0) return `a${altIndex + 1}`;
        }
        // Fallback: find by comparing formatted labels
        if (v.altAlleles && Array.isArray(v.altAlleles)) {
          const altIndex = v.altAlleles.findIndex(alt => formatAlleleLabel(alt) === label);
          if (altIndex >= 0) return `a${altIndex + 1}`;
        }
        return "."; // fallback
      }
      
      // Position based on variant layout mode
      const cy = variantMode === "genomic"
        ? yGenomeCanonical(v.pos, H)
        : yColumn(i, sortedWin.length);
      
      // Calculate total width of all nodes plus gaps
      let totalNodesWidth = 0;
      for (let j = 0; j < order.length; j++) {
        const label = order[j];
        const alleleKey = getAlleleKey(label);
        const nodeW = alleleSizes[alleleKey] || baseNodeW;
        totalNodesWidth += nodeW;
        if (j < order.length - 1) {
          totalNodesWidth += gap;
        }
      }
      
      // Center the nodes horizontally within the actual available space
      // Account for left offset and right margin to ensure nodes don't extend beyond track boundaries
      const availableWidth = W - left - margin;
      const horizontalOffset = Math.max(0, (availableWidth - totalNodesWidth) / 2);
      
      // Calculate cumulative positions for variable-width nodes, starting with left + horizontal offset
      let currentX = left + horizontalOffset;
      
      // Check if this variant column is hovered
      const isVariantHovered = (state.hoveredVariantId != null && v.id === state.hoveredVariantId);
      
      // Draw nodes in current order
      for (let j=0;j<order.length;j++){
        const label = order[j];
        const alleleKey = getAlleleKey(label);
        let nodeW = alleleSizes[alleleKey] || baseNodeW;
        let nodeH = baseNodeW;
        
        // Increase width when variant is hovered (vertical mode = horizontal nodes)
        if (isVariantHovered) {
          nodeH += 2;
        }
        
        const x = currentX;
        
        // Check if this node is being dragged
        const isDragging = state.alleleDragState &&
          (state.alleleDragState.trackId || "") === (track.id || "") &&
          state.alleleDragState.variantId === v.id && 
          state.alleleDragState.alleleIndex === order.indexOf(label);
        const dragOffsetX = isDragging ? state.alleleDragState.offsetX : 0;
        const dragOffsetY = isDragging ? state.alleleDragState.offsetY : 0;
        
        const nodeX = x + dragOffsetX;
        const nodeY = cy - nodeH/2 + dragOffsetY;

        // Get colors based on allele type (use actual allele from map, not extracted from label)
        const actualAllele = labelToAllele.get(label) || extractAlleleFromLabel(label);
        const colors = getAlleleNodeColors(label, v, actualAllele, isDragging);
        
        // Use WebGPU for fill if available, otherwise fall back to Canvas2D
        const devicePixelRatio = window.devicePixelRatio || 1;
        const useWebGPU = webgpuSupported && flowInstancedRenderer;
        
        if (useWebGPU) {
          // Parse rgba color string to array for WebGPU
          const fillMatch = colors.fillColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
          if (fillMatch) {
            const r = parseInt(fillMatch[1]) / 255;
            const g = parseInt(fillMatch[2]) / 255;
            const b = parseInt(fillMatch[3]) / 255;
            const a = fillMatch[4] !== undefined ? parseFloat(fillMatch[4]) : 1.0;
            // Scale coordinates to physical pixels for WebGPU (yBandToFlow for multi-track)
            flowInstancedRenderer.addRect(
              nodeX * devicePixelRatio,
              yBandToFlow(nodeY) * devicePixelRatio,
              nodeW * devicePixelRatio,
              nodeH * devicePixelRatio,
              [r, g, b, a]
            );
          }
        } else {
          // Fallback to Canvas2D
          ctx.fillStyle = colors.fillColor;
          ctx.beginPath();
          roundRect(ctx, nodeX, nodeY, nodeW, nodeH, 5);
          ctx.fill();
        }
        
        // Check if this allele is selected
        const selectionKey = selectionKeyFor(track.id, v.id, order.indexOf(label));
        const isSelected = state.selectedAlleles.has(selectionKey);
        
        // Stroke always uses Canvas2D (minimal overhead for borders)
        // Use highlight color and thicker stroke for selected alleles
        if (isSelected) {
          ctx.strokeStyle = "rgba(255, 215, 0, 1)"; // Gold highlight for selected
          ctx.lineWidth = 3;
        } else {
          ctx.strokeStyle = colors.strokeColor;
          ctx.lineWidth = isDragging ? 2 : 1;
        }
        ctx.beginPath();
        roundRect(ctx, nodeX, nodeY, nodeW, nodeH, 5);
        ctx.stroke();

        // Store label info for drawing after all nodes
        const labelKey = selectionKeyFor(track.id, v.id, order.indexOf(label));
        const isHovered = state.hoveredAlleleNode &&
          (state.hoveredAlleleNode.trackId || "") === (track.id || "") &&
          state.hoveredAlleleNode.variantId === v.id && 
          state.hoveredAlleleNode.alleleIndex === order.indexOf(label);
        const isPinned = state.pinnedAlleleLabels.has(labelKey);
        
        if (isHovered || isPinned || isSelected) {
          const sampleCount = (
            v.alleleSampleCounts &&
            Object.prototype.hasOwnProperty.call(v.alleleSampleCounts, alleleKey)
          )
            ? v.alleleSampleCounts[alleleKey]
            : 0;
          const labelText = `${label} - ${sampleCount} sample${sampleCount === 1 ? '' : 's'}`;
          allLabelsToDraw.push({
            label: label,
            text: labelText,
            nodeX: nodeX,
            nodeY: nodeY,
            nodeW: nodeW,
            nodeH: nodeH,
            isVertical: true
          });
        }
        
        // Store position for hit testing (global flow coords + bandOffset for multi-track)
        nodePositions.push({
          trackId: track.id,
          variantId: v.id,
          alleleIndex: order.indexOf(label),
          label: label,
          x: xBandToFlow(nodeX),
          y: nodeY,
          w: nodeW,
          h: nodeH,
          bandOffset: bandOffset,
          isSelected: isSelected
        });
        
        // Store node info for ribbon drawing
        if (!nodeInfoByVariant.has(i)) {
          nodeInfoByVariant.set(i, new Map());
        }
        nodeInfoByVariant.get(i).set(label, {
          x: nodeX,
          y: nodeY,
          w: nodeW,
          isSelected: isSelected,
          h: nodeH,
          top: nodeY,
          bottom: nodeY + nodeH,
          left: nodeX,
          right: nodeX + nodeW
        });
        
        // Update position for next node
        currentX += nodeW + gap;
      }
      
      // Draw drop indicator if dragging this variant
      if (state.alleleDragState &&
          (state.alleleDragState.trackId || "") === (track.id || "") &&
          state.alleleDragState.variantId === v.id &&
          state.alleleDragState.dropIndex !== null && state.alleleDragState.dropIndex !== undefined) {
        const dropIdx = state.alleleDragState.dropIndex;
        const currentIdx = order.indexOf(state.alleleDragState.label);
        
        // Only show indicator if dropping at a different position
        if (dropIdx !== currentIdx) {
          // Calculate drop position accounting for variable node widths, margin, and centering
          // Recalculate total width and horizontal offset (same as above)
          let totalNodesWidth = 0;
          for (let k = 0; k < order.length; k++) {
            const label = order[k];
            const alleleKey = getAlleleKey(label);
            const nodeW = alleleSizes[alleleKey] || baseNodeW;
            totalNodesWidth += nodeW;
            if (k < order.length - 1) {
              totalNodesWidth += gap;
            }
          }
          const availableWidth = W - left - margin;
          const horizontalOffset = Math.max(0, (availableWidth - totalNodesWidth) / 2);
          
          let indicatorX = left + horizontalOffset;
          for (let k = 0; k < dropIdx; k++) {
            const label = order[k];
            const alleleKey = getAlleleKey(label);
            const nodeW = alleleSizes[alleleKey] || baseNodeW;
            indicatorX += nodeW + gap;
          }
          // For the last position, draw after the last node
          if (dropIdx === order.length - 1) {
            const label = order[dropIdx];
            const alleleKey = getAlleleKey(label);
            const nodeW = alleleSizes[alleleKey] || baseNodeW;
            indicatorX += nodeW;
          }
          ctx.strokeStyle = "rgba(120, 180, 255, 0.8)"; // Use accent blue color
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(indicatorX, cy - baseNodeH/2 - 4);
          ctx.lineTo(indicatorX, cy + baseNodeH/2 + 4);
          ctx.stroke();
        }
      }
    }
  } else {
    for (let i=0;i<win.length;i++){
      const v = win[i];
      const variantIdx = variants.findIndex(v2 => v2.id === v.id);
      
      // Get allele labels with actual alleles: ['.', refAllele, altAllele1, altAllele2, ...]
      // Use helper function to get formatted labels (uses precomputed values if available)
      const { labels, labelToAllele } = getFormattedLabelsForVariant(v);
      
      // Get order from state, or use default
      const variantOrderKey = variantOrderKeyFor(track.id, v.id);
      let order = state.variantAlleleOrder.get(variantOrderKey);
      if (!order || order.length !== labels.length) {
        order = [...labels];
        state.variantAlleleOrder.set(variantOrderKey, order);
      }
      
      // Calculate allele sizes based on frequencies
      const alleleSizes = calculateAlleleSizes(v, trackDimension, MIN_NODE_SIZE, gap, order.length);
      
      // Map labels to allele keys for size lookup
      // Use precomputed labels if available
      const noCallLabel = ". (no-call)";
      const refLabel = v.hasOwnProperty('formattedRefAllele') && v.formattedRefAllele
        ? v.formattedRefAllele
        : (v.refAllele ? formatAlleleLabel(v.refAllele) : null);
      function getAlleleKey(label) {
        if (label === noCallLabel) return ".";
        if (label === refLabel) return "ref";
        // Use labelToAllele map for efficient lookup
        const actualAllele = labelToAllele.get(label);
        if (actualAllele && v.altAlleles && Array.isArray(v.altAlleles)) {
          const altIndex = v.altAlleles.indexOf(actualAllele);
          if (altIndex >= 0) return `a${altIndex + 1}`;
        }
        // Fallback: find by comparing formatted labels
        if (v.altAlleles && Array.isArray(v.altAlleles)) {
          const altIndex = v.altAlleles.findIndex(alt => formatAlleleLabel(alt) === label);
          if (altIndex >= 0) return `a${altIndex + 1}`;
        }
        return "."; // fallback
      }
      
      // Position based on variant layout mode
      const cx = variantMode === "genomic"
        ? xGenomeCanonical(win[i].pos, W)
        : xColumn(i, win.length);
      const top = 20;

      // Calculate margin for allele nodes (same as in calculateAlleleSizes)
      const marginPercent = 0.1;
      const minMargin = 10;
      const margin = Math.max(minMargin, trackDimension * marginPercent);
      
      // Calculate total height of all nodes plus gaps
      let totalNodesHeight = 0;
      for (let j = 0; j < order.length; j++) {
        const label = order[j];
        const alleleKey = getAlleleKey(label);
        const nodeH = alleleSizes[alleleKey] || baseNodeH;
        totalNodesHeight += nodeH;
        if (j < order.length - 1) {
          totalNodesHeight += gap;
        }
      }
      
      // Center the nodes vertically within the actual available space
      // Account for top offset and bottom margin to ensure nodes don't extend beyond track boundaries
      const availableHeight = H - top - margin;
      const verticalOffset = Math.max(0, (availableHeight - totalNodesHeight) / 2);

      // Calculate cumulative positions for variable-height nodes, starting with top + vertical offset
      let currentY = top + verticalOffset;

      // Check if this variant column is hovered
      const isVariantHovered = (state.hoveredVariantId != null && v.id === state.hoveredVariantId);
      
      // Draw nodes in current order
      for (let j=0;j<order.length;j++){
        const label = order[j];
        const alleleKey = getAlleleKey(label);
        let nodeW = baseNodeW;
        let nodeH = alleleSizes[alleleKey] || baseNodeH;
        
        // Increase height when variant is hovered (horizontal mode = vertical nodes)
        if (isVariantHovered) {
          nodeW += 2;
        }
        
        const y = currentY;
        
        // Check if this node is being dragged
        const isDragging = state.alleleDragState &&
          (state.alleleDragState.trackId || "") === (track.id || "") &&
          state.alleleDragState.variantId === v.id && 
          state.alleleDragState.alleleIndex === order.indexOf(label);
        const dragOffsetX = isDragging ? state.alleleDragState.offsetX : 0;
        const dragOffsetY = isDragging ? state.alleleDragState.offsetY : 0;
        
        const nodeX = cx - nodeW/2 + dragOffsetX;
        const nodeY = y + dragOffsetY;

        // Get colors based on allele type (use actual allele from map, not extracted from label)
        const actualAllele = labelToAllele.get(label) || extractAlleleFromLabel(label);
        const colors = getAlleleNodeColors(label, v, actualAllele, isDragging);
        
        // Use WebGPU for fill if available, otherwise fall back to Canvas2D
        const devicePixelRatio = window.devicePixelRatio || 1;
        const useWebGPU = webgpuSupported && flowInstancedRenderer;
        
        if (useWebGPU) {
          // Parse rgba color string to array for WebGPU
          const fillMatch = colors.fillColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
          if (fillMatch) {
            const r = parseInt(fillMatch[1]) / 255;
            const g = parseInt(fillMatch[2]) / 255;
            const b = parseInt(fillMatch[3]) / 255;
            const a = fillMatch[4] !== undefined ? parseFloat(fillMatch[4]) : 1.0;
            // Scale coordinates to physical pixels for WebGPU
            flowInstancedRenderer.addRect(
              nodeX * devicePixelRatio,
              yBandToFlow(nodeY) * devicePixelRatio,
              nodeW * devicePixelRatio,
              nodeH * devicePixelRatio,
              [r, g, b, a]
            );
          }
        } else {
          // Fallback to Canvas2D
          ctx.fillStyle = colors.fillColor;
          ctx.beginPath();
          roundRect(ctx, nodeX, nodeY, nodeW, nodeH, 5);
          ctx.fill();
        }
        
        // Check if this allele is selected
        const selectionKey = selectionKeyFor(track.id, v.id, order.indexOf(label));
        const isSelected = state.selectedAlleles.has(selectionKey);
        
        // Stroke always uses Canvas2D (minimal overhead for borders)
        // Use highlight color and thicker stroke for selected alleles
        if (isSelected) {
          ctx.strokeStyle = "rgba(255, 215, 0, 1)"; // Gold highlight for selected
          ctx.lineWidth = 3;
        } else {
          ctx.strokeStyle = colors.strokeColor;
          ctx.lineWidth = isDragging ? 2 : 1;
        }
        ctx.beginPath();
        roundRect(ctx, nodeX, nodeY, nodeW, nodeH, 5);
        ctx.stroke();

        // Store label info for drawing after all nodes
        const labelKey = selectionKeyFor(track.id, v.id, order.indexOf(label));
        const isHovered = state.hoveredAlleleNode &&
          (state.hoveredAlleleNode.trackId || "") === (track.id || "") &&
          state.hoveredAlleleNode.variantId === v.id && 
          state.hoveredAlleleNode.alleleIndex === order.indexOf(label);
        const isPinned = state.pinnedAlleleLabels.has(labelKey);
        
        if (isHovered || isPinned || isSelected) {
          const sampleCount = (
            v.alleleSampleCounts &&
            Object.prototype.hasOwnProperty.call(v.alleleSampleCounts, alleleKey)
          )
            ? v.alleleSampleCounts[alleleKey]
            : 0;
          const labelText = `${label} - ${sampleCount} sample${sampleCount === 1 ? '' : 's'}`;
          allLabelsToDraw.push({
            label: label,
            text: labelText,
            nodeX: nodeX,
            nodeY: nodeY,
            nodeW: nodeW,
            nodeH: nodeH,
            isVertical: false
          });
        }
        
        // Store position for hit testing (global flow coords + bandOffset for multi-track)
        nodePositions.push({
          trackId: track.id,
          variantId: v.id,
          alleleIndex: order.indexOf(label),
          label: label,
          x: nodeX,
          y: yBandToFlow(nodeY),
          w: nodeW,
          h: nodeH,
          bandOffset: bandOffset,
          isSelected: isSelected
        });
        
        // Store node info for ribbon drawing
        if (!nodeInfoByVariant.has(i)) {
          nodeInfoByVariant.set(i, new Map());
        }
        nodeInfoByVariant.get(i).set(label, {
          x: nodeX,
          y: nodeY,
          w: nodeW,
          h: nodeH,
          top: nodeY,
          bottom: nodeY + nodeH,
          left: nodeX,
          right: nodeX + nodeW,
          isSelected: isSelected
        });
        
        // Update position for next node
        currentY += nodeH + gap;
      }
      
      // Draw drop indicator if dragging this variant
      if (state.alleleDragState &&
          (state.alleleDragState.trackId || "") === (track.id || "") &&
          state.alleleDragState.variantId === v.id &&
          state.alleleDragState.dropIndex !== null && state.alleleDragState.dropIndex !== undefined) {
        const dropIdx = state.alleleDragState.dropIndex;
        const currentIdx = order.indexOf(state.alleleDragState.label);
        
        // Only show indicator if dropping at a different position
        if (dropIdx !== currentIdx) {
          // Calculate drop position accounting for variable node heights, margin, and centering
          // Recalculate total height and vertical offset (same as above)
          let totalNodesHeight = 0;
          for (let k = 0; k < order.length; k++) {
            const label = order[k];
            const alleleKey = getAlleleKey(label);
            const nodeH = alleleSizes[alleleKey] || baseNodeH;
            totalNodesHeight += nodeH;
            if (k < order.length - 1) {
              totalNodesHeight += gap;
            }
          }
          const availableHeight = H - top - margin;
          const verticalOffset = Math.max(0, (availableHeight - totalNodesHeight) / 2);
          
          let indicatorY = top + verticalOffset;
          for (let k = 0; k < dropIdx; k++) {
            const label = order[k];
            const alleleKey = getAlleleKey(label);
            const nodeH = alleleSizes[alleleKey] || baseNodeH;
            indicatorY += nodeH + gap;
          }
          // For the last position, draw after the last node
          if (dropIdx === order.length - 1) {
            const label = order[dropIdx];
            const alleleKey = getAlleleKey(label);
            const nodeH = alleleSizes[alleleKey] || baseNodeH;
            indicatorY += nodeH;
          }
          ctx.strokeStyle = "rgba(120, 180, 255, 0.8)"; // Use accent blue color
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(cx - baseNodeW/2 - 4, indicatorY);
          ctx.lineTo(cx + baseNodeW/2 + 4, indicatorY);
          ctx.stroke();
        }
      }
    }
  }
  
  // Draw ribbons only when variants are phased (|). Unphased (/) data does not have haplotype order.
  if (nodeInfoByVariant.size > 1 && variantsPhased) {
    const sortedVariantIdxs = Array.from(nodeInfoByVariant.keys()).sort((a, b) => a - b);
    
    // Get the actual variant list (sorted for vertical mode, original order for horizontal)
    const variantList = isVertical ? [...win].sort((a, b) => a.pos - b.pos) : win;
    
    // Use expanded variant window for caching (includes padding to reduce cache invalidation)
    // This way, small pan movements don't invalidate the cache
    const expandedWin = expandedVariantWindow(0.3); // 30% padding on each side
    const expandedVariantList = isVertical ? [...expandedWin].sort((a, b) => a.pos - b.pos) : expandedWin;
    
    // Check if viewport has moved beyond cached range (cache invalidation)
    // Only invalidate if viewport has moved significantly (beyond padding zone)
    const currentViewportRange = { start: state.startBp, end: state.endBp };
    const span = currentViewportRange.end - currentViewportRange.start;
    const padding = span * 0.3; // Same as expandedVariantWindow padding
    
    const viewportMovedBeyondCache = cachedViewportRange && (
      currentViewportRange.start < cachedViewportRange.start - padding ||
      currentViewportRange.end > cachedViewportRange.end + padding
    );
    
    if (viewportMovedBeyondCache || cachedVisibleVariantIds === null) {
      // Clear cache when viewport moves significantly beyond cached range
      // This happens less frequently now because we cache an expanded set
      ribbonTransitionCache.clear();
      cachedVisibleVariantIds = expandedVariantList.map(v => v.id).join(',');
      cachedViewportRange = { 
        start: currentViewportRange.start - padding, 
        end: currentViewportRange.end + padding 
      };
    }
    
    // Helper to get allele label from genotype index for a variant
    function getAlleleLabelForIndex(variant, alleleIdx) {
      if (alleleIdx === null || alleleIdx === undefined || alleleIdx === "." || isNaN(alleleIdx)) {
        return formatAlleleLabel(".");
      }
      if (alleleIdx === 0) {
        // Reference allele
        return variant.refAllele ? formatAlleleLabel(variant.refAllele) : formatAlleleLabel(".");
      }
      // Alt allele (1-indexed in genotype, but 0-indexed in altAlleles array)
      if (variant.altAlleles && variant.altAlleles[alleleIdx - 1]) {
        return formatAlleleLabel(variant.altAlleles[alleleIdx - 1]);
      }
      return formatAlleleLabel(".");
    }
    
    // Helper to get actual allele string from label for a variant
    function getActualAlleleFromLabel(variant, label) {
      const noCallLabel = formatAlleleLabel(".");
      if (label === noCallLabel) return ".";
      if (variant.refAllele && label === formatAlleleLabel(variant.refAllele)) {
        return variant.refAllele;
      }
      if (variant.altAlleles && Array.isArray(variant.altAlleles)) {
        for (const alt of variant.altAlleles) {
          if (label === formatAlleleLabel(alt)) {
            return alt;
          }
        }
      }
      return ".";
    }
    
    // Helper function to compute transitions for a variant pair
    function computeTransitions(srcVariant, dstVariant) {
      const transitions = new Map();
      const srcGenotypes = srcVariant.sampleGenotypes || {};
      const dstGenotypes = dstVariant.sampleGenotypes || {};
      
      // Get all samples that have genotype data at both variants
      const allSamples = new Set([...Object.keys(srcGenotypes), ...Object.keys(dstGenotypes)]);
      
      for (const sample of allSamples) {
        const srcGt = srcGenotypes[sample] || "./.";
        const dstGt = dstGenotypes[sample] || "./.";
        
        // Parse genotypes to get allele indices
        const srcAlleles = srcGt.replace("|", "/").split("/").map(a => {
          const trimmed = a.trim();
          return trimmed === "." || trimmed === "" ? null : parseInt(trimmed, 10);
        });
        const dstAlleles = dstGt.replace("|", "/").split("/").map(a => {
          const trimmed = a.trim();
          return trimmed === "." || trimmed === "" ? null : parseInt(trimmed, 10);
        });
        
        // For each haplotype (assuming diploid = 2 haplotypes per sample)
        const numHaplotypes = Math.min(srcAlleles.length, dstAlleles.length);
        for (let h = 0; h < numHaplotypes; h++) {
          const srcAlleleIdx = srcAlleles[h];
          const dstAlleleIdx = dstAlleles[h];
          
          const srcLabel = getAlleleLabelForIndex(srcVariant, srcAlleleIdx);
          const dstLabel = getAlleleLabelForIndex(dstVariant, dstAlleleIdx);
          
          if (!transitions.has(srcLabel)) {
            transitions.set(srcLabel, new Map());
          }
          const srcTransitions = transitions.get(srcLabel);
          srcTransitions.set(dstLabel, (srcTransitions.get(dstLabel) || 0) + 1);
        }
      }
      
      return transitions;
    }
    
    for (let i = 0; i < sortedVariantIdxs.length - 1; i++) {
      const srcIdx = sortedVariantIdxs[i];
      const dstIdx = sortedVariantIdxs[i + 1];
      const srcNodes = nodeInfoByVariant.get(srcIdx);
      const dstNodes = nodeInfoByVariant.get(dstIdx);
      
      if (!srcNodes || !dstNodes) continue;
      
      // Get the variant objects from visible list (nodes only exist for visible variants)
      const srcVariant = variantList[srcIdx];
      const dstVariant = variantList[dstIdx];
      if (!srcVariant || !dstVariant) continue;
      
      // Cache key: variant pair IDs (variant objects are the same regardless of which list they come from)
      const cacheKey = `${srcVariant.id}-${dstVariant.id}`;
      
      // Get or compute transitions (cached to avoid recalculating on every pan/zoom)
      // The cache includes transitions for variants in the expanded window, so when variants
      // move slightly off-screen and back, we don't need to recalculate
      let transitions = ribbonTransitionCache.get(cacheKey);
      if (!transitions) {
        transitions = computeTransitions(srcVariant, dstVariant);
        // Store as serializable Map structure (convert nested Maps to objects for storage)
        const serialized = Array.from(transitions.entries()).map(([srcLabel, dstMap]) => [
          srcLabel,
          Array.from(dstMap.entries())
        ]);
        
        // Limit cache size: remove oldest entries if cache is too large
        if (ribbonTransitionCache.size >= MAX_CACHE_SIZE) {
          // Remove first (oldest) entry
          const firstKey = ribbonTransitionCache.keys().next().value;
          ribbonTransitionCache.delete(firstKey);
        }
        
        ribbonTransitionCache.set(cacheKey, serialized);
      } else {
        // Deserialize cached transitions back to Map structure
        transitions = new Map(transitions.map(([srcLabel, dstEntries]) => [
          srcLabel,
          new Map(dstEntries)
        ]));
      }
      
      // If no transition data (no samples), fall back to connecting all src nodes to all dst nodes
      if (transitions.size === 0) {
        for (const [srcLabel, srcNode] of srcNodes) {
          for (const [dstLabel, dstNode] of dstNodes) {
            const actualAllele = getActualAlleleFromLabel(srcVariant, srcLabel);
            const colors = getAlleleNodeColors(srcLabel, srcVariant, actualAllele, false);
            const colorMatch = colors.fillColor.match(/rgba?\([^)]+,\s*([\d.]+)\)/);
            const alpha = colorMatch ? parseFloat(colorMatch[1]) : 0.65;
            const ribbonColor = colors.fillColor.replace(/[\d.]+\)$/, `${alpha * 0.3})`);
            
            if (isVertical) {
              // Draw thin connecting ribbon (vertical flow)
              const srcW = srcNode.right - srcNode.left;
              const dstW = dstNode.right - dstNode.left;
              const midSrc = srcNode.left + srcW / 2;
              const midDst = dstNode.left + dstW / 2;
              const thinW = Math.min(2, srcW * 0.1, dstW * 0.1);
              
              drawRibbonVertical(
                srcNode, dstNode,
                midSrc - thinW/2, midSrc + thinW/2,
                midDst - thinW/2, midDst + thinW/2,
                ribbonColor
              );
            } else {
              // Draw thin connecting ribbon (horizontal flow)
              const srcH = srcNode.bottom - srcNode.top;
              const dstH = dstNode.bottom - dstNode.top;
              const midSrc = srcNode.top + srcH / 2;
              const midDst = dstNode.top + dstH / 2;
              const thinH = Math.min(2, srcH * 0.1, dstH * 0.1);
              
              drawRibbon(
                srcNode, dstNode,
                midSrc - thinH/2, midSrc + thinH/2,
                midDst - thinH/2, midDst + thinH/2,
                ribbonColor
              );
            }
          }
        }
        continue;
      }
      
      // Calculate total outgoing count per source label and total incoming per dest label
      const srcTotals = new Map(); // srcLabel -> total outgoing haplotypes
      const dstTotals = new Map(); // dstLabel -> total incoming haplotypes
      let totalHaplotypes = 0; // Total haplotypes across all transitions
      
      for (const [srcLabel, dstMap] of transitions) {
        let total = 0;
        for (const [dstLabel, count] of dstMap) {
          total += count;
          totalHaplotypes += count;
          dstTotals.set(dstLabel, (dstTotals.get(dstLabel) || 0) + count);
        }
        srcTotals.set(srcLabel, total);
      }
      
      // Track current offset within each node for stacking ribbons
      // In horizontal mode: Y offset from top; in vertical mode: X offset from left
      const srcOffsets = new Map();
      const dstOffsets = new Map();
      
      // Get reference allele labels to identify background persistence flows
      const srcRefLabel = srcVariant.refAllele ? formatAlleleLabel(srcVariant.refAllele) : null;
      const dstRefLabel = dstVariant.refAllele ? formatAlleleLabel(dstVariant.refAllele) : null;
      
      // Collect all ribbon data first, then sort so reference flows draw first (background)
      const ribbonData = [];
      
      for (const [srcLabel, dstMap] of transitions) {
        const srcNode = srcNodes.get(srcLabel);
        if (!srcNode) continue;
        
        const srcTotal = srcTotals.get(srcLabel) || 1;
        
        for (const [dstLabel, count] of dstMap) {
          const dstNode = dstNodes.get(dstLabel);
          if (!dstNode) continue;
          
          const dstTotal = dstTotals.get(dstLabel) || 1;
          
          // Get current offsets (for stacking)
          const srcOffset = srcOffsets.get(srcLabel) || 0;
          const dstOffset = dstOffsets.get(dstLabel) || 0;
          
          let src0, src1, dst0, dst1;
          
          if (isVertical) {
            // Vertical mode: ribbons flow downward, width is along X axis
            const srcNodeW = srcNode.right - srcNode.left;
            const dstNodeW = dstNode.right - dstNode.left;
            
            // Calculate ribbon slice widths proportional to transition count
            const srcSliceW = (count / srcTotal) * srcNodeW;
            const dstSliceW = (count / dstTotal) * dstNodeW;
            
            // Calculate X positions
            src0 = srcNode.left + srcOffset;
            src1 = src0 + srcSliceW;
            dst0 = dstNode.left + dstOffset;
            dst1 = dst0 + dstSliceW;
            
            // Update offsets for next ribbon
            srcOffsets.set(srcLabel, srcOffset + srcSliceW);
            dstOffsets.set(dstLabel, dstOffset + dstSliceW);
          } else {
            // Horizontal mode: ribbons flow rightward, height is along Y axis
            const srcNodeH = srcNode.bottom - srcNode.top;
            const dstNodeH = dstNode.bottom - dstNode.top;
            
            // Calculate ribbon slice heights proportional to transition count
            const srcSliceH = (count / srcTotal) * srcNodeH;
            const dstSliceH = (count / dstTotal) * dstNodeH;
            
            // Calculate Y positions
            src0 = srcNode.top + srcOffset;
            src1 = src0 + srcSliceH;
            dst0 = dstNode.top + dstOffset;
            dst1 = dst0 + dstSliceH;
            
            // Update offsets for next ribbon
            srcOffsets.set(srcLabel, srcOffset + srcSliceH);
            dstOffsets.set(dstLabel, dstOffset + dstSliceH);
          }
          
          // Check if this is a reference-to-reference flow (background persistence)
          const isRefFlow = srcLabel === srcRefLabel && dstLabel === dstRefLabel;
          
          ribbonData.push({
            srcNode, dstNode, src0, src1, dst0, dst1,
            srcLabel, count, isRefFlow
          });
        }
      }
      
      // Sort ribbons: reference flows first (drawn in background), then colored flows on top
      ribbonData.sort((a, b) => (b.isRefFlow ? 1 : 0) - (a.isRefFlow ? 1 : 0));
      
      // Draw all ribbons with sqrt-scaled opacity
      // Add viewport clipping: skip ribbons where both nodes are completely off-screen
      const viewportLeft = 0;
      const viewportRight = W;
      const viewportTop = 0;
      const viewportBottom = H;
      
      for (const ribbon of ribbonData) {
        const { srcNode, dstNode, src0, src1, dst0, dst1, srcLabel, count, isRefFlow } = ribbon;
        
        // Viewport clipping: skip if both nodes are completely off-screen
        // This avoids rendering ribbons that are outside the visible area
        if (isVertical) {
          // Vertical mode: check X coordinates (horizontal position)
          const srcRight = Math.max(srcNode.left, srcNode.right);
          const srcLeft = Math.min(srcNode.left, srcNode.right);
          const dstRight = Math.max(dstNode.left, dstNode.right);
          const dstLeft = Math.min(dstNode.left, dstNode.right);
          
          // Skip if both nodes are completely outside viewport
          if ((srcRight < viewportLeft && dstRight < viewportLeft) ||
              (srcLeft > viewportRight && dstLeft > viewportRight)) {
            continue;
          }
        } else {
          // Horizontal mode: check Y coordinates (vertical position)
          const srcBottom = Math.max(srcNode.top, srcNode.bottom);
          const srcTop = Math.min(srcNode.top, srcNode.bottom);
          const dstBottom = Math.max(dstNode.top, dstNode.bottom);
          const dstTop = Math.min(dstNode.top, dstNode.bottom);
          
          // Skip if both nodes are completely outside viewport
          if ((srcBottom < viewportTop && dstBottom < viewportTop) ||
              (srcTop > viewportBottom && dstTop > viewportBottom)) {
            continue;
          }
        }
        
        // Get color from source allele
        const actualAllele = getActualAlleleFromLabel(srcVariant, srcLabel);
        const colors = getAlleleNodeColors(srcLabel, srcVariant, actualAllele, false);
        
        // Check if source or destination node is selected
        const isEdgeSelected = srcNode.isSelected || dstNode.isSelected;
        
        // Sqrt-scaled opacity: prevents dominant flows from drowning minor ones
        const frac = count / Math.max(1, totalHaplotypes);
        let alpha = 0.05 + 0.25 * Math.sqrt(frac);
        
        // De-emphasize reference flows further (lower saturation via reduced alpha)
        if (isRefFlow) {
          alpha *= 0.6; // 40% reduction for background persistence flows
        }
        
        // Boost opacity for edges connected to selected alleles
        if (isEdgeSelected) {
          alpha = Math.min(1.0, alpha * 3.0); // Triple the opacity for selected edges
        }
        
        let ribbonColor;
        if (isEdgeSelected) {
          // Use gold highlight color for selected edges
          ribbonColor = `rgba(255, 215, 0, ${alpha.toFixed(3)})`;
        } else {
          ribbonColor = colors.fillColor.replace(/[\d.]+\)$/, `${alpha.toFixed(3)})`);
        }
        
        if (isVertical) {
          // Vertical mode: src0/src1/dst0/dst1 are X positions
          drawRibbonVertical(srcNode, dstNode, src0, src1, dst0, dst1, ribbonColor);
        } else {
          // Horizontal mode: src0/src1/dst0/dst1 are Y positions
          drawRibbon(srcNode, dstNode, src0, src1, dst0, dst1, ribbonColor);
        }
      }
    }
  }
  
  // Accumulate node positions across all flow bands.
  allBandNodePositions.push(...nodePositions);
  
  // Draw all labels at the very end with tooltip-style rounded rectangles (to bring them to foreground)
  ctx.font = "11px ui-monospace, 'SF Mono', Monaco, 'Consolas', 'Courier New', monospace";
  const labelPadding = 6;
  const labelBorderRadius = 4;
  const labelBgColor = "rgba(0, 0, 0, 0.85)";
  const labelBorderColor = "rgba(255, 255, 255, 0.2)";
  const labelTextColor = "rgba(255, 255, 255, 0.95)";
  
  for (const labelInfo of allLabelsToDraw) {
    const text = labelInfo.text || labelInfo.label;
    const textMetrics = ctx.measureText(text);
    const textWidth = textMetrics.width;
    const textHeight = 11; // font size
    
    if (labelInfo.isVertical) {
      // Vertical mode: rotated text
      const labelX = labelInfo.nodeX + labelInfo.nodeW/2 - gap - 5 + 12;
      const labelY = labelInfo.nodeY - 12;
      
      // Calculate dimensions for rotated tooltip
      const tooltipW = textHeight + labelPadding * 2;
      const tooltipH = textWidth + labelPadding * 2;
      const tooltipX = labelX - tooltipH / 2;
      const tooltipY = labelY - tooltipW / 2;
      
      ctx.save();
      ctx.translate(labelX, labelY);
      ctx.rotate(-Math.PI/2);
      
      // Draw tooltip background
      ctx.fillStyle = labelBgColor;
      ctx.strokeStyle = labelBorderColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      roundRect(ctx, -tooltipH/2, -tooltipW/2, tooltipH, tooltipW, labelBorderRadius);
      ctx.fill();
      ctx.stroke();
      
      // Draw text
      ctx.fillStyle = labelTextColor;
      ctx.fillText(text, -textWidth/2, textHeight/2 + 2);
      
      ctx.restore();
    } else {
      // Horizontal mode: normal text
      const labelX = labelInfo.nodeX + 12;
      const labelY = labelInfo.nodeY + 13;
      
      // Calculate dimensions for tooltip
      const tooltipW = textWidth + labelPadding * 2;
      const tooltipH = textHeight + labelPadding * 2;
      const tooltipX = labelX - labelPadding;
      const tooltipY = labelY - textHeight - labelPadding;
      
      // Draw tooltip background
      ctx.fillStyle = labelBgColor;
      ctx.strokeStyle = labelBorderColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      roundRect(ctx, tooltipX, tooltipY, tooltipW, tooltipH, labelBorderRadius);
      ctx.fill();
      ctx.stroke();
      
      // Draw text
      ctx.fillStyle = labelTextColor;
      ctx.fillText(text, labelX, labelY);
    }
    }

    if (!multiTrack) ctx.restore();
    })();
  }

  // Store node positions globally for hit testing (across all tracks/bands).
  window._alleleNodePositions = allBandNodePositions;

  // Execute WebGPU render pass after variant columns are added
  // Render to flowWebGPU canvas (separate from tracksWebGPU)
  const hasFlowInstances = flowInstancedRenderer && 
      (flowInstancedRenderer.rectInstances.length > 0 || flowInstancedRenderer.lineInstances.length > 0);
  const hasRibbonInstances = flowRibbonRenderer && flowRibbonRenderer.instances.length > 0;
  if (webgpuSupported && flowInstancedRenderer && (hasFlowInstances || hasRibbonInstances)) {
    try {
      // Update projection matrix for current canvas size
      const devicePixelRatio = window.devicePixelRatio || 1;
      const width = flowWebGPU.clientWidth * devicePixelRatio;
      const height = flowWebGPU.clientHeight * devicePixelRatio;
      
      if (flowWebGPU.width !== width || flowWebGPU.height !== height) {
        flowWebGPU.width = width;
        flowWebGPU.height = height;
        flowWebGPUCore.handleResize();
      }
      
      const encoder = flowWebGPUCore.createCommandEncoder();
      const texture = flowWebGPUCore.getCurrentTexture();
      const renderPass = encoder.beginRenderPass({
        colorAttachments: [{
          view: texture.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear', // Clear canvas on each render
          storeOp: 'store',
        }],
      });
      
      if (flowRibbonRenderer) flowRibbonRenderer.render(encoder, renderPass);
      flowInstancedRenderer.render(encoder, renderPass);
      renderPass.end();
      flowWebGPUCore.submit([encoder.finish()]);

      // Ensure alleuvial diagram appears on first paint: schedule one deferred redraw
      // when we have ribbons so the next frame runs again (handles zero-sized canvas on
      // first run or WebGPU presenting after first frame). Only once per page load.
      if (hasRibbonInstances && flowWebGPU && !window._flowRibbonDeferDone) {
        window._flowRibbonDeferDone = true;
        requestAnimationFrame(() => {
          if (typeof renderFlowCanvas === 'function') renderFlowCanvas();
        });
      }
    } catch (error) {
      console.error("Flow WebGPU render error:", error);
      // Fallback: clear instances and continue with Canvas 2D only
      flowInstancedRenderer.clear();
    }
  } else if (webgpuSupported && flowInstancedRenderer) {
    // Clear WebGPU canvas if no instances to render
    try {
      const encoder = flowWebGPUCore.createCommandEncoder();
      const texture = flowWebGPUCore.getCurrentTexture();
      const renderPass = encoder.beginRenderPass({
        colorAttachments: [{
          view: texture.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        }],
      });
      renderPass.end();
      flowWebGPUCore.submit([encoder.finish()]);
    } catch (error) {
      // Ignore errors when clearing
    }
  }
}
