// Tracks rendering (ideogram + genes + repeats + ruler)
// -----------------------------
// Track retry attempts to avoid infinite loops
let renderTracksRetryCount = 0;
const MAX_RETRY_ATTEMPTS = 10;

function renderTracks() {
  clearSvg(tracksSvg);
  // Clear variant element references
  state.locusVariantElements.clear();
  // Clear WebGPU renderer instances
  if (instancedRenderer) {
    instancedRenderer.clear();
  }
  repeatHitTestData = [];
  
  const isVertical = isVerticalMode();
  const W = isVertical ? tracksHeightPx() : tracksWidthPx();
  const H = isVertical ? tracksWidthPx() : tracksHeightPx();
  
  // Guard against invalid dimensions - retry if dimensions are not ready
  if (!W || W <= 0 || isNaN(W) || !H || H <= 0 || isNaN(H)) {
    if (renderTracksRetryCount < MAX_RETRY_ATTEMPTS) {
      renderTracksRetryCount++;
      // Try to update tracks height before retrying (might fix the dimension issue)
      updateTracksHeight();
      // Schedule a retry after a short delay to allow layout to settle
      setTimeout(() => {
        renderTracks();
      }, 50);
      return;
    } else {
      renderTracksRetryCount = 0; // Reset counter
      return;
    }
  }
  
  // Reset retry counter on successful render
  renderTracksRetryCount = 0;
  
  // Ensure pxPerBp is valid before rendering
  if (!state.pxPerBp || state.pxPerBp <= 0 || isNaN(state.pxPerBp)) {
    // Try to update derived values
    updateDerived();
    // Check again
    if (!state.pxPerBp || state.pxPerBp <= 0 || isNaN(state.pxPerBp)) {
      return;
    }
  }
  
  const layout = getTrackLayout();
  
  // Coordinate mapping functions based on orientation
  const genomePos = isVertical ? yGenome.bind(null) : xGenome.bind(null);
  // In vertical mode, use tracksHeightPx() for Y coordinate (genomic axis is vertical)
  // In horizontal mode, use W (tracksWidthPx()) for X coordinate (genomic axis is horizontal)
  const genomePosCanonical = isVertical 
    ? (bp) => yGenomeCanonical(bp, tracksHeightPx())
    : (bp) => xGenomeCanonical(bp, W);
  
  // Find track positions (needed to exclude ideogram from shading)
  const ideogramLayout = layout.find(l => l.track.id === "ideogram");
  const genesLayout = layout.find(l => l.track.id === "genes");
  const repeatsLayout = layout.find(l => l.track.id === "repeats");
  const rulerLayout = layout.find(l => l.track.id === "ruler");
  const referenceLayout = layout.find(l => l.track.id === "reference");
  const flowLayout = layout.find(l => l.track.id === "flow") || layout.find(l => l.track.id && l.track.id.startsWith("flow-"));
  
  // Calculate ideogram track bounds to exclude from shading (including track controls header)
  let ideogramTrackStart = 0;
  let ideogramTrackEnd = 0;
  if (ideogramLayout && !ideogramLayout.track.collapsed) {
    if (isVertical) {
      // In vertical mode, ideogram is on the left side (x-axis)
      // Use left/width to include the track controls header area
      ideogramTrackStart = ideogramLayout.left;
      ideogramTrackEnd = ideogramLayout.left + ideogramLayout.width;
    } else {
      // In horizontal mode, ideogram is at the top (y-axis)
      // Use top/height to include the track controls header area
      ideogramTrackStart = ideogramLayout.top;
      ideogramTrackEnd = ideogramLayout.top + ideogramLayout.height;
    }
  }
  
  // Draw data bounds overlays across all tracks except ideogram (if data bounds
  // exist and differ from view). Skip entirely when viewport variant loading is
  // on — data pages in across the whole contig, so the "out of data" grey is
  // misleading (and would otherwise linger over freshly-paged-in variants).
  const _vpOn = !!(window.GENOMESHADER_CONFIG && window.GENOMESHADER_CONFIG.viewport_variant_loading);
  if (!_vpOn && dataBounds && (dataBounds.start > state.startBp || dataBounds.end < state.endBp)) {
    const dataStartPos = genomePos(dataBounds.start);
    const dataEndPos = genomePos(dataBounds.end);
    
    // Find the tracks container bounds
    const tracksContainer = document.getElementById("tracksContainer");
    if (tracksContainer) {
      const containerRect = tracksContainer.getBoundingClientRect();
      const svgRect = tracksSvg.getBoundingClientRect();
      
      // Helper function to draw out-of-bounds shading (darker)
      const drawOutOfBoundsRect = (x, y, width, height) => {
        tracksSvg.appendChild(el("rect", {
          x: x,
          y: y,
          width: width,
          height: height,
          fill: "rgba(127,127,127,0.15)", // Darker for out-of-bounds
          "pointer-events": "none",
          "class": "data-bounds-overlay"
        }));
      };
      
      if (isVertical) {
        // In vertical mode, Y axis is inverted: bottom (higher Y) = smaller bp, top (lower Y) = larger bp
        // dataStartPos = Y position of dataBounds.start (smaller bp → higher Y, near bottom)
        // dataEndPos = Y position of dataBounds.end (larger bp → lower Y, near top)
        
        // Out-of-bounds region below data (smaller bp than dataBounds.start)
        // dataBounds.start > state.startBp means view extends to show bp < dataBounds.start
        // In vertical mode: smaller bp → higher Y → bottom of screen
        // So out-of-bounds is from dataStartPos to H (bottom)
        if (dataBounds.start > state.startBp) {
          const overlayY1 = Math.max(dataStartPos, 0);
          const overlayY2 = H;
          if (overlayY2 > overlayY1) {
            if (ideogramTrackEnd > 0) {
              // Left side of ideogram track
              if (ideogramTrackStart > 0) {
                drawOutOfBoundsRect(0, overlayY1, ideogramTrackStart, overlayY2 - overlayY1);
              }
              // Right side of ideogram track
              if (ideogramTrackEnd < W) {
                drawOutOfBoundsRect(ideogramTrackEnd, overlayY1, W - ideogramTrackEnd, overlayY2 - overlayY1);
              }
            } else {
              // No ideogram track, draw full width
              drawOutOfBoundsRect(0, overlayY1, W, overlayY2 - overlayY1);
            }
          }
        }
        
        // Out-of-bounds region above data (larger bp than dataBounds.end)
        // dataBounds.end < state.endBp means view extends to show bp > dataBounds.end
        // In vertical mode: larger bp → lower Y → top of screen
        // So out-of-bounds is from 0 to dataEndPos (top)
        if (dataBounds.end < state.endBp) {
          const overlayY1 = 0;
          const overlayY2 = Math.min(dataEndPos, H);
          if (overlayY2 > overlayY1) {
            if (ideogramTrackEnd > 0) {
              // Left side of ideogram track
              if (ideogramTrackStart > 0) {
                drawOutOfBoundsRect(0, overlayY1, ideogramTrackStart, overlayY2 - overlayY1);
              }
              // Right side of ideogram track
              if (ideogramTrackEnd < W) {
                drawOutOfBoundsRect(ideogramTrackEnd, overlayY1, W - ideogramTrackEnd, overlayY2 - overlayY1);
              }
            } else {
              // No ideogram track, draw full width
              drawOutOfBoundsRect(0, overlayY1, W, overlayY2 - overlayY1);
            }
          }
        }
      } else {
        // Horizontal mode - exclude ideogram track area
        // Region before data start (out-of-bounds, darker)
        if (dataBounds.start > state.startBp) {
          const overlayX1 = 0;
          const overlayX2 = dataStartPos;
          if (ideogramTrackEnd > 0) {
            // Top side of ideogram track
            if (ideogramTrackStart > 0) {
              drawOutOfBoundsRect(overlayX1, 0, overlayX2 - overlayX1, ideogramTrackStart);
            }
            // Bottom side of ideogram track
            if (ideogramTrackEnd < H) {
              drawOutOfBoundsRect(overlayX1, ideogramTrackEnd, overlayX2 - overlayX1, H - ideogramTrackEnd);
            }
          } else {
            // No ideogram track, draw full height
            drawOutOfBoundsRect(overlayX1, 0, overlayX2 - overlayX1, H);
          }
        }
        
        // Region after data end (out-of-bounds, darker)
        if (dataBounds.end < state.endBp) {
          const overlayX1 = dataEndPos;
          const overlayX2 = W;
          if (ideogramTrackEnd > 0) {
            // Top side of ideogram track
            if (ideogramTrackStart > 0) {
              drawOutOfBoundsRect(overlayX1, 0, overlayX2 - overlayX1, ideogramTrackStart);
            }
            // Bottom side of ideogram track
            if (ideogramTrackEnd < H) {
              drawOutOfBoundsRect(overlayX1, ideogramTrackEnd, overlayX2 - overlayX1, H - ideogramTrackEnd);
            }
          } else {
            // No ideogram track, draw full height
            drawOutOfBoundsRect(overlayX1, 0, overlayX2 - overlayX1, H);
          }
        }
      }
    }
  }

  // repeats is optional (dropped when no repeats_data) — don't require it here.
  if (!ideogramLayout || !genesLayout || !referenceLayout || !flowLayout) return;

  // Ideogram layout
  if (!ideogramLayout.track.collapsed) {
    // Validate layout properties before using them
    const contentLeft = ideogramLayout.contentLeft;
    const contentTop = ideogramLayout.contentTop;
    if (isNaN(contentLeft) || isNaN(contentTop)) {
      console.warn('Genomeshader: Invalid ideogram layout values', { contentLeft, contentTop });
      return;
    }
    
    let ideogramX, ideogramY, ideogramW, ideogramH;
    if (isVertical) {
      ideogramX = (isNaN(contentLeft) ? 0 : contentLeft) + 12;
      ideogramW = 16;
      // Leave space at bottom for chromosome label, start ideogram higher
      ideogramY = 16;
      // In vertical mode, ideogram spans the genomic axis (W dimension, which is SVG height)
      // Leave space at bottom (about 40px) for the chromosome label
      ideogramH = Math.max(0, W - 32 - 40);
    } else {
      ideogramY = (isNaN(contentTop) ? 0 : contentTop) + 12;
      ideogramH = 16;
      ideogramX = 16;
      ideogramW = Math.max(0, W - 32);
    }
    
    // Final validation of calculated values
    if (isNaN(ideogramX) || isNaN(ideogramY) || isNaN(ideogramW) || isNaN(ideogramH) || 
        ideogramW <= 0 || ideogramH <= 0) {
      console.warn('Genomeshader: Invalid ideogram dimensions', { ideogramX, ideogramY, ideogramW, ideogramH });
      return;
    }

    // Left gutter reserved for the contig name so the chromosome band starts
    // after it (no overlap). Sized to the name length; the name is right-aligned
    // against the band with a gap.
    const contigName = String(state.contig || '');
    const nameGutter = Math.max(70, 16 + Math.ceil(contigName.length * 8) + 14);

    // --- Chromosome label
    if (isVertical) {
      // Position chromosome label at the bottom
      const labelY = W - 16;
      tracksSvg.appendChild(el("text", {
        x: ideogramX + ideogramW/2 + 1,
        y: labelY,
        class: "svg-chr",
        "text-anchor": "middle",
        "dominant-baseline": "middle"
      }, state.contig));
    } else {
      // Right-align the contig name in the gutter, ending 12px before the band.
      tracksSvg.appendChild(el("text", {
        x: nameGutter - 12,
        y: ideogramY + ideogramH/2 + 1,
        class: "svg-chr",
        "text-anchor": "end",
        "dominant-baseline": "middle"
      }, state.contig));
    }

    // --- Ideogram (p/q arm rounded rects + cytobands clipped inside)
    const bandX = isVertical ? ideogramX : nameGutter;
    const bandY = isVertical ? ideogramY : ideogramY;
    const bandW = isVertical ? ideogramW : Math.max(0, W - bandX - 16);
    // In vertical mode, bandH should use the full available height
    const bandH = isVertical ? ideogramH : ideogramH;
    
    // Validate band dimensions before using them
    if (isNaN(bandX) || isNaN(bandY) || isNaN(bandW) || isNaN(bandH) || 
        bandW <= 0 || bandH <= 0) {
      console.warn('Genomeshader: Invalid band dimensions', { bandX, bandY, bandW, bandH, ideogramX, ideogramY, ideogramW, ideogramH, W, H });
      return;
    }

    // Use global chromosome lengths for mapping cytoband positions
    const chrLength = getChromosomeLength();
    
    // Get ideogram data from config (already parsed from JSON in Python)
    let ideogramData = [];
    if (window.GENOMESHADER_CONFIG && window.GENOMESHADER_CONFIG.ideogram_data) {
      const data = window.GENOMESHADER_CONFIG.ideogram_data;
      // Data should already be an array, but ensure it is
      if (Array.isArray(data)) {
        ideogramData = data;
      } else {
        console.warn("Ideogram data is not in expected array format:", data);
      }
    }
    
    // Find centromere position to determine p/q arm split
    // The first acen entry indicates the end of the p-arm
    // The second acen entry indicates the start of the q-arm
    let firstAcenEnd = null;
    for (const band of ideogramData) {
      if (band.gieStain === "acen") {
        if (firstAcenEnd === null) {
          // First acen band: its end marks where p-arm ends
          firstAcenEnd = band.chromEnd;
        }
        // Second acen band marks where q-arm starts (we don't need to track this separately)
      }
    }
    
    // Calculate actual p/q arm proportions based on centromere position
    // The split between p and q arms is at the end of the first acen band
    // If no centromere found, use approximate position (p-arm is typically ~48% of chromosome)
    const defaultPFrac = 0.48;
    const centromerePos = firstAcenEnd !== null ? firstAcenEnd : Math.floor(chrLength * defaultPFrac);
    const pFrac = centromerePos / chrLength;
    const qFrac = 1 - pFrac;

    let pX, pY, pW, pH, qX, qY, qW, qH;
    if (isVertical) {
      // In vertical mode, arms are vertical (p-arm bottom, q-arm top)
      pH = Math.max(10, Math.floor(bandH * pFrac));
      qH = Math.max(10, Math.floor(bandH * qFrac));
      pW = qW = bandW;
      pX = qX = bandX;
      pY = bandY + bandH - pH; // p-arm at bottom
      qY = bandY; // q-arm at top
    } else {
      // Horizontal mode: arms are horizontal
      pW = Math.max(10, Math.floor(bandW * pFrac));
      qW = Math.max(10, Math.floor(bandW * qFrac));
      pH = qH = bandH;
      pX = bandX;
      qX = bandX + pW;
      pY = qY = bandY;
    }
    
    // Validate all calculated arm positions and dimensions
    if (isNaN(pX) || isNaN(pY) || isNaN(pW) || isNaN(pH) ||
        isNaN(qX) || isNaN(qY) || isNaN(qW) || isNaN(qH) ||
        pW <= 0 || pH <= 0 || qW <= 0 || qH <= 0) {
      console.warn('Genomeshader: Invalid arm dimensions', { pX, pY, pW, pH, qX, qY, qW, qH });
      return;
    }

    // defs + clipPath that matches both arms
    const defs = el("defs");
    const clipId = "chrClip";
    const clip = el("clipPath", { id: clipId });

    const armStroke = "rgba(127,127,127,0.22)";
    const armFill = "rgba(127,127,127,0.12)";

    const pArm = el("rect", { x: pX, y: pY, width: pW, height: pH, rx: 9, fill: armFill, stroke: armStroke });
    const qArm = el("rect", { x: qX, y: qY, width: qW, height: qH, rx: 9, fill: armFill, stroke: armStroke });

    clip.appendChild(el("rect", { x: pX, y: pY, width: pW, height: pH, rx: 9 }));
    clip.appendChild(el("rect", { x: qX, y: qY, width: qW, height: qH, rx: 9 }));

    defs.appendChild(clip);
    tracksSvg.appendChild(defs);

    tracksSvg.appendChild(pArm);
    tracksSvg.appendChild(qArm);
    
    // Calculate p-arm and q-arm lengths in base pairs
    const pArmLength = centromerePos;
    const qArmLength = chrLength - centromerePos;
    
    const bandInnerX = isVertical ? bandX - 2 : bandX;
    const bandInnerY = isVertical ? bandY : bandY - 2;
    const bandInnerW = isVertical ? bandW + 4 : bandW;
    const bandInnerH = isVertical ? bandH : bandH + 4;
    
    // Render each cytoband
    for (const band of ideogramData) {
      const bandStart = band.chromStart;
      const bandEnd = band.chromEnd;
      const isCentromere = band.gieStain === "acen";
      const isPArm = bandEnd <= centromerePos;
      
      // Determine which arm and calculate position
      let bandPos, bandSize;
      if (isPArm) {
        // p-arm: map from 0 to pArmLength onto p-arm dimensions
        const pFracStart = bandStart / pArmLength;
        const pFracEnd = bandEnd / pArmLength;
        const pFracSize = (bandEnd - bandStart) / pArmLength;
        
        if (isVertical) {
          // p-arm is at bottom, so we go from bottom up
          bandPos = pY + pH - (pFracEnd * pH);
          bandSize = pFracSize * pH;
        } else {
          // p-arm is on left
          bandPos = pX + (pFracStart * pW);
          bandSize = pFracSize * pW;
        }
      } else {
        // q-arm: map from centromerePos to chrLength onto q-arm dimensions
        const qFracStart = (bandStart - centromerePos) / qArmLength;
        const qFracEnd = (bandEnd - centromerePos) / qArmLength;
        const qFracSize = (bandEnd - bandStart) / qArmLength;
        
        if (isVertical) {
          // q-arm is at top
          bandPos = qY + (qFracStart * qH);
          bandSize = qFracSize * qH;
        } else {
          // q-arm is on right
          bandPos = qX + (qFracStart * qW);
          bandSize = qFracSize * qW;
        }
      }
      
      // Convert color from hex to rgba for better visibility
      const color = band.color || "#808080";
      let fillColor, strokeColor, strokeWidth;
      if (isCentromere) {
        fillColor = "rgba(255,77,77,0.35)";
        strokeColor = "none";
        strokeWidth = 0;
      } else {
        // Convert hex to rgba with opacity
        const r = parseInt(color.slice(1, 3), 16);
        const g = parseInt(color.slice(3, 5), 16);
        const b = parseInt(color.slice(5, 7), 16);
        // Adjust opacity based on color intensity (darker = more opaque)
        const intensity = (r + g + b) / 3;
        const opacity = 0.1 + (1 - intensity / 255) * 0.3;
        fillColor = `rgba(${r},${g},${b},${opacity})`;
        strokeColor = "none";
        strokeWidth = 0;
      }
      
      if (isVertical) {
        tracksSvg.appendChild(el("rect", {
          x: bandInnerX,
          y: bandPos,
          width: bandInnerW,
          height: Math.max(1, bandSize),
          fill: fillColor,
          stroke: strokeColor,
          "stroke-width": strokeWidth,
          "clip-path": `url(#${clipId})`
        }));
      } else {
        tracksSvg.appendChild(el("rect", {
          x: bandPos,
          y: bandInnerY,
          width: Math.max(1, bandSize),
          height: bandInnerH,
          fill: fillColor,
          stroke: strokeColor,
          "stroke-width": strokeWidth,
          "clip-path": `url(#${clipId})`
        }));
      }
    }

    // Locus highlight - small red rectangle showing current view position
    const locusCenter = (state.startBp + state.endBp) / 2;
    const locusFrac = locusCenter / chrLength;
    
    // Determine if locus is on p-arm or q-arm
    const isLocusPArm = locusCenter <= centromerePos;
    
    if (isVertical) {
      let locusY, locusHighlightHeight = 12;
      if (isLocusPArm) {
        // p-arm is at bottom
        const pFrac = locusCenter / pArmLength;
        locusY = pY + pH - (pFrac * pH);
      } else {
        // q-arm is at top
        const qFrac = (locusCenter - centromerePos) / qArmLength;
        locusY = qY + (qFrac * qH);
      }
      const locusHighlightY = Math.max(
        isLocusPArm ? pY : qY,
        Math.min(
          (isLocusPArm ? pY + pH : qY + qH) - locusHighlightHeight,
          locusY - locusHighlightHeight / 2
        )
      );
      
      tracksSvg.appendChild(el("rect", {
        x: (isLocusPArm ? pX : qX) - 1,
        y: locusHighlightY,
        width: (isLocusPArm ? pW : qW) + 2,
        height: locusHighlightHeight,
        fill: "rgba(255,77,77,0.25)",
        stroke: "rgba(255,77,77,0.95)",
        "stroke-width": 1
      }));
    } else {
      let locusX, locusHighlightWidth = 12;
      if (isLocusPArm) {
        // p-arm is on left
        const pFrac = locusCenter / pArmLength;
        locusX = pX + (pFrac * pW);
      } else {
        // q-arm is on right
        const qFrac = (locusCenter - centromerePos) / qArmLength;
        locusX = qX + (qFrac * qW);
      }
      const locusHighlightX = Math.max(
        isLocusPArm ? pX : qX,
        Math.min(
          (isLocusPArm ? pX + pW : qX + qW) - locusHighlightWidth,
          locusX - locusHighlightWidth / 2
        )
      );
      
      tracksSvg.appendChild(el("rect", {
        x: locusHighlightX,
        y: (isLocusPArm ? pY : qY) - 1,
        width: locusHighlightWidth,
        height: (isLocusPArm ? pH : qH) + 2,
        fill: "rgba(255,77,77,0.25)",
        stroke: "rgba(255,77,77,0.95)",
        "stroke-width": 1
      }));
    }
  }

  // --- Genes track (exons/introns/strand)
  if (!genesLayout.track.collapsed) {
    let geneStartX, geneStartY, laneDim, lanes, genesDim;
    if (isVertical) {
      geneStartX = genesLayout.contentLeft + 8;
      laneDim = 30;
      lanes = 3;
      genesDim = lanes * laneDim;
      geneStartY = 16;
    } else {
      geneStartY = genesLayout.contentTop + 8;
      laneDim = 30;
      lanes = 3;
      genesDim = lanes * laneDim;
      geneStartX = 16;
    }

    // Use WebGPU for lane separator lines if available
    const devicePixelRatio = window.devicePixelRatio || 1;
    const useWebGPU = webgpuSupported && instancedRenderer;
    
    for (let lane=0; lane<lanes; lane++) {
      if (isVertical) {
        const x = geneStartX + lane*laneDim + laneDim/2;
        if (useWebGPU) {
          instancedRenderer.addLine(
            x * devicePixelRatio, 16 * devicePixelRatio,
            x * devicePixelRatio, (H-16) * devicePixelRatio,
            0x7F7F7F, 0.14
          );
        } else {
          tracksSvg.appendChild(el("line", {
            x1: x, x2: x, y1: 16, y2: H-16,
            stroke: "rgba(127,127,127,0.14)"
          }));
        }
      } else {
        const y = geneStartY + lane*laneDim + laneDim/2;
        if (useWebGPU) {
          instancedRenderer.addLine(
            16 * devicePixelRatio, y * devicePixelRatio,
            (W-16) * devicePixelRatio, y * devicePixelRatio,
            0x7F7F7F, 0.14
          );
        } else {
          tracksSvg.appendChild(el("line", {
            x1: 16, x2: W-16, y1: y, y2: y,
            stroke: "rgba(127,127,127,0.14)"
          }));
        }
      }
    }

    function drawStrandArrows(pos1, pos2, perpPos, strand, isVert) {
      const dir = strand === "-" ? -1 : 1;
      const step = 24;
      const start = Math.min(pos1, pos2), end = Math.max(pos1, pos2);
      const devicePixelRatio = window.devicePixelRatio || 1;
      const useWebGPU = webgpuSupported && instancedRenderer;
      
      for (let p = start + 10; p < end - 10; p += step) {
        const size = 5;
        if (isVert) {
          const cy = p;
          if (useWebGPU) {
            // Triangle: tip at (perpPos, cy), base at (perpPos ± size*0.8, cy + dir*size)
            instancedRenderer.addTriangle(
              perpPos * devicePixelRatio, cy * devicePixelRatio,
              (perpPos - dir*size*0.8) * devicePixelRatio, (cy + dir*size) * devicePixelRatio,
              (perpPos + dir*size*0.8) * devicePixelRatio, (cy + dir*size) * devicePixelRatio,
              0x78B4FF, 0.50
            );
          } else {
            const p1 = `${perpPos},${cy}`;
            const p2 = `${perpPos - dir*size*0.8},${cy + dir*size}`;
            const p3 = `${perpPos + dir*size*0.8},${cy + dir*size}`;
            tracksSvg.appendChild(el("polygon", {
              points: `${p1} ${p2} ${p3}`,
              fill: "rgba(120,180,255,0.50)"
            }));
          }
        } else {
          const cx = p;
          if (useWebGPU) {
            // Triangle: tip at (cx, perpPos), base at (cx - dir*size, perpPos ± size*0.8)
            instancedRenderer.addTriangle(
              cx * devicePixelRatio, perpPos * devicePixelRatio,
              (cx - dir*size) * devicePixelRatio, (perpPos - size*0.8) * devicePixelRatio,
              (cx - dir*size) * devicePixelRatio, (perpPos + size*0.8) * devicePixelRatio,
              0x78B4FF, 0.50
            );
          } else {
            const p1 = `${cx},${perpPos}`;
            const p2 = `${cx - dir*size},${perpPos - size*0.8}`;
            const p3 = `${cx - dir*size},${perpPos + size*0.8}`;
            tracksSvg.appendChild(el("polygon", {
              points: `${p1} ${p2} ${p3}`,
              fill: "rgba(120,180,255,0.50)"
            }));
          }
        }
      }
    }

  // Iterate over gene models (transcripts variable now contains gene models)
  for (const gene of transcripts) {
    const s = Math.max(gene.start, state.startBp);
    const e = Math.min(gene.end,   state.endBp);
    if (e <= state.startBp || s >= state.endBp) continue;

    let perpPos;
    if (isVertical) {
      perpPos = geneStartX + gene.lane*laneDim + laneDim/2;
    } else {
      perpPos = geneStartY + gene.lane*laneDim + laneDim/2;
    }

    // intron baseline (full gene span)
    const pos1 = genomePos(s);
    const pos2 = genomePos(e);
    
    const devicePixelRatio = window.devicePixelRatio || 1;
    const useWebGPU = webgpuSupported && instancedRenderer;
    
    if (isVertical) {
      if (useWebGPU) {
        instancedRenderer.addLine(
          perpPos * devicePixelRatio, pos1 * devicePixelRatio,
          perpPos * devicePixelRatio, pos2 * devicePixelRatio,
          0x78B4FF, 0.45
        );
      } else {
        tracksSvg.appendChild(el("line", {
          x1: perpPos, x2: perpPos, y1: pos1, y2: pos2,
          stroke: "rgba(120,180,255,0.45)",
          "stroke-width": 1
        }));
      }
      drawStrandArrows(pos1, pos2, perpPos, gene.strand, true);
    } else {
      if (useWebGPU) {
        instancedRenderer.addLine(
          pos1 * devicePixelRatio, perpPos * devicePixelRatio,
          pos2 * devicePixelRatio, perpPos * devicePixelRatio,
          0x78B4FF, 0.45
        );
      } else {
        tracksSvg.appendChild(el("line", {
          x1: pos1, x2: pos2, y1: perpPos, y2: perpPos,
          stroke: "rgba(120,180,255,0.45)",
          "stroke-width": 1
        }));
      }
      drawStrandArrows(pos1, pos2, perpPos, gene.strand, false);
    }

    // exons - now with union model and universal/partial distinction
    let firstExonY = null; // Track bottom-most exon Y position for gene name alignment in vertical mode
    let firstExonX = null; // Track first exon X position for gene name alignment in horizontal mode
    for (const exon of gene.exons) {
      // Exon format: [start, end, is_universal]
      const es0 = exon[0];
      const ee0 = exon[1];
      const isUniversal = exon[2] === true || exon[2] === undefined; // Default to universal if not specified
      
      const es = Math.max(es0, state.startBp);
      const ee = Math.min(ee0, state.endBp);
      if (ee <= state.startBp || es >= state.endBp) continue;
      const exPos1 = genomePos(es);
      const exPos2 = genomePos(ee);

      const devicePixelRatio = window.devicePixelRatio || 1;
      const useWebGPU = webgpuSupported && instancedRenderer;
      
      // Determine colors based on universal vs partial
      // Universal: solid fill + full opacity stroke
      // Partial: very light fill + reduced opacity stroke
      const fillColor = isUniversal 
        ? [120/255, 180/255, 255/255, 0.18]  // Full opacity fill for universal
        : [120/255, 180/255, 255/255, 0.05]; // Very light fill for partial
      const strokeColor = isUniversal
        ? [120/255, 180/255, 255/255, 0.9]   // Full opacity stroke for universal
        : [120/255, 180/255, 255/255, 0.4]; // Reduced opacity stroke for partial
      
      if (isVertical) {
        // In vertical mode, exons are horizontal bars
        // exPos1 and exPos2 are Y coordinates, need to ensure correct ordering
        const yMin = Math.min(exPos1, exPos2);
        const yMax = Math.max(exPos1, exPos2);
        // Track the bottom-most exon's bottom Y position for gene name alignment
        // (yMax is the bottom of the exon in vertical mode where higher Y = bottom)
        // We want the highest Y value (bottom-most exon)
        if (firstExonY === null || yMax > firstExonY) {
          firstExonY = yMax;
        }
        
        const exonX = perpPos - 6;
        const exonY = yMin;
        const exonW = 12;
        const exonH = Math.max(2, yMax - yMin);
        
        if (useWebGPU) {
          // Draw fill (only if universal or very light for partial)
          if (isUniversal || fillColor[3] > 0) {
            instancedRenderer.addRect(
              exonX * devicePixelRatio,
              exonY * devicePixelRatio,
              exonW * devicePixelRatio,
              exonH * devicePixelRatio,
              fillColor
            );
          }
          // Draw stroke on top
          instancedRenderer.addRect(
            exonX * devicePixelRatio,
            exonY * devicePixelRatio,
            exonW * devicePixelRatio,
            exonH * devicePixelRatio,
            strokeColor
          );
        } else {
          // SVG fallback
          const rectAttrs = {
            x: exonX, y: exonY,
            width: exonW, height: exonH,
            rx: 4,
            stroke: isUniversal ? "var(--blue)" : "rgba(120,180,255,0.4)",
            "stroke-width": 1
          };
          // Only add fill for universal exons
          if (isUniversal) {
            rectAttrs.fill = "var(--blueFill)";
          } else {
            rectAttrs.fill = "rgba(120,180,255,0.05)";
          }
          tracksSvg.appendChild(el("rect", rectAttrs));
        }
      } else {
        // Track the first exon's X position for gene name alignment
        if (firstExonX === null) {
          firstExonX = exPos1;
        }
        
        const exonX = exPos1;
        const exonY = perpPos - 6;
        const exonW = Math.max(2, exPos2 - exPos1);
        const exonH = 12;
        
        if (useWebGPU) {
          // Draw fill (only if universal or very light for partial)
          if (isUniversal || fillColor[3] > 0) {
            instancedRenderer.addRect(
              exonX * devicePixelRatio,
              exonY * devicePixelRatio,
              exonW * devicePixelRatio,
              exonH * devicePixelRatio,
              fillColor
            );
          }
          // Draw stroke on top
          instancedRenderer.addRect(
            exonX * devicePixelRatio,
            exonY * devicePixelRatio,
            exonW * devicePixelRatio,
            exonH * devicePixelRatio,
            strokeColor
          );
        } else {
          // SVG fallback
          const rectAttrs = {
            x: exonX, y: exonY,
            width: exonW, height: exonH,
            rx: 4,
            stroke: isUniversal ? "var(--blue)" : "rgba(120,180,255,0.4)",
            "stroke-width": 1
          };
          // Only add fill for universal exons
          if (isUniversal) {
            rectAttrs.fill = "var(--blueFill)";
          } else {
            rectAttrs.fill = "rgba(120,180,255,0.05)";
          }
          tracksSvg.appendChild(el("rect", rectAttrs));
        }
      }
    }

    // gene label near gene start
    if (isVertical) {
      // Gene name to the left of the gene track
      // Y position should match the bottom of the bottom-most exon
      const geneNameY = firstExonY !== null ? firstExonY : pos1;
      tracksSvg.appendChild(el("text", {
        x: perpPos - 8,
        y: geneNameY,
        class:"svg-geneName",
        "text-anchor": "middle",
        "dominant-baseline": "middle"
      }, `${gene.name}`));
      // Strand indicator to the right of the gene track (just a bit to the right)
      tracksSvg.appendChild(el("text", {
        x: perpPos + 8,
        y: pos1,
        class:"svg-small",
        "text-anchor": "start",
        "dominant-baseline": "middle"
      }, gene.strand === "+" ? "↑" : "↓"));
    } else {
      // In horizontal mode, X position should match the first exon's X position
      const geneNameX = firstExonX !== null ? firstExonX : pos1;
      tracksSvg.appendChild(el("text", {
        x: geneNameX,
        y: perpPos - 12,
        class:"svg-geneName"
      }, `${gene.name}`));
      tracksSvg.appendChild(el("text", {
        x: pos1 + 2,
        y: perpPos + 16,
        class:"svg-small"
      }, gene.strand === "+" ? "→" : "←"));
    }
  }
  }

  // --- RepeatMasker track (skipped entirely when the track was dropped)
  if (repeatsLayout && !repeatsLayout.track.collapsed) {
    let repeatsX, repeatsY, repeatsW, repeatsH;
    if (isVertical) {
      repeatsX = repeatsLayout.contentLeft + 8;
      repeatsW = 22;
      repeatsY = 16;
      // In vertical mode, repeatsH should use W (genomic axis dimension), not H
      repeatsH = W - 32;
    } else {
      repeatsY = repeatsLayout.contentTop + 8;
      repeatsH = 22;
      repeatsX = 16;
      repeatsW = W - 32;
    }

    // background guide line
    if (isVertical) {
      tracksSvg.appendChild(el("line", {
        x1: repeatsX + repeatsW/2, x2: repeatsX + repeatsW/2, y1: 16, y2: W-16,
        stroke: "rgba(127,127,127,0.16)"
      }));
    } else {
      tracksSvg.appendChild(el("line", {
        x1: 16, x2: W-16, y1: repeatsY + repeatsH/2, y2: repeatsY + repeatsH/2,
        stroke: "rgba(127,127,127,0.16)"
      }));
    }

  function repeatColor(cls) {
    // simple palette-ish mapping; kept subtle
    switch (cls) {
      case "SINE": return "rgba(255, 206, 86, 0.35)";
      case "LINE": return "rgba(75, 192, 192, 0.28)";
      case "LTR":  return "rgba(153, 102, 255, 0.28)";
      case "DNA":  return "rgba(255, 99, 132, 0.22)";
      default:     return "rgba(201, 203, 207, 0.22)";
    }
  }

  function repeatColorToRgba(cls) {
    const rgbaStr = repeatColor(cls);
    // Parse "rgba(255, 206, 86, 0.35)" to [r, g, b, a] normalized
    const match = rgbaStr.match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
    if (match) {
      return [
        parseInt(match[1]) / 255,
        parseInt(match[2]) / 255,
        parseInt(match[3]) / 255,
        parseFloat(match[4])
      ];
    }
    return [0.5, 0.5, 0.5, 0.5]; // fallback
  }

  // Optimize repeat rendering: filter, cluster, and batch DOM operations
  // Calculate minimum pixel width (don't render repeats smaller than 1 pixel)
  const minPixelWidth = 1;
  const clusterThreshold = 5; // Cluster repeats within 5bp of each other
  const maxRepeatsToRender = 5000; // Safety limit to prevent crashes

  // Filter and prepare visible repeats
  const visibleRepeats = [];
  for (const r of repeats) {
    if (r.end <= state.startBp || r.start >= state.endBp) continue;
    const rs = Math.max(r.start, state.startBp);
    const re = Math.min(r.end, state.endBp);
    
    const pos1 = genomePos(rs);
    const pos2 = genomePos(re);
    const width = Math.abs(pos2 - pos1);
    
    // Skip repeats that are too small to render
    if (width < minPixelWidth) continue;
    
    visibleRepeats.push({
      start: rs,  // Clamped start for rendering
      end: re,   // Clamped end for rendering
      originalStart: r.start,  // Original RepeatMasker start coordinate
      originalEnd: r.end,     // Original RepeatMasker end coordinate
      cls: r.cls,
      pos1: pos1,
      pos2: pos2,
      width: width
    });
  }

  // Sort by position for clustering
  visibleRepeats.sort((a, b) => a.start - b.start);

  // Cluster nearby repeats of the same class to reduce DOM elements
  const clusteredRepeats = [];
  let currentCluster = null;
  
  for (const r of visibleRepeats) {
    if (currentCluster && 
        r.cls === currentCluster.cls &&
        r.start - currentCluster.end <= clusterThreshold) {
      // Merge into current cluster
      currentCluster.end = Math.max(currentCluster.end, r.end);
      currentCluster.originalEnd = Math.max(currentCluster.originalEnd, r.originalEnd);
      currentCluster.pos2 = genomePos(currentCluster.end);
      currentCluster.width = Math.abs(currentCluster.pos2 - currentCluster.pos1);
    } else {
      // Start new cluster
      if (currentCluster) {
        clusteredRepeats.push(currentCluster);
      }
      currentCluster = {
        start: r.start,
        end: r.end,
        originalStart: r.originalStart,
        originalEnd: r.originalEnd,
        cls: r.cls,
        pos1: r.pos1,
        pos2: r.pos2,
        width: r.width
      };
    }
  }
  if (currentCluster) {
    clusteredRepeats.push(currentCluster);
  }

  // Limit the number of elements to render (take first N if too many)
  const repeatsToRender = clusteredRepeats.slice(0, maxRepeatsToRender);
  
  if (clusteredRepeats.length > maxRepeatsToRender) {
    console.warn(`Too many repeats (${clusteredRepeats.length}), rendering only first ${maxRepeatsToRender}`);
  }

  // Store repeat data for hit testing
  repeatHitTestData = [];
  
  // Use WebGPU if available, otherwise fall back to SVG
  if (webgpuSupported && instancedRenderer) {
    // Add rectangles to WebGPU renderer
    // Scale by devicePixelRatio since WebGPU canvas uses physical pixels
    const dpr = window.devicePixelRatio || 1;
    
    for (const r of repeatsToRender) {
      const pos1 = r.pos1;
      const pos2 = r.pos2;
      const width = Math.max(1, pos2 - pos1);
      const height = repeatsH - 8;
      
      let x, y, w, h;
      if (isVertical) {
        const yMin = Math.min(pos1, pos2);
        const yMax = Math.max(pos1, pos2);
        x = repeatsX + 4;
        y = yMin;
        w = repeatsW - 8;
        h = Math.max(1, yMax - yMin);
      } else {
        x = pos1;
        y = repeatsY + 4;
        w = width;
        h = height;
      }
      
      const rgba = repeatColorToRgba(r.cls);
      // Scale coordinates by DPR to match physical pixel canvas
      instancedRenderer.addRect(x * dpr, y * dpr, w * dpr, h * dpr, rgba);
      
      // Store for hit testing (use original RepeatMasker coordinates, not clamped/clustered)
      repeatHitTestData.push({
        start: r.originalStart,
        end: r.originalEnd,
        cls: r.cls
      });
    }
  } else {
    // Fallback to SVG rendering
    const fragment = document.createDocumentFragment();
    
    for (const r of repeatsToRender) {
      const pos1 = r.pos1;
      const pos2 = r.pos2;
      const isSmall = r.width < 3; // Don't add stroke for very small elements
      
      // Format tooltip text with repeat class and original coordinates
      const tooltipText = `${r.cls} repeat\n${Math.floor(r.originalStart).toLocaleString()} - ${Math.floor(r.originalEnd).toLocaleString()}`;
      
      // Create rect element
      let rect;
      if (isVertical) {
        const yMin = Math.min(pos1, pos2);
        const yMax = Math.max(pos1, pos2);
        rect = el("rect", {
          x: repeatsX + 4,
          y: yMin,
          width: repeatsW - 8,
          height: Math.max(1, yMax - yMin),
          rx: isSmall ? 0 : 6,
          fill: repeatColor(r.cls),
          style: "cursor: pointer;"
        });
        if (!isSmall) {
          rect.setAttribute("stroke", "rgba(127,127,127,0.20)");
        }
      } else {
        rect = el("rect", {
          x: pos1,
          y: repeatsY + 4,
          width: Math.max(1, pos2 - pos1),
          height: repeatsH - 8,
          rx: isSmall ? 0 : 6,
          fill: repeatColor(r.cls),
          style: "cursor: pointer;"
        });
        if (!isSmall) {
          rect.setAttribute("stroke", "rgba(127,127,127,0.20)");
        }
      }
      
      // Add mouse event handlers for tooltip
      rect.addEventListener("mousemove", (e) => {
        state.hoveredRepeatTooltip = {
          text: tooltipText,
          x: e.clientX + 10,
          y: e.clientY + 10
        };
        updateTooltip();
      });
      
      rect.addEventListener("mouseleave", () => {
        state.hoveredRepeatTooltip = null;
        updateTooltip();
      });
      
      fragment.appendChild(rect);
    }
    
    // Append all elements at once (single DOM operation)
    tracksSvg.appendChild(fragment);
  }
  }

  // Coordinate axis: base line + major/minor ticks + bp labels + edge
  // labels. Factored out of the old Indel ruler so it can ride the
  // Reference track (baseX used in vertical mode, baseY in horizontal).
  function drawGenomicAxis(baseX, baseY) {
      // Base line
      if (isVertical) {
        tracksSvg.appendChild(el("line", {
          x1: baseX, x2: baseX, y1: 16, y2: H-16,
          stroke: "rgba(127,127,127,0.70)",
          "stroke-width": 1.2
        }));
      } else {
        tracksSvg.appendChild(el("line", {
          x1: 16, x2: W-16, y1: baseY, y2: baseY,
          stroke: "rgba(127,127,127,0.70)",
          "stroke-width": 1.2
        }));
      }

      const span = state.endBp - state.startBp;
      const dim = isVertical ? H : W;
      const desiredMajorTicks = Math.max(5, Math.min(10, Math.floor((dim - 32) / 140)));
      const majorBp = chooseNiceTickBp(span, desiredMajorTicks);
      const minorBp = majorBp / 5;

      const pxPerMajor = (dim - 32) / (span / majorBp);
      const showLabels = pxPerMajor >= 80;

    const firstMinor = Math.ceil(state.startBp / minorBp) * minorBp;

    // Track major tick label positions to avoid overlap with edge labels
    const majorTickLabelPositions = [];

    for (let bp = firstMinor; bp <= state.endBp; bp += minorBp) {
      const pos = genomePos(bp);
      const isMajor = (Math.round(bp / minorBp) % 5) === 0;

      if (isVertical) {
        tracksSvg.appendChild(el("line", {
          x1: baseX - (isMajor ? 9 : 5), x2: baseX + (isMajor ? 9 : 5),
          y1: pos, y2: pos,
          stroke: isMajor ? "rgba(127,127,127,0.55)" : "rgba(127,127,127,0.30)",
          "stroke-width": isMajor ? 1.1 : 1
        }));

        if (isMajor && showLabels) {
          const textEl = el("text", {
            x: baseX + 26,
            y: pos,
            class: "svg-small",
            "text-anchor": "start",
            "dominant-baseline": "middle"
          }, formatBp(Math.round(bp), span));
          tracksSvg.appendChild(textEl);
          majorTickLabelPositions.push(pos);
        }
      } else {
        tracksSvg.appendChild(el("line", {
          x1: pos, x2: pos,
          y1: baseY - (isMajor ? 9 : 5), y2: baseY + (isMajor ? 9 : 5),
          stroke: isMajor ? "rgba(127,127,127,0.55)" : "rgba(127,127,127,0.30)",
          "stroke-width": isMajor ? 1.1 : 1
        }));

        if (isMajor && showLabels) {
          tracksSvg.appendChild(el("text", {
            x: pos,
            y: baseY + 26,
            class: "svg-small",
            "text-anchor": "middle"
          }, formatBp(Math.round(bp), span)));
          majorTickLabelPositions.push(pos);
        }
      }
    }

    // Only show edge labels if no tick label is too close
    const edgeThreshold = 100; // pixels
    if (isVertical) {
      const bottomEdgeY = H - 16;
      const topEdgeY = 16;
      const hasNearbyBottomTick = majorTickLabelPositions.some(tickY => Math.abs(tickY - bottomEdgeY) < edgeThreshold);
      const hasNearbyTopTick = majorTickLabelPositions.some(tickY => Math.abs(tickY - topEdgeY) < edgeThreshold);

      if (!hasNearbyBottomTick) {
        const textEl = el("text", {
          x: baseX + 26, y: bottomEdgeY, class:"svg-small", "text-anchor":"start", "dominant-baseline":"middle"
        }, formatBp(Math.round(state.startBp), span));
        tracksSvg.appendChild(textEl);
      }
      if (!hasNearbyTopTick) {
        const textEl = el("text", {
          x: baseX + 26, y: topEdgeY, class:"svg-small", "text-anchor":"start", "dominant-baseline":"middle"
        }, formatBp(Math.round(state.endBp), span));
        tracksSvg.appendChild(textEl);
      }
    } else {
      const leftEdgeX = 16;
      const rightEdgeX = W - 16;
      const hasNearbyLeftTick = majorTickLabelPositions.some(tickX => Math.abs(tickX - leftEdgeX) < edgeThreshold);
      const hasNearbyRightTick = majorTickLabelPositions.some(tickX => Math.abs(tickX - rightEdgeX) < edgeThreshold);

      if (!hasNearbyLeftTick) {
        tracksSvg.appendChild(el("text", { x: 16, y: baseY + 26, class:"svg-small" },
          formatBp(Math.round(state.startBp), span)
        ));
      }
      if (!hasNearbyRightTick) {
        tracksSvg.appendChild(el("text", {
          x: W - 16, y: baseY + 26, class:"svg-small", "text-anchor":"end"
        }, formatBp(Math.round(state.endBp), span)));
      }
    }
  }

  // --- Locus ruler
  if (flowLayout && !flowLayout.track.collapsed) {
    let rulerX, rulerY, rulerW, rulerH, baseX, baseY;
    if (isVertical) {
      rulerX = flowLayout.contentLeft + 8;
      rulerW = 56;
      rulerY = 16;
      rulerH = H - 32;
      baseX = rulerX + 14;
    } else {
      rulerY = flowLayout.contentTop + 4;
      rulerH = 56;
      rulerX = 16;
      rulerW = W - 32;
      baseY = rulerY + 12;
    }
    // Indel lollipops render into a dedicated overlay ABOVE the variant
    // (flow) canvas so they sit on the variants — the standalone Indel track
    // is gone. Full-viewer overlay -> same genome x-mapping as the tracks SVG.
    const flowIndelOverlay = document.getElementById('flowIndelOverlay');
    if (!flowIndelOverlay) return;
    while (flowIndelOverlay.firstChild) flowIndelOverlay.removeChild(flowIndelOverlay.firstChild);
    flowIndelOverlay.setAttribute('width', W);
    flowIndelOverlay.setAttribute('height', H);
    flowIndelOverlay.setAttribute('viewBox', `0 0 ${W} ${H}`);

  // Variant marks: use all variant tracks so every track adds a marker to the ruler
  const variantTracksConfig = (window.GENOMESHADER_CONFIG && window.GENOMESHADER_CONFIG.variant_tracks) || [];
  const rulerVariantsRaw = variantTracksConfig.length > 0
    ? variantTracksConfig.flatMap(t => t.variants_data || [])
    : variants;
  const seenRulerVariantIds = new Set();
  const rulerVariants = [];
  for (const rv of rulerVariantsRaw) {
    const rid = String(rv.id);
    if (seenRulerVariantIds.has(rid)) continue;
    seenRulerVariantIds.add(rid);
    rulerVariants.push(rv);
  }
  for (let idx = 0; idx < rulerVariants.length; idx++) {
    const v = rulerVariants[idx];
    const variantId = String(v.id);
    if (v.pos < state.startBp || v.pos > state.endBp) continue;
    // Indel track: only positions with an insertion or deletion.
    if (typeof isIndel === "function" && !isIndel(v)) continue;
    const pos = genomePos(v.pos);
    const isHovered = (state.hoveredVariantId != null && variantId === String(state.hoveredVariantId)) || state.hoveredVariantIndex === idx;
    const strokeWidth = isHovered ? 2.5 : 1.2;
    const circleStrokeWidth = isHovered ? 2.2 : 1.4;
    const isIns = isInsertion(v);

    let lineEl;
    const strokeColor = isHovered ? "var(--blue)" : "rgba(127,127,127,0.5)";
    if (isVertical) {
      lineEl = el("line", {
        x1: baseX - 18, x2: baseX + 18,
        y1: pos, y2: pos,
        stroke: strokeColor,
        "stroke-width": strokeWidth,
        style: "cursor: pointer;",
        "data-variant-id": variantId
      });
    } else {
      lineEl = el("line", {
        x1: pos, x2: pos,
        y1: baseY - 18, y2: baseY + 18,
        stroke: strokeColor,
        "stroke-width": strokeWidth,
        style: "cursor: pointer;",
        "data-variant-id": variantId
      });
    }
    lineEl.addEventListener("mouseenter", () => {
      state.hoveredVariantIndex = idx;
      state.hoveredVariantId = variantId;
      renderHoverOnly();
    });
    lineEl.addEventListener("mouseleave", () => {
      state.hoveredVariantIndex = null;
      state.hoveredVariantId = null;
      renderHoverOnly();
    });
    
    // Indels are toggleable on the line itself: insertions expand their gap,
    // deletions repeat the reference for their deleted bases. A position that is
    // BOTH (an insertion alt and a deletion alt) cycles off -> ins -> del -> off,
    // so you can look at either without them fighting over one marker.
    const _isIns = isInsertion(v), _isDel = isDeletion(v);
    const _isMixed = _isIns && _isDel;
    const _indelTitle = _isMixed ? "Click to toggle insertion / deletion"
      : (_isIns ? "Click to expand insertion" : "Click to show deleted bases");
    const _toggleIndel = () => {
      const insSet = state.expandedInsertions, delSet = state.expandedDeletions;
      const nxt = nextIndelExpansion(_isIns, _isDel, insSet.has(variantId), delSet.has(variantId));
      if (nxt.ins) insSet.add(variantId); else insSet.delete(variantId);
      if (nxt.del) delSet.add(variantId); else delSet.delete(variantId);
      renderAll();
    };
    if (typeof isIndel === "function" && isIndel(v)) {
      lineEl.style.pointerEvents = "auto";
      lineEl.setAttribute("title", _indelTitle);
      lineEl.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        e.preventDefault();
        _toggleIndel();
      });
    }
    flowIndelOverlay.appendChild(lineEl);
    
    // Store reference to variant elements for hover updates
    if (!state.locusVariantElements.has(idx)) {
      state.locusVariantElements.set(idx, { lineEl: null, circleEl: null });
    }
    state.locusVariantElements.get(idx).lineEl = lineEl;
    
    // Larger invisible clickable area for the indel toggle (easier to hit)
    if (typeof isIndel === "function" && isIndel(v)) {
      // Add an invisible wider rectangle for easier clicking
      let clickArea;
      if (isVertical) {
        clickArea = el("rect", {
          x: baseX - 20,
          y: pos - 5,
          width: 40,
          height: 10,
          fill: "transparent",
          style: "cursor: pointer; pointer-events: auto;",
          "data-variant-id": variantId
        });
      } else {
        clickArea = el("rect", {
          x: pos - 5,
          y: baseY - 20,
          width: 10,
          height: 40,
          fill: "transparent",
          style: "cursor: pointer; pointer-events: auto;",
          "data-variant-id": variantId
        });
      }
      clickArea.setAttribute("title", _indelTitle);
      clickArea.addEventListener("mouseenter", () => {
        state.hoveredVariantIndex = idx;
        state.hoveredVariantId = variantId;
        renderHoverOnly();
      });
      clickArea.addEventListener("mouseleave", () => {
        state.hoveredVariantIndex = null;
        state.hoveredVariantId = null;
        renderHoverOnly();
      });
      clickArea.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        e.preventDefault();
        _toggleIndel();
      });
      flowIndelOverlay.appendChild(clickArea);
    }

    let circleEl;
    const circleStrokeColor = isHovered ? "var(--blue)" : "rgba(127,127,127,0.5)";
    if (isVertical) {
      circleEl = el("circle", {
        cx: baseX - 18, cy: pos, r: 3.4,
        fill: "none",
        stroke: circleStrokeColor,
        "stroke-width": circleStrokeWidth,
        style: "cursor: pointer;",
        "data-variant-id": variantId
      });
    } else {
      circleEl = el("circle", {
        cx: pos, cy: baseY - 18, r: 3.4,
        fill: "none",
        stroke: circleStrokeColor,
        "stroke-width": circleStrokeWidth,
        style: "cursor: pointer;",
        "data-variant-id": variantId
      });
    }
    circleEl.addEventListener("mouseenter", () => {
      state.hoveredVariantIndex = idx;
      state.hoveredVariantId = variantId;
      renderHoverOnly();
    });
    circleEl.addEventListener("mouseleave", () => {
      state.hoveredVariantIndex = null;
      state.hoveredVariantId = null;
      renderHoverOnly();
    });
    // Pointerdown handler to toggle insertion expansion
    if (isInsertion(v)) {
      circleEl.style.pointerEvents = "auto";
      circleEl.setAttribute("title", "Click to expand insertion");
      circleEl.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (state.expandedInsertions.has(variantId)) {
          state.expandedInsertions.delete(variantId);
        } else {
          state.expandedInsertions.add(variantId);
        }
        renderAll();
      });
    }
    flowIndelOverlay.appendChild(circleEl);
    
    // Store reference to circle element for hover updates
    if (!state.locusVariantElements.has(idx)) {
      state.locusVariantElements.set(idx, { lineEl: null, circleEl: null });
    }
    state.locusVariantElements.get(idx).circleEl = circleEl;

    // Draw expanded insertion sequence gap only while this variant marker is in view.
    if (state.expandedInsertions.has(variantId) && isInsertion(v)) {
      const gapSize = getGapAfterBpPx(v.pos, state.expandedInsertions);
      if (!(gapSize > 0)) continue;
      const nextBpAtVariant = Math.min(state.endBp, Number(v.pos) + 1);
      const nextPosAtVariant = genomePosCanonical(nextBpAtVariant);

      if (isVertical) {
        const gapEndY = nextPosAtVariant;
        flowIndelOverlay.appendChild(el("rect", {
          x: baseX - 18,
          y: gapEndY,
          width: 36,
          height: gapSize,
          fill: "rgba(255,255,255,0.1)",
          stroke: "rgba(127,127,127,0.3)",
          "stroke-width": 1,
          "stroke-dasharray": "2,2"
        }));
      } else {
        const gapEndX = nextPosAtVariant;
        const variantPosAtVariant = genomePosCanonical(Number(v.pos));
        const rawSegmentSizeAtVariant = Math.abs(gapEndX - variantPosAtVariant);
        const renderedRefBaseSizeAtVariant = Math.max(1, rawSegmentSizeAtVariant - gapSize);
        const gapStartXFromReference = variantPosAtVariant + renderedRefBaseSizeAtVariant;
        const canonicalGapStartX = gapEndX - gapSize;
        const gapStartX = Math.max(canonicalGapStartX, gapStartXFromReference);
        const displayedGapSizeX = Math.max(0, gapEndX - gapStartX);
        if (!(displayedGapSizeX > 0)) continue;
        const insertionBandHeight = 24;
        const insertionBandY = baseY - insertionBandHeight / 2;

        flowIndelOverlay.appendChild(el("rect", {
          x: gapStartX,
          y: insertionBandY,
          width: displayedGapSizeX,
          height: insertionBandHeight,
          fill: "rgba(255,255,255,0.1)",
          stroke: "rgba(127,127,127,0.3)",
          "stroke-width": 1,
          "stroke-dasharray": "2,2"
        }));
      }
    }
  }

  }

  // --- Reference track
  if (!referenceLayout.track.collapsed) {
    let referenceX, referenceY, referenceW, referenceH;
    if (isVertical) {
      referenceX = referenceLayout.contentLeft + 8;
      referenceW = 24;
      referenceY = 16;
      referenceH = H - 32;
    } else {
      referenceY = referenceLayout.contentTop + 8;
      referenceH = 24;
      referenceX = 16;
      referenceW = W - 32;
    }

    // Helper function to get reference sequence for a region
    // Returns { sequence: array, startBp: number } where startBp is the genomic position of sequence[0]
    function getReferenceSequence(startBp, endBp) {
      // Use the real reference sequence from config if available
      if (referenceSequence && referenceSequence.length > 0) {
        // Calculate the offset into the sequence
        // The reference sequence starts at data_bounds.start (0-based)
        // UCSC returns sequence for [start, end), so sequence[i] corresponds to genomic position (dataStart + i)
        const dataStart = window.GENOMESHADER_CONFIG?.data_bounds?.start || 0;
        const viewStart = Math.floor(startBp);
        const viewEnd = Math.floor(endBp);
        
        // Calculate sequence indices (0-based relative to sequence start)
        // seqStart: index in sequence string for viewStart genomic position
        // seqEnd: index in sequence string for (viewEnd + 1) genomic position (exclusive end)
        const seqStart = Math.max(0, viewStart - dataStart);
        const seqEnd = Math.min(referenceSequence.length, viewEnd - dataStart + 1);
        
        // Only return sequence if we have valid indices within bounds
        if (seqStart >= 0 && seqEnd > seqStart && seqStart < referenceSequence.length) {
          const sequence = referenceSequence.slice(seqStart, seqEnd).split('');
          // The actual genomic start position of the returned sequence
          const actualStartBp = dataStart + seqStart;
          return { sequence: sequence, startBp: actualStartBp };
        }
      }
      // Fallback: return empty array if no sequence data
      return { sequence: [], startBp: startBp };
    }

    const span = state.endBp - state.startBp;
    const startBpInt = Math.floor(state.startBp);
    const endBpInt = Math.floor(state.endBp);
    const refSeqData = getReferenceSequence(startBpInt, endBpInt);
    const refSeq = refSeqData.sequence;
    const refSeqStartBp = refSeqData.startBp;

    // Single source of truth for base colors, shared with the read-track SNP
    // tiles (main.js) so the two never drift apart. Publish once.
    if (typeof window !== "undefined" && !window.__GS_BASE_COLORS) {
      window.__GS_BASE_COLORS = {
        'A': [0, 200, 0],      // green
        'C': [0, 0, 255],      // blue
        'G': [255, 165, 0],    // orange
        'T': [255, 0, 0]       // red
      };
    }
    const nucleotideColors = (typeof window !== "undefined" && window.__GS_BASE_COLORS) || {
      'A': [0, 200, 0], 'C': [0, 0, 255], 'G': [255, 165, 0], 'T': [255, 0, 0]
    };
    const BASE_TILE_MAX_ALPHA = 1.0; // solid color blocks (IGV-style)
    const BASE_MIN_DRAW_PX = 0.03;
    const BASE_FADE_START_PX = 0.08;
    const BASE_FADE_FULL_PX = 1.6;
    const BASE_VISUAL_TRIM_PX = 0.15;
    const BASE_TEXT_FADE_START_PX = 6.0;
    const BASE_TEXT_FADE_FULL_PX = 9.0;
    const WEBGPU_GEOM_QUANT_PX = 0.5; // device-pixel quantization step to reduce shimmer

    function clamp01(v) {
      return Math.max(0, Math.min(1, v));
    }

    function smoothstep01(t) {
      const x = clamp01(t);
      return x * x * (3 - 2 * x);
    }

    function getBaseFadeAlpha(actualSize) {
      if (!(actualSize > BASE_MIN_DRAW_PX)) return 0;
      const t = (actualSize - BASE_FADE_START_PX) / (BASE_FADE_FULL_PX - BASE_FADE_START_PX);
      return BASE_TILE_MAX_ALPHA * smoothstep01(t);
    }

    function getBaseTextFadeAlpha(actualSize) {
      const t = (actualSize - BASE_TEXT_FADE_START_PX) / (BASE_TEXT_FADE_FULL_PX - BASE_TEXT_FADE_START_PX);
      return smoothstep01(t);
    }

    function quantizeDevicePx(v) {
      return Math.round(v / WEBGPU_GEOM_QUANT_PX) * WEBGPU_GEOM_QUANT_PX;
    }

    // Helper function to convert nucleotide color to RGBA array for WebGPU
    function nucleotideColorToRgba(base, alpha) {
      const rgb = nucleotideColors[base] || [127, 127, 127];
      return [
        rgb[0] / 255,
        rgb[1] / 255,
        rgb[2] / 255,
        clamp01(alpha)
      ];
    }

    // Letter color per base: black or white, whichever contrasts with the solid
    // block color. Static lookup — no per-letter computation. A(green)/G(orange)
    // are light -> black; C(blue)/T(red) are dark -> white.
    const baseLetterColor = { 'A': '#000000', 'C': '#ffffff', 'G': '#000000', 'T': '#ffffff' };

    // Render reference bases continuously across zoom levels so tiles naturally
    // shrink/fade instead of hard-switching to a separate zoomed-out style.
    const minVisibleBaseSize = BASE_MIN_DRAW_PX;
    const showIndividualBases = refSeq.length > 0;

    // Performance limit: maximum number of bases to render
    const maxBasesToRender = 10000;

    if (showIndividualBases && refSeq.length > 0) {
      // Filter and prepare visible bases
      const visibleBases = [];
      for (let i = 0; i < refSeq.length; i++) {
        // Calculate the actual genomic position for this base
        // UCSC uses 0-based coordinates, but genomic positions are 1-based
        // refSeq[i] corresponds to genomic position refSeqStartBp + i + 1 (1-based)
        const bp = refSeqStartBp + i + 1;
        
        // Only render bases that are within the visible view
        if (bp < state.startBp || bp > state.endBp) continue;
        
        // Use genomePosCanonical to account for insertion gaps
        const pos = genomePosCanonical(bp);
        const nextBp = bp + 1;
        const nextPos = nextBp <= state.endBp ? genomePosCanonical(nextBp) : genomePosCanonical(state.endBp);
        const gapAfterPx = getGapAfterBpPx(bp, state.expandedInsertions);
        const rawSegmentSize = Math.abs(nextPos - pos);
        const actualSize = Math.max(0, rawSegmentSize - gapAfterPx);
        
        // Skip effectively non-visible tiles.
        if (actualSize < minVisibleBaseSize) continue;
        
        const base = refSeq[i].toUpperCase();
        visibleBases.push({
          bp: bp,
          base: base,
          pos: pos,
          nextPos: nextPos,
          actualSize: actualSize,
          baseAlpha: getBaseFadeAlpha(actualSize),
          textAlpha: getBaseTextFadeAlpha(actualSize)
        });
      }

      // Limit the number of bases to render
      const basesToRender = visibleBases.slice(0, maxBasesToRender);
      
      if (visibleBases.length > maxBasesToRender) {
        console.warn(`Too many bases (${visibleBases.length}), rendering only first ${maxBasesToRender}`);
      }

      // Use WebGPU if available, otherwise fall back to SVG
      if (webgpuSupported && instancedRenderer) {
        // Add rectangles to WebGPU renderer
        // Scale by devicePixelRatio since WebGPU canvas uses physical pixels
        const dpr = window.devicePixelRatio || 1;
        
        for (const b of basesToRender) {
          const pos = b.pos;
          const actualSize = b.actualSize;
          const base = b.base;
          const alpha = b.baseAlpha;
          if (!(alpha > 0)) continue;
          const rgba = nucleotideColorToRgba(base, alpha);
          
          let x, y, w, h;
          if (isVertical) {
            x = referenceX;
            y = pos;
            w = referenceW;
            h = Math.max(0, actualSize - BASE_TILE_INSET_PX - BASE_VISUAL_TRIM_PX);
          } else {
            x = pos;
            y = referenceY;
            w = Math.max(0, actualSize - BASE_TILE_INSET_PX - BASE_VISUAL_TRIM_PX);
            h = referenceH;
          }
          if (!(w > 0) || !(h > 0)) continue;
          const qx = quantizeDevicePx(x * dpr);
          const qy = quantizeDevicePx(y * dpr);
          const qw = Math.max(0, quantizeDevicePx(w * dpr));
          const qh = Math.max(0, quantizeDevicePx(h * dpr));
          if (!(qw > 0) || !(qh > 0)) continue;
          
          // Scale coordinates by DPR to match physical pixel canvas
          instancedRenderer.addRect(qx, qy, qw, qh, rgba);
        }
        
        // Draw base letters using SVG. IGV-style: solid color block with a
        // letter whose color is picked for contrast against the block. The dark
        // blocks (C blue, T red) get white letters; the lighter blocks (A green,
        // G orange) get black.
        const fragment = document.createDocumentFragment();
        for (const b of basesToRender) {
          if (b.textAlpha > 0) {
            const base = b.base;
            const pos = b.pos;
            const actualSize = b.actualSize;
            const textColor = baseLetterColor[base] || '#ffffff';
            const textOpacity = Math.max(0.1, b.textAlpha);
            
            if (isVertical) {
              const textEl = el("text", {
                x: referenceX + referenceW / 2,
                y: pos + actualSize / 2,
                "text-anchor": "middle",
                "dominant-baseline": "middle",
                style: `fill: ${textColor}; fill-opacity: 1; font-size: 10px; font-weight: bold;`
              }, base);
              fragment.appendChild(textEl);
            } else {
              const textEl = el("text", {
                x: pos + actualSize / 2,
                y: referenceY + referenceH / 2,
                "text-anchor": "middle",
                "dominant-baseline": "middle",
                style: `fill: ${textColor}; fill-opacity: 1; font-size: 10px; font-weight: bold;`
              }, base);
              fragment.appendChild(textEl);
            }
          }
        }
        tracksSvg.appendChild(fragment);
      } else {
        // Fallback to SVG rendering
        const fragment = document.createDocumentFragment();

        for (const b of basesToRender) {
          const pos = b.pos;
          const actualSize = b.actualSize;
          const base = b.base;
          const alpha = b.baseAlpha;
          if (!(alpha > 0)) continue;
          const rgb = nucleotideColors[base] || [127, 127, 127];
          const rectColor = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
          const textColor = baseLetterColor[base] || '#ffffff';
          
          if (isVertical) {
            fragment.appendChild(el("rect", {
              x: referenceX,
              y: pos,
              width: referenceW,
              height: Math.max(0, actualSize - BASE_TILE_INSET_PX - BASE_VISUAL_TRIM_PX),
              fill: rectColor
            }));

            // Draw base letter if space allows
            if (b.textAlpha > 0) {
              const textOpacity = Math.max(0.1, b.textAlpha);
              const textEl = el("text", {
                x: referenceX + referenceW / 2,
                y: pos + actualSize / 2,
                "text-anchor": "middle",
                "dominant-baseline": "middle",
                style: `fill: ${textColor}; fill-opacity: 1; font-size: 10px; font-weight: bold;`
              }, base);
              fragment.appendChild(textEl);
            }
          } else {
            fragment.appendChild(el("rect", {
              x: pos,
              y: referenceY,
              width: Math.max(0, actualSize - BASE_TILE_INSET_PX - BASE_VISUAL_TRIM_PX),
              height: referenceH,
              fill: rectColor
            }));

            // Draw base letter if space allows
            if (b.textAlpha > 0) {
              const textOpacity = Math.max(0.1, b.textAlpha);
              const textEl = el("text", {
                x: pos + actualSize / 2,
                y: referenceY + referenceH / 2,
                "text-anchor": "middle",
                "dominant-baseline": "middle",
                style: `fill: ${textColor}; fill-opacity: 1; font-size: 10px; font-weight: bold;`
              }, base);
              fragment.appendChild(textEl);
            }
          }
        }
        
        // Append all elements at once (single DOM operation)
        tracksSvg.appendChild(fragment);
      }
    } else {
      // Fallback only when no reference sequence is available.
      if (isVertical) {
        const topPad = 16, bottomPad = 16;
        const innerH = H - topPad - bottomPad;
        const totalGapPx = getTotalInsertionGapWidth();
        const totalGapBp = totalGapPx / state.pxPerBp;
        const effectiveSpan = span + totalGapBp;

        // Draw background
        tracksSvg.appendChild(el("rect", {
          x: referenceX,
          y: topPad,
          width: referenceW,
          height: innerH,
          fill: "rgba(127,127,127,0.08)",
          rx: 4
        }));

        // Draw a subtle pattern indicating reference sequence
        const patternHeight = 20;
        for (let y = topPad; y < topPad + innerH; y += patternHeight * 2) {
          tracksSvg.appendChild(el("rect", {
            x: referenceX,
            y: y,
            width: referenceW,
            height: Math.min(patternHeight, topPad + innerH - y),
            fill: "rgba(127,127,127,0.12)"
          }));
        }
      } else {
        const leftPad = 16, rightPad = 16;
        const innerW = W - leftPad - rightPad;
        const totalGapPx = getTotalInsertionGapWidth();
        const totalGapBp = totalGapPx / state.pxPerBp;
        const effectiveSpan = span + totalGapBp;

        // Draw background
        tracksSvg.appendChild(el("rect", {
          x: leftPad,
          y: referenceY,
          width: innerW,
          height: referenceH,
          fill: "rgba(127,127,127,0.08)",
          rx: 4
        }));

        // Draw a subtle pattern indicating reference sequence
        const patternWidth = 20;
        for (let x = leftPad; x < leftPad + innerW; x += patternWidth * 2) {
          tracksSvg.appendChild(el("rect", {
            x: x,
            y: referenceY,
            width: Math.min(patternWidth, leftPad + innerW - x),
            height: referenceH,
            fill: "rgba(127,127,127,0.12)"
          }));
        }
      }
    }

    // Separator
    if (isVertical) {
      tracksSvg.appendChild(el("line", {
        x1: referenceX + referenceW, x2: referenceX + referenceW, y1: 0, y2: H,
        stroke: "rgba(127,127,127,0.12)"
      }));
    } else {
      tracksSvg.appendChild(el("line", {
        x1: 0, x2: W, y1: referenceY - 4, y2: referenceY - 4,
        stroke: "rgba(127,127,127,0.12)"
      }));
    }

    // Deletion visualization. A deletion removes reference bases, so an expanded
    // deletion (click its Indel marker) repeats the reference: horizontal mode
    // stacks one extra reference row per expanded deletion (the layout grew the
    // track to fit them), each showing that deletion's deleted bases greyed hard
    // but still legible — colors + letters survive the wash. Vertical mode keeps
    // the simpler in-place shading (it's being reworked separately).
    if (typeof isDeletion === "function") {
      if (isVertical) {
        const vcfg = (window.GENOMESHADER_CONFIG && window.GENOMESHADER_CONFIG.variant_tracks) || [];
        const delVars = vcfg.length ? vcfg.flatMap(t => t.variants_data || [])
          : ((typeof variants !== "undefined" && Array.isArray(variants)) ? variants : []);
        const seenDel = new Set();
        const fill = "rgba(120,120,120,0.5)", edge = "rgba(80,80,80,0.85)";
        for (const v of delVars) {
          if (!v || v.pos == null || !isDeletion(v)) continue;
          if (!(state.expandedDeletions && state.expandedDeletions.has(String(v.id)))) continue;
          const delLen = (typeof getMaxDeletionLength === "function") ? getMaxDeletionLength(v) : 0;
          if (!(delLen > 0)) continue;
          const key = String(v.id); if (seenDel.has(key)) continue; seenDel.add(key);
          const loBp = Math.max(Number(v.pos) + 1, state.startBp);
          const hiBp = Math.min(Number(v.pos) + delLen, state.endBp);
          if (hiBp < loBp) continue;
          const a = genomePos(loBp), b = genomePos(hiBp + 1);
          const lo = Math.min(a, b), hi = Math.max(a, b), mid = (lo + hi) / 2;
          tracksSvg.appendChild(el("rect", { x: referenceX, y: lo, width: referenceW, height: Math.max(1, hi - lo),
            fill: fill, stroke: edge, "stroke-width": 1 }));
          tracksSvg.appendChild(el("line", { x1: referenceX, x2: referenceX + referenceW, y1: mid, y2: mid,
            stroke: edge, "stroke-width": 1 }));
        }
      } else {
        const dels = (typeof getExpandedDeletionsInView === "function") ? getExpandedDeletionsInView() : [];
        const wash = "rgba(70,70,70,0.62)", edge = "rgba(35,35,35,0.9)";
        dels.forEach((d, i) => {
          // +50 clears the coordinate-axis strip now drawn below the sequence.
          const rowTop = referenceY + referenceH + 50 + i * DELETION_ROW_H;
          const rowH = DELETION_ROW_H - 5;
          const loBp = Math.max(d.loBp, Math.ceil(state.startBp));
          const hiBp = Math.min(d.hiBp, Math.floor(state.endBp));
          if (hiBp < loBp) return;
          for (let bp = loBp; bp <= hiBp; bp++) {
            // Use the SAME position + base indexing as the main reference row so
            // the deleted bases line up under it: genomePosCanonical (gap-aware)
            // and refSeq index bp - refSeqStartBp - 1 (VCF pos is 1-based while
            // refSeq is 0-based from refSeqStartBp).
            const xa = genomePosCanonical(bp), xb = genomePosCanonical(bp + 1);
            const x = Math.min(xa, xb), w = Math.max(1, Math.abs(xb - xa));
            let base = "";
            if (refSeq && refSeq.length) {
              const idx = bp - refSeqStartBp - 1;
              if (idx >= 0 && idx < refSeq.length) base = String(refSeq[idx]).toUpperCase();
            }
            const rgb = nucleotideColors[base] || [127, 127, 127];
            // color block (kept visible), then a dramatic grey wash, then the
            // letter on top so it stays crisp under the wash.
            tracksSvg.appendChild(el("rect", { x: x, y: rowTop, width: w, height: rowH,
              fill: `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.92)` }));
            tracksSvg.appendChild(el("rect", { x: x, y: rowTop, width: w, height: rowH, fill: wash }));
            if (base && w > 5) {
              tracksSvg.appendChild(el("text", { x: x + w / 2, y: rowTop + rowH / 2,
                "text-anchor": "middle", "dominant-baseline": "middle",
                style: `fill:${baseLetterColor[base] || "#ffffff"};font-size:10px;font-weight:bold;` }, base));
            }
          }
          const sx = Math.min(genomePosCanonical(loBp), genomePosCanonical(hiBp + 1));
          const ex = Math.max(genomePosCanonical(loBp), genomePosCanonical(hiBp + 1));
          // strike-through + outline: reads as "these ref bases are deleted".
          tracksSvg.appendChild(el("line", { x1: sx, x2: ex, y1: rowTop + rowH / 2, y2: rowTop + rowH / 2,
            stroke: edge, "stroke-width": 1.5 }));
          tracksSvg.appendChild(el("rect", { x: sx, y: rowTop, width: Math.max(1, ex - sx), height: rowH,
            fill: "none", stroke: edge, "stroke-width": 1 }));
          tracksSvg.appendChild(el("text", { x: 4, y: rowTop + rowH / 2,
            "text-anchor": "start", "dominant-baseline": "middle",
            style: "fill: rgba(229,83,75,0.95); font-size:8px; font-weight:bold; letter-spacing:.04em;" }, "DEL"));
        });
      }
    }

    // Coordinate axis now rides the Reference track (merged from the old
    // Indel ruler): draw it just below the reference sequence band.
    if (isVertical) {
      drawGenomicAxis(referenceX + referenceW + 20, 0);
    } else {
      drawGenomicAxis(0, referenceY + referenceH + 22);
    }

    // Comment pins (defined in comments.js): comments are a baseline annotation,
    // so their markers ride the reference track rather than the Indel track.
    if (typeof window.__GS_renderCommentPins === "function") {
      try {
        window.__GS_renderCommentPins({
          svg: tracksSvg, el: el, genomePos: genomePos,
          baseX: referenceX + referenceW, baseY: referenceY, isVertical: isVertical,
        });
      } catch (e) {}
    }
  }

  // UCSC interval tracks (added on demand via the UCSC Tracks tab). Boxes go on
  // the WebGPU instanced renderer when available (fast for many features), with
  // an SVG-rect fallback; labels stay on SVG (bounded count, text-only).
  if (Array.isArray(state.ucscTracks) && state.ucscTracks.length) {
    const useWebGPU = webgpuSupported && instancedRenderer;
    const dpr = window.devicePixelRatio || 1;
    const boxColor = [0.169, 0.435, 1.0];   // ~#2b6fff
    const boxAlpha = 0.55;
    for (const item of layout) {
      const t = item.track;
      if (!t.id || t.id.indexOf("ucsc-") !== 0 || t.collapsed) continue;
      const entry = state.ucscTracks.find(u => u.id === t.id);
      if (!entry || !Array.isArray(entry.features)) continue;
      const h = Math.max(6, (item.contentHeight || 20) - 6);
      const yTop = item.contentTop + 3;
      for (const f of entry.features) {
        if (f.end <= state.startBp || f.start >= state.endBp) continue;
        const a = genomePos(Math.max(f.start, state.startBp));
        const b = genomePos(Math.min(f.end, state.endBp));
        if (isVertical) {
          const y0 = Math.min(a, b), y1 = Math.max(a, b);
          const x = item.contentLeft + 4, w = Math.max(6, (item.contentWidth || 20) - 8), hh = Math.max(1, y1 - y0);
          if (useWebGPU) instancedRenderer.addRect(x * dpr, y0 * dpr, w * dpr, hh * dpr, boxColor, boxAlpha);
          else tracksSvg.appendChild(el("rect", { x: x, y: y0, width: w, height: hh,
            rx: 2, fill: "var(--blue,#2b6fff)", "fill-opacity": 0.5, stroke: "var(--blue,#2b6fff)" }));
        } else {
          const x0 = Math.min(a, b), w = Math.max(1, Math.abs(b - a));
          if (useWebGPU) instancedRenderer.addRect(x0 * dpr, yTop * dpr, w * dpr, h * dpr, boxColor, boxAlpha);
          else tracksSvg.appendChild(el("rect", { x: x0, y: yTop, width: w, height: h,
            rx: 2, fill: "var(--blue,#2b6fff)", "fill-opacity": 0.5, stroke: "var(--blue,#2b6fff)" }));
          if (f.name && w > 30) {
            tracksSvg.appendChild(el("text", { x: x0 + 4, y: yTop + h / 2 + 3,
              fill: "var(--text)", "font-size": "9px" }, String(f.name).slice(0, 24)));
          }
        }
      }
    }
  }

  // Execute WebGPU render pass for tracks canvas (genes and repeats)
  const hasTracksInstances = instancedRenderer &&
      (instancedRenderer.rectInstances.length > 0 || 
       instancedRenderer.triangleInstances.length > 0 || 
       instancedRenderer.lineInstances.length > 0);
  if (webgpuSupported && instancedRenderer && hasTracksInstances) {
    try {
      // Update projection matrix for current canvas size
      const dpr = window.devicePixelRatio || 1;
      const width = tracksWebGPU.clientWidth * dpr;
      const height = tracksWebGPU.clientHeight * dpr;
      
      // Resize canvas if needed
      if (tracksWebGPU.width !== width || tracksWebGPU.height !== height) {
        tracksWebGPU.width = width;
        tracksWebGPU.height = height;
        webgpuCore.handleResize();
      }
      
      const encoder = webgpuCore.createCommandEncoder();
      const texture = webgpuCore.getCurrentTexture();
      const renderPass = encoder.beginRenderPass({
        colorAttachments: [{
          view: texture.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        }],
      });
      
      instancedRenderer.render(encoder, renderPass);
      renderPass.end();
      webgpuCore.submit([encoder.finish()]);
    } catch (error) {
      console.error("Tracks WebGPU render error:", error);
      // Fallback: clear instances and continue with SVG only
      instancedRenderer.clear();
    }
  } else if (webgpuSupported && instancedRenderer) {
    // Clear WebGPU canvas if no instances to render
    try {
      const dpr = window.devicePixelRatio || 1;
      const width = tracksWebGPU.clientWidth * dpr;
      const height = tracksWebGPU.clientHeight * dpr;
      
      if (tracksWebGPU.width !== width || tracksWebGPU.height !== height) {
        tracksWebGPU.width = width;
        tracksWebGPU.height = height;
        webgpuCore.handleResize();
      }
      
      const encoder = webgpuCore.createCommandEncoder();
      const texture = webgpuCore.getCurrentTexture();
      const renderPass = encoder.beginRenderPass({
        colorAttachments: [{
          view: texture.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        }],
      });
      renderPass.end();
      webgpuCore.submit([encoder.finish()]);
    } catch (error) {
      // Ignore errors when clearing
    }
  }
}
