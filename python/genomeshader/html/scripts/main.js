// Render a Smart track
// -----------------------------

// Render a Smart track
function renderSmartTrack(trackId) {
  const track = state.smartTracks.find(t => t.id === trackId);
  if (!track) return;
  
  const layout = getTrackLayout();
  const trackLayout = layout.find(l => l.track.id === trackId);
  
  // If hidden, don't render at all
  // Default to false for backwards compatibility
  if (!trackLayout || track.hidden === true) {
    const renderer = state.smartTrackRenderers.get(trackId);
    if (renderer) {
      // Hide the container
      if (renderer.container) {
        renderer.container.style.display = "none";
      }
      // Clear WebGPU renderer instances
      if (renderer.instancedRenderer) {
        renderer.instancedRenderer.clear();
      }
      // Clear Canvas2D canvas
      if (renderer.canvas) {
        const ctx = renderer.canvas.getContext("2d");
        if (ctx) {
          ctx.clearRect(0, 0, renderer.canvas.width, renderer.canvas.height);
        }
      }
    }
    return;
  }
  
  // If collapsed (closed state), still render but with limited height
  // (We'll handle the height in the layout calculation)
  
  const renderer = state.smartTrackRenderers.get(trackId);
  if (!renderer) return;
  
  const { canvas, webgpuCanvas, container, instancedRenderer, webgpuCore } = renderer;
  
  // Position container based on layout
  const isVertical = isVerticalMode();
  if (isVertical) {
    container.style.left = `${trackLayout.contentLeft}px`;
    container.style.width = `${trackLayout.contentWidth}px`;
    container.style.top = "0";
    container.style.height = "100%";
  } else {
    container.style.top = `${trackLayout.contentTop}px`;
    container.style.left = "0";
    container.style.width = "100%";
    container.style.height = `${trackLayout.contentHeight}px`;
  }
  // Ensure container is visible (we know it's not hidden here, but may be collapsed/closed)
  container.style.display = "block";
  
  if (!canvas || !webgpuCanvas) return;
  
  const dpr = window.devicePixelRatio || 1;
  
  // Get the actual rendered width of the container (not the layout width)
  // This is critical for overlay mode where the container width may differ from layout
  const containerRect = container.getBoundingClientRect();
  const actualContainerWidth = containerRect.width;
  const actualContainerHeight = containerRect.height;
  
  // Use actual container dimensions for both canvas sizing AND coordinate calculations
  // This ensures consistency between inline and overlay modes
  const W = isVertical ? actualContainerHeight : actualContainerWidth;
  let H = isVertical ? actualContainerWidth : actualContainerHeight;
  
  // Fallback to layout dimensions if container has no dimensions yet
  if (W <= 0 || isNaN(W)) {
    const layoutW = isVertical ? trackLayout.contentHeight : trackLayout.contentWidth;
    const layoutH = isVertical ? trackLayout.contentWidth : trackLayout.contentHeight;
    // Use layout dimensions as fallback
    return; // Skip rendering if no valid dimensions
  }
  
  // Calculate total content height if reads are loaded (horizontal mode)
  let totalContentHeight = H;
  if (!isVertical && track.readsLayout && track.readsLayout.reads && track.readsLayout.reads.length > 0) {
    // When collapsed (closed state), use minimal padding; otherwise use normal padding
    const top = track.collapsed ? 2 : 8;
    const bottom = track.collapsed ? 2 : 12;
    const rowH = 18;
    // If collapsed (closed state), limit to single row; otherwise use all rows
    const maxRows = track.collapsed ? 1 : (track.readsLayout.rowCount || Math.max(...track.readsLayout.reads.map(r => r.row)) + 1);
    totalContentHeight = top + maxRows * rowH + bottom;
    
    // Set up grid layout for scrolling
    // CRITICAL: Set explicit height FIRST (this overrides the CSS height: 100%)
    // Add scrollable class first so CSS height: auto takes effect
    if (totalContentHeight > H) {
      container.classList.add('scrollable');
    }
    
    // Set height with !important to override CSS height: 100%
    container.style.setProperty('height', `${trackLayout.contentHeight}px`, 'important');
    container.style.maxHeight = `${trackLayout.contentHeight}px`;
    container.style.minHeight = `${trackLayout.contentHeight}px`;
    container.style.overflowX = 'hidden';
    container.style.boxSizing = 'border-box';
    
    // Set up grid AFTER height is set
    container.style.display = 'grid';
    container.style.gridTemplateRows = '1fr';
    container.style.gridTemplateColumns = '1fr';
    
    // Set canvas dimensions - these need to be larger than container for scrolling
    canvas.height = totalContentHeight * dpr;
    canvas.style.height = totalContentHeight + 'px';
    canvas.style.width = W + 'px';
    canvas.style.gridRow = '1';
    canvas.style.gridColumn = '1';
    canvas.style.position = 'static';
    canvas.style.inset = 'auto';
    canvas.width = W * dpr;
    
    // Set WebGPU canvas dimensions to match regular canvas
    // Track previous dimensions BEFORE updating
    const prevWebGpuWidth = webgpuCanvas.width;
    const prevWebGpuHeight = webgpuCanvas.height;
    
    webgpuCanvas.width = W * dpr;
    webgpuCanvas.height = totalContentHeight * dpr;
    webgpuCanvas.style.height = totalContentHeight + 'px';
    webgpuCanvas.style.width = W + 'px';
    webgpuCanvas.style.gridRow = '1';
    webgpuCanvas.style.gridColumn = '1';
    webgpuCanvas.style.position = 'static';
    webgpuCanvas.style.inset = 'auto';
    
    // Notify WebGPU core of resize if dimensions changed
    // Compare against PREVIOUS dimensions, not current (which we just set)
    // Defer to next frame to ensure layout has settled (prevents flickering in overlay mode)
    if (webgpuCore && (prevWebGpuWidth !== W * dpr || prevWebGpuHeight !== totalContentHeight * dpr)) {
      // Use requestAnimationFrame to ensure container dimensions have settled
      // This is especially important in overlay mode where layout may be changing
      requestAnimationFrame(() => {
        // Verify dimensions are still valid before resizing
        const currentRect = container.getBoundingClientRect();
        const currentW = isVertical ? currentRect.height : currentRect.width;
        if (currentW > 0 && !isNaN(currentW)) {
          webgpuCore.handleResize();
        }
      });
    }
    
    // Enable overflow for scrolling when content exceeds container height
    if (totalContentHeight > H) {
      container.style.overflowY = 'auto';
      
      // Attach scroll and wheel handlers when container becomes scrollable
      // Check if handlers are already attached to avoid duplicates
      const renderer = state.smartTrackRenderers.get(trackId);
      if (renderer && !renderer.scrollHandlerAttached) {
        // Add scroll event listener
        const scrollHandler = () => {
          renderSmartTrack(trackId);
        };
        container.addEventListener("scroll", scrollHandler);
        
        // Add wheel event handler to allow native scrolling
        const smartTrackWheelHandler = (e) => {
          // Stop propagation to prevent main wheel handler from intercepting
          e.stopPropagation();
          // Allow native scrolling - don't prevent default
          // The scroll will happen naturally, and we'll re-render via scroll event
        };
        container.addEventListener("wheel", smartTrackWheelHandler, { passive: false });
        canvas.addEventListener("wheel", smartTrackWheelHandler, { passive: false });
        if (webgpuCanvas) {
          webgpuCanvas.addEventListener("wheel", smartTrackWheelHandler, { passive: false });
        }
        
        // Store handlers in renderer for cleanup
        renderer.scrollHandler = scrollHandler;
        renderer.wheelHandler = smartTrackWheelHandler;
        renderer.scrollHandlerAttached = true;
      }
    } else {
      container.classList.remove('scrollable');
      container.style.overflowY = 'hidden';
    }
    
    // Force a reflow to ensure layout is calculated
    void container.offsetHeight;
    
    // Verify container is scrollable after layout (only if we expect it to be scrollable)
    // Only check after a delay to ensure layout has settled
    if (totalContentHeight > H) {
      // Use setTimeout to check after layout has fully settled
      setTimeout(() => {
        const actualScrollHeight = container.scrollHeight;
        const actualClientHeight = container.clientHeight;
        // Only log error if container has dimensions but isn't scrollable
        // Don't log if dimensions are 0 - that means layout hasn't settled yet
        if (actualClientHeight > 0 && actualScrollHeight > 0) {
          if (actualScrollHeight <= actualClientHeight) {
            console.warn(`Smart track ${trackId}: Container should be scrollable but scrollHeight (${actualScrollHeight}) <= clientHeight (${actualClientHeight}). Total content: ${totalContentHeight}, container H: ${H}`);
          }
        }
      }, 100);
    }
  } else {
    // Ensure container is visible (for vertical mode or when no reads are loaded)
    container.style.display = "block";
    container.style.gridTemplateRows = '';
    container.style.gridTemplateColumns = '';
    container.classList.remove('scrollable');
    canvas.style.gridRow = '';
    canvas.style.gridColumn = '';
    webgpuCanvas.style.gridRow = '';
    webgpuCanvas.style.gridColumn = '';
    resizeCanvasTo(container, canvas);
    const rect = container.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      // Also set WebGPU canvas dimensions
      webgpuCanvas.width = rect.width * dpr;
      webgpuCanvas.height = rect.height * dpr;
      if (webgpuCore) {
        // Defer resize to next frame to ensure layout has settled (prevents flickering in overlay mode)
        requestAnimationFrame(() => {
          const currentRect = container.getBoundingClientRect();
          if (currentRect.width > 0 && currentRect.height > 0) {
            webgpuCore.handleResize();
          }
        });
      }
    }
  }
  
  const ctx = canvas.getContext("2d");
  ctx.setTransform(1,0,0,1,0,0);
  // Clear canvas - use the actual current dimensions to ensure full clear
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.scale(dpr, dpr);
  
  // Clear WebGPU renderer instances BEFORE drawing new content
  // This is critical when shuffling - old reads must be removed
  if (instancedRenderer) {
    instancedRenderer.clear();
  }
  
  const colText = cssVar("--muted");
  const grid = cssVar("--grid2");
  
  const bgHeight = (!isVertical && track.readsLayout && track.readsLayout.reads && track.readsLayout.reads.length > 0) ? totalContentHeight : H;
  ctx.fillStyle = "rgba(127,127,127,0.02)";
  ctx.fillRect(0,0,W,bgHeight);
  
  if (isVertical) {
    const coordHeight = H;
    const left = 8;
    const colW = 18;
    const cols = Math.floor((W - left - 12) / colW);
    
    // Draw column lines
    ctx.strokeStyle = grid;
    ctx.lineWidth = 1;
    for (let i=0; i<cols; i++) {
      const x = left + i*colW + colW/2;
      ctx.beginPath();
      ctx.moveTo(x, 16);
      ctx.lineTo(x, H-16);
      ctx.stroke();
    }
    
    // Draw reads if available
    if (track.readsLayout && track.readsLayout.reads && track.readsLayout.reads.length > 0) {
      const maxCols = Math.floor((W - left - 12) / colW);
      for (const read of track.readsLayout.reads) {
        // When collapsed (closed state), only show first row/column
        if (track.collapsed && read.row !== 0) continue;
        if (read.row >= maxCols) continue;
        if (read.end < state.startBp || read.start > state.endBp) continue;
        
        let color, alpha;
        if (read.haplotype === 1) {
          color = [255, 100, 100];
          alpha = 0.5;
        } else if (read.haplotype === 2) {
          color = [100, 100, 255];
          alpha = 0.5;
        } else {
          color = [150, 150, 150];
          alpha = 0.35;
        }
        if (!read.isForward) alpha *= 0.7;
        
        const y1 = yGenomeCanonical(read.start, coordHeight);
        const y2 = yGenomeCanonical(read.end, coordHeight);
        const x = left + read.row * colW + 2;
        const w = colW - 4;
        const y = Math.min(y1, y2);
        const h = Math.max(4, Math.abs(y2 - y1));
        
        if (instancedRenderer && webgpuSupported) {
          instancedRenderer.addRect(
            x * dpr, y * dpr,
            w * dpr, h * dpr,
            [color[0]/255, color[1]/255, color[2]/255, alpha]
          );
        } else {
          ctx.fillStyle = `rgba(${color[0]},${color[1]},${color[2]},${alpha})`;
          ctx.beginPath();
          roundRect(ctx, x, y, w, h, 3);
          ctx.fill();
        }
        
        // Draw insertion/deletion/diff markers (vertical mode)
        if (read.elements && read.elements.length > 0) {
          for (const elem of read.elements) {
            if (elem.start < state.startBp || elem.start > state.endBp) continue;
            const ey = yGenomeCanonical(elem.start, coordHeight);
            const ex = x;
            const ew = w;
            
            if (elem.type === 2) { // Insertion - purple tick
              ctx.fillStyle = 'rgba(200,100,255,0.9)';
              ctx.fillRect(ex, ey - 1, ew, 2);
            } else if (elem.type === 3) { // Deletion - black gap
              const ey2 = yGenomeCanonical(elem.end, coordHeight);
              const delY = Math.min(ey, ey2);
              const delH = Math.max(2, Math.abs(ey2 - ey));
              ctx.fillStyle = 'rgba(0,0,0,0.4)';
              ctx.fillRect(ex + ew/4, delY, ew/2, delH);
            } else if (elem.type === 1) { // Diff/mismatch - full base with nucleotide
              // Calculate actual base height
              const nextBp = elem.start + 1;
              const nextY = (nextBp <= state.endBp ? yGenomeCanonical(nextBp, coordHeight) : yGenomeCanonical(state.endBp, coordHeight));
              const actualBaseHeight = Math.max(2, Math.abs(nextY - ey));
              
              // Color based on nucleotide
              const nuc = elem.sequence ? elem.sequence.toUpperCase() : '?';
              const nucColors = { 'A': '#4CAF50', 'T': '#F44336', 'C': '#2196F3', 'G': '#FF9800' };
              const bgColor = nucColors[nuc] || '#9C27B0';
              
              // Draw background
              const drawHeight = Math.max(2, actualBaseHeight);
              ctx.fillStyle = bgColor;
              ctx.fillRect(ex + 1, ey - drawHeight/2, ew - 2, drawHeight);
              
              // Draw nucleotide letter only if there's enough space
              if (actualBaseHeight >= 8) {
                ctx.save();
                ctx.fillStyle = 'white';
                ctx.font = `bold ${Math.min(10, ew - 4)}px monospace`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                // Rotate text -90 degrees for vertical mode
                ctx.translate(ex + ew/2, ey);
                ctx.rotate(-Math.PI / 2);
                ctx.fillText(nuc, 0, 0);
                ctx.restore();
              }
            }
          }
        }
      }
    } else if (track.loading) {
      ctx.fillStyle = cssVar("--muted");
      ctx.font = "14px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Loading...", W/2, H/2);
    }
    
    // Draw variant markers
    for (let idx = 0; idx < variants.length; idx++) {
      const v = variants[idx];
      if (v.pos < state.startBp || v.pos > state.endBp) continue;
      const isHovered = (state.hoveredVariantId != null && v.id === state.hoveredVariantId) || state.hoveredVariantIndex === idx;
      ctx.strokeStyle = isHovered ? cssVar("--blue") : "rgba(127,127,127,0.3)";
      ctx.globalAlpha = isHovered ? 0.7 : 0.3;
      ctx.lineWidth = isHovered ? 2.5 : 1;
      const y = yGenomeCanonical(v.pos, coordHeight);
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(W-10, y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1.0;
  } else {
    // Horizontal mode
    // When collapsed (closed state), use minimal padding; otherwise use normal padding
    const top = track.collapsed ? 2 : 8;
    const bottom = track.collapsed ? 2 : 12;
    const rowH = 18;
    
    let totalRows = Math.floor((H - top - bottom) / rowH);
    if (track.readsLayout && track.readsLayout.reads && track.readsLayout.reads.length > 0) {
      // When collapsed (closed state), limit to single row
      totalRows = track.collapsed ? 1 : (track.readsLayout.rowCount || Math.max(...track.readsLayout.reads.map(r => r.row)) + 1);
      const scrollTop = container.scrollTop || 0;
      
      const startRow = Math.max(0, Math.floor(scrollTop / rowH) - 1);
      const endRow = Math.min(totalRows, Math.ceil((scrollTop + H) / rowH) + 1);
      
      ctx.strokeStyle = grid;
      ctx.lineWidth = 1;
      for (let i = startRow; i < endRow; i++) {
        const y = top + i*rowH + rowH/2;
        if (y >= -rowH && y <= totalContentHeight + rowH) {
          ctx.beginPath();
          ctx.moveTo(16, y);
          ctx.lineTo(W-16, y);
          ctx.stroke();
        }
      }
    } else {
      ctx.strokeStyle = grid;
      ctx.lineWidth = 1;
      const rows = Math.floor((H - top - bottom) / rowH);
      for (let i=0; i<rows; i++) {
        const y = top + i*rowH + rowH/2;
        ctx.beginPath();
        ctx.moveTo(16, y);
        ctx.lineTo(W-16, y);
        ctx.stroke();
      }
    }
    
    // Draw reads if available
    if (track.readsLayout && track.readsLayout.reads && track.readsLayout.reads.length > 0) {
      const scrollTop = container.scrollTop || 0;
      
      // Calculate visible row range for expanded state
      const startRow = Math.max(0, Math.floor(scrollTop / rowH) - 1);
      const endRow = Math.min(totalRows, Math.ceil((scrollTop + H) / rowH) + 1);
      
      // When collapsed, build overlap map for CIGAR elements only
      let elementOverlapMap = new Map(); // Map<genomicPosition, count>
      
      if (track.collapsed) {
        // Build overlap map for CIGAR elements
        for (const read of track.readsLayout.reads) {
          if (read.end < state.startBp || read.start > state.endBp) continue;
          
          // Track CIGAR element overlaps
          if (read.elements && read.elements.length > 0) {
            for (const elem of read.elements) {
              if (elem.start < state.startBp || elem.start > state.endBp) continue;
              
              if (elem.type === 2) { // Insertion - single position
                elementOverlapMap.set(elem.start, (elementOverlapMap.get(elem.start) || 0) + 1);
              } else if (elem.type === 3) { // Deletion - span from start to end
                for (let bp = elem.start; bp <= elem.end; bp++) {
                  if (bp >= state.startBp && bp <= state.endBp) {
                    elementOverlapMap.set(bp, (elementOverlapMap.get(bp) || 0) + 1);
                  }
                }
              } else if (elem.type === 1) { // Diff - single position
                elementOverlapMap.set(elem.start, (elementOverlapMap.get(elem.start) || 0) + 1);
              }
            }
          }
        }
        
        // Draw single pseudo-read spanning from first read start to last read end
        let minStart = Infinity;
        let maxEnd = -Infinity;
        for (const read of track.readsLayout.reads) {
          if (read.end < state.startBp || read.start > state.endBp) continue;
          minStart = Math.min(minStart, read.start);
          maxEnd = Math.max(maxEnd, read.end);
        }
        
        if (minStart !== Infinity && maxEnd !== -Infinity) {
          // Use simple linear transformation (self-consistent, no dependency on global state.pxPerBp)
          const leftPad = 16, rightPad = 16;
          const innerW = W - leftPad - rightPad;
          const span = state.endBp - state.startBp;
          const x1 = leftPad + ((minStart - state.startBp) / span) * innerW;
          const x2 = leftPad + ((maxEnd - state.startBp) / span) * innerW;
          
          const y = top + 0 * rowH + 2;
          const h = rowH - 4;
          const x = x1;
          const w = Math.max(4, x2 - x1);
          
          if (y + h >= 0 && y <= totalContentHeight) {
            // Draw pseudo-read with neutral gray color and high translucency
            const color = [150, 150, 150];
            const alpha = 0.15;
            
            if (instancedRenderer && webgpuSupported) {
              instancedRenderer.addRect(
                x * dpr, y * dpr,
                w * dpr, h * dpr,
                [color[0]/255, color[1]/255, color[2]/255, alpha]
              );
            } else {
              ctx.fillStyle = `rgba(${color[0]},${color[1]},${color[2]},${alpha})`;
              ctx.beginPath();
              roundRect(ctx, x, y, w, h, 3);
              ctx.fill();
            }
          }
        }
      } else {
        // Expanded state: Render individual reads
        for (const read of track.readsLayout.reads) {
          // Only show reads in visible rows
          if (read.row < startRow || read.row > endRow) continue;
          if (read.end < state.startBp || read.start > state.endBp) continue;
          
          let color, baseAlpha;
          if (read.haplotype === 1) {
            color = [255, 100, 100];
            baseAlpha = 0.5;
          } else if (read.haplotype === 2) {
            color = [100, 100, 255];
            baseAlpha = 0.5;
          } else {
            color = [150, 150, 150];
            baseAlpha = 0.35;
          }
          if (!read.isForward) baseAlpha *= 0.7;
          
          // Use simple linear transformation (self-consistent, no dependency on global state.pxPerBp)
          const leftPad = 16, rightPad = 16;
          const innerW = W - leftPad - rightPad;
          const span = state.endBp - state.startBp;
          const x1 = leftPad + ((read.start - state.startBp) / span) * innerW;
          const x2 = leftPad + ((read.end - state.startBp) / span) * innerW;
          
          const y = top + read.row * rowH + 2;
          const h = rowH - 4;
          
          // Calculate drawing position and width
          const x = x1;
          const w = Math.max(4, x2 - x1);
          
          if (y + h < 0 || y > totalContentHeight) continue;
          
          if (instancedRenderer && webgpuSupported) {
            instancedRenderer.addRect(
              x * dpr, y * dpr,
              w * dpr, h * dpr,
              [color[0]/255, color[1]/255, color[2]/255, baseAlpha]
            );
          } else {
            ctx.fillStyle = `rgba(${color[0]},${color[1]},${color[2]},${baseAlpha})`;
            ctx.beginPath();
            roundRect(ctx, x, y, w, h, 3);
            ctx.fill();
          }
          
          // Draw direction arrow
          ctx.fillStyle = `rgba(255,255,255,0.6)`;
          const arrowSize = Math.min(6, w * 0.2);
          if (read.isForward) {
            // Arrow pointing right
            ctx.beginPath();
            ctx.moveTo(x + w - arrowSize - 2, y + h/2 - arrowSize/2);
            ctx.lineTo(x + w - 2, y + h/2);
            ctx.lineTo(x + w - arrowSize - 2, y + h/2 + arrowSize/2);
            ctx.fill();
          } else {
            // Arrow pointing left
            ctx.beginPath();
            ctx.moveTo(x + arrowSize + 2, y + h/2 - arrowSize/2);
            ctx.lineTo(x + 2, y + h/2);
            ctx.lineTo(x + arrowSize + 2, y + h/2 + arrowSize/2);
            ctx.fill();
          }
        }
      }
      
      // Third pass: Render CIGAR elements (front layer) - drawn after reads
      for (const read of track.readsLayout.reads) {
        // When collapsed, process all reads; when expanded, only visible rows
        if (!track.collapsed && (read.row < startRow || read.row > endRow)) continue;
        if (read.end < state.startBp || read.start > state.endBp) continue;
        
        // When collapsed, draw all elements at the same y position (row 0)
        // When expanded, use the read's assigned row
        const y = track.collapsed ? (top + 0 * rowH + 2) : (top + read.row * rowH + 2);
        const h = rowH - 4;
        
        // Draw insertion/deletion/diff markers (horizontal mode)
        if (read.elements && read.elements.length > 0) {
          for (const elem of read.elements) {
            if (elem.start < state.startBp || elem.start > state.endBp) continue;
            const ex = xGenomeCanonical(elem.start, W);
            const ey = y;
            const eh = h;
            
            // Calculate base alpha for CIGAR elements (front layer - higher base opacity)
            let baseElemAlpha;
            if (elem.type === 2) { // Insertion
              baseElemAlpha = track.collapsed ? 0.25 : 0.9;
            } else if (elem.type === 3) { // Deletion
              baseElemAlpha = track.collapsed ? 0.2 : 0.4;
            } else { // Diff
              baseElemAlpha = track.collapsed ? 0.25 : 1.0;
            }
            
            // Accumulate opacity based on overlap when collapsed
            let elemAlpha = baseElemAlpha;
            if (track.collapsed) {
              let overlap = 0;
              if (elem.type === 2 || elem.type === 1) { // Insertion or Diff - single position
                overlap = elementOverlapMap.get(elem.start) || 0;
              } else if (elem.type === 3) { // Deletion - span
                // Average overlap across deletion span
                let totalOverlap = 0;
                let count = 0;
                for (let bp = elem.start; bp <= elem.end; bp++) {
                  if (bp >= state.startBp && bp <= state.endBp) {
                    totalOverlap += (elementOverlapMap.get(bp) || 0);
                    count++;
                  }
                }
                overlap = count > 0 ? totalOverlap / count : 0;
              }
              // Accumulate opacity: min(0.8, baseAlpha * (1 + overlapCount * 0.25))
              elemAlpha = Math.min(0.8, baseElemAlpha * (1 + (overlap - 1) * 0.25));
            }
            
            if (elem.type === 2) { // Insertion - purple tick
              ctx.fillStyle = `rgba(200,100,255,${elemAlpha})`;
              ctx.fillRect(ex - 1, ey, 2, eh);
            } else if (elem.type === 3) { // Deletion - black gap
              const ex2 = xGenomeCanonical(elem.end, W);
              ctx.fillStyle = `rgba(0,0,0,${elemAlpha})`;
              ctx.fillRect(ex, ey + eh/4, ex2 - ex, eh/2);
            } else if (elem.type === 1) { // Diff/mismatch - full base with nucleotide
              // Calculate actual base width
              const nextBp = elem.start + 1;
              const nextX = nextBp <= state.endBp ? xGenomeCanonical(nextBp, W) : xGenomeCanonical(state.endBp, W);
              const actualBaseWidth = Math.max(2, Math.abs(nextX - ex));
              
              // Color based on nucleotide
              const nuc = elem.sequence ? elem.sequence.toUpperCase() : '?';
              const nucColors = { 'A': '#4CAF50', 'T': '#F44336', 'C': '#2196F3', 'G': '#FF9800' };
              const bgColor = nucColors[nuc] || '#9C27B0';
              
              // Convert hex color to rgba with alpha
              const r = parseInt(bgColor.slice(1, 3), 16);
              const g = parseInt(bgColor.slice(3, 5), 16);
              const b = parseInt(bgColor.slice(5, 7), 16);
              
              // Draw background
              const drawWidth = Math.max(2, actualBaseWidth);
              ctx.fillStyle = `rgba(${r},${g},${b},${elemAlpha})`;
              ctx.fillRect(ex, ey + 1, drawWidth, eh - 2);
              
              // Draw nucleotide letter only if there's enough space
              if (actualBaseWidth >= 8) {
                ctx.fillStyle = 'white';
                ctx.font = `bold ${Math.min(10, eh - 4)}px monospace`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(nuc, ex + drawWidth/2, ey + eh/2);
              }
            }
          }
        }
      }
    } else if (track.loading) {
      ctx.fillStyle = cssVar("--muted");
      ctx.font = "14px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Loading...", W/2, H/2);
    }
    
    // Draw variant markers
    for (let idx = 0; idx < variants.length; idx++) {
      const v = variants[idx];
      if (v.pos < state.startBp || v.pos > state.endBp) continue;
      const isHovered = (state.hoveredVariantId != null && v.id === state.hoveredVariantId) || state.hoveredVariantIndex === idx;
      ctx.strokeStyle = isHovered ? cssVar("--blue") : "rgba(127,127,127,0.3)";
      ctx.globalAlpha = isHovered ? 0.7 : 0.3;
      ctx.lineWidth = isHovered ? 2.5 : 1;
      const x = xGenomeCanonical(v.pos, W);
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, totalContentHeight || H-10);
      ctx.stroke();
    }
    ctx.globalAlpha = 1.0;
  }
  
  // Execute WebGPU render pass
  if (webgpuSupported && instancedRenderer && 
      (instancedRenderer.rectInstances.length > 0 || instancedRenderer.lineInstances.length > 0)) {
    try {
      // Use the dimensions we already calculated and set above
      // For horizontal mode with reads, we already set webgpuCanvas.width and height above
      const width = webgpuCanvas.width || W * dpr;
      const height = webgpuCanvas.height || (isVertical ? H * dpr : totalContentHeight * dpr);
      
      // Ensure dimensions are valid
      if (width <= 0 || height <= 0 || isNaN(width) || isNaN(height)) {
        console.warn(`Smart track ${trackId}: Invalid WebGPU canvas dimensions (${width}x${height}), skipping render`);
        return;
      }
      
      // Check if canvas needs resize notification (dimensions might have changed)
      // Only call handleResize if dimensions actually changed from what WebGPU core knows
      const needsResize = webgpuCanvas.width !== width || webgpuCanvas.height !== height;
      if (needsResize && webgpuCore) {
        webgpuCanvas.width = width;
        webgpuCanvas.height = height;
        webgpuCore.handleResize();
        
        // Clear the canvas after resize to remove any leftover content from old dimensions
        const clearEncoder = webgpuCore.createCommandEncoder();
        const clearTexture = webgpuCore.getCurrentTexture();
        const clearPass = clearEncoder.beginRenderPass({
          colorAttachments: [{
            view: clearTexture.createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: 'clear',
            storeOp: 'store',
          }],
        });
        clearPass.end();
        webgpuCore.submit([clearEncoder.finish()]);
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
      console.error(`Smart track ${trackId} WebGPU render error:`, error);
      if (instancedRenderer) instancedRenderer.clear();
    }
  } else if (webgpuSupported && instancedRenderer) {
    // Clear WebGPU canvas if no instances
    try {
      // Ensure dimensions are correct before clearing
      const width = webgpuCanvas.clientWidth * dpr;
      let height = webgpuCanvas.clientHeight * dpr;
      if (!isVertical && track.readsLayout && track.readsLayout.reads && track.readsLayout.reads.length > 0) {
        height = totalContentHeight * dpr;
      }
      
      if (webgpuCanvas.width !== width || webgpuCanvas.height !== height) {
        webgpuCanvas.width = width;
        webgpuCanvas.height = height;
        // Defer resize to next frame to ensure layout has settled (prevents flickering in overlay mode)
        requestAnimationFrame(() => {
          const currentRect = container.getBoundingClientRect();
          if (currentRect.width > 0 && currentRect.height > 0) {
            webgpuCore.handleResize();
          }
        });
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

// -----------------------------
// Track controls rendering
// -----------------------------

// Helper function to truncate long paths by removing middle portion
function truncatePath(path, maxLength = 60) {
  if (!path || path.length <= maxLength) {
    return path;
  }
  
  const ellipsis = "[...]";
  const ellipsisLength = ellipsis.length;
  
  // Calculate how much space we have for start and end after ellipsis
  const availableLength = maxLength - ellipsisLength;
  const startLength = Math.floor(availableLength * 0.4);
  const endLength = Math.floor(availableLength * 0.6); // Give slightly more to end (filename)
  
  if (startLength + endLength + ellipsisLength >= path.length) {
    return path; // Can't truncate meaningfully
  }
  
  const start = path.substring(0, startLength);
  const end = path.substring(path.length - endLength);
  return `${start}${ellipsis}${end}`;
}

// Helper function to extract basename from a path or URL
function getBasename(path) {
  if (!path) return '';
  
  // Handle URLs (gs://, http://, https://, file://)
  let pathPart = path;
  if (path.includes('://')) {
    // For URLs, get the part after the protocol and domain
    const urlMatch = path.match(/:\/\/[^\/]+(\/.+)$/);
    if (urlMatch) {
      pathPart = urlMatch[1];
    } else {
      // If no path part, return the full URL
      return path;
    }
  }
  
  // Extract basename (last part after last /)
  const parts = pathPart.split('/');
  return parts[parts.length - 1] || path;
}

const trackControls = document.getElementById("trackControls");
// Standard tracks that have hover-only controls
const STANDARD_TRACKS = ["ideogram", "genes", "repeats", "reference", "ruler", "flow"];
function isFlowTrack(trackId) {
  return trackId === "flow" || (typeof trackId === "string" && trackId.startsWith("flow-"));
}

function renderTrackControls() {
  trackControls.innerHTML = "";
  const layout = getTrackLayout();
  const isVertical = isVerticalMode();

  for (const item of layout) {
    const track = item.track;
    const container = document.createElement("div");
    container.className = "track-control-container";
    
    // Check if this is a standard track - limit container to controls area only
    const isStandardTrack = STANDARD_TRACKS.includes(track.id) || isFlowTrack(track.id);
    
    if (isVertical) {
      container.style.position = "absolute";
      container.style.left = `${item.left}px`;
      container.style.width = `${item.width}px`;
      container.style.top = "0";
      // Container should cover full track height to allow resize handle at bottom
      // Controls are positioned absolutely at top, so they only occupy their space
      container.style.height = track.collapsed ? "24px" : "100%";
    } else {
      container.style.position = "absolute";
      container.style.left = "0";
      container.style.right = "0";
      container.style.top = `${item.top}px`;
      // Container should cover full track height to allow resize handle at bottom
      // Controls are positioned absolutely at top, so they only occupy their space
      container.style.height = track.collapsed ? "24px" : `${item.height}px`;
    }
    container.dataset.trackId = track.id;

    const controls = document.createElement("div");
    controls.className = "track-controls";
    controls.dataset.trackId = track.id;
    
    // Check if this is a Smart track (declare once for this track)
    const isSmartTrack = track.id.startsWith("smart-track-");
    
    // Hide controls when track is hidden or collapsed (for standard tracks only)
    // Smart tracks show controls even when collapsed (closed state)
    // Default hidden to false for backwards compatibility
    if ((track.hidden === true) || (!isSmartTrack && track.collapsed)) {
      controls.style.display = "none";
      controls.style.pointerEvents = "none";
    }

    const collapseBtn = document.createElement("button");
    collapseBtn.className = "track-collapse-btn";
    
    if (isSmartTrack) {
      // For Smart Tracks: collapsed = closed (single read), !collapsed = open (full height)
      if (isVertical) {
        collapseBtn.textContent = track.collapsed ? "▲" : "▶";
      } else {
        collapseBtn.textContent = track.collapsed ? "▶" : "▼";
      }
      collapseBtn.title = track.collapsed ? "Expand to full height" : "Collapse to single read";
    } else {
      // For standard tracks: use existing behavior
      if (isVertical) {
        collapseBtn.textContent = track.collapsed ? "▲" : "▶";
      } else {
        collapseBtn.textContent = track.collapsed ? "▶" : "▼";
      }
    }
    
    collapseBtn.type = "button";
    collapseBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      track.collapsed = !track.collapsed;
      updateTracksHeight();
      renderAll();
    });

    const label = document.createElement("div");
    label.className = "track-label";
    
    // Declare labelInput and labelSpacer at higher scope so they're accessible in both Smart Track blocks
    // (isSmartTrack is already declared above)
    let labelInput = null;
    let labelSpacer = null;
    
    if (isSmartTrack) {
      // Make label editable for Smart tracks
      label.style.cursor = "text";
      label.contentEditable = false;
      label.title = "Click to edit label";
      
      // Create input field for editing (hidden initially)
      labelInput = document.createElement("input");
      labelInput.type = "text";
      labelInput.className = "smart-track-label-input";
      labelInput.value = track.label;
      labelInput.style.display = "none";
      labelInput.style.fontSize = "12px";
      labelInput.style.fontWeight = "600";
      labelInput.style.color = "var(--muted)";
      labelInput.style.background = "transparent";
      labelInput.style.border = "1px solid var(--border2)";
      labelInput.style.borderRadius = "4px";
      labelInput.style.padding = "2px 4px";
      labelInput.style.width = "auto";
      labelInput.style.minWidth = "100px";
      labelInput.style.maxWidth = "200px";
      
      // Create invisible spacer to maintain flex space when label is hidden
      labelSpacer = document.createElement("span");
      labelSpacer.className = "smart-track-label-spacer";
      labelSpacer.style.display = "none"; // Hidden by default (label is visible)
      labelSpacer.style.flex = "1";
      labelSpacer.style.minWidth = "0";
      
      // Click handler to start editing - attach to the text span, not the label
      // (The label has pointer-events: none, so we attach to the clickable span)
      const attachLabelClickHandler = () => {
        const labelTextSpan = label.querySelector(".smart-track-label-text");
        if (labelTextSpan) {
          labelTextSpan.addEventListener("click", (e) => {
            e.stopPropagation();
            label.style.display = "none"; // Hide label
            labelSpacer.style.display = "block"; // Show spacer to maintain flex space
            labelInput.style.display = "block"; // Show input
            collapseBtn.style.display = "none"; // Hide collapse button during editing
            labelInput.focus();
            labelInput.select();
          });
        }
      };
      // Attach handler after label content is created
      setTimeout(attachLabelClickHandler, 0);
      
      // Save on blur or Enter
      const saveLabel = () => {
        const newLabel = labelInput.value.trim() || track.label;
        
        // Rebuild label
        label.innerHTML = "";
        // Wrap main text in a span so only the text content is clickable (not the entire flex area)
        const labelTextSpan = document.createElement("span");
        labelTextSpan.textContent = newLabel;
        labelTextSpan.className = "smart-track-label-text";
        label.appendChild(labelTextSpan);
        
        label.style.display = ""; // Show label again
        labelSpacer.style.display = "none"; // Hide spacer (label is visible)
        labelInput.style.display = "none";
        collapseBtn.style.display = ""; // Show collapse button again
        editSmartTrackLabel(track.id, newLabel);
        // Reattach click handler after rebuilding label
        attachLabelClickHandler();
      };
      
      labelInput.addEventListener("blur", saveLabel);
      labelInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          saveLabel();
        } else if (e.key === "Escape") {
          e.preventDefault();
          labelInput.value = track.label;
          
          // Rebuild label
          label.innerHTML = "";
          // Wrap main text in a span so only the text content is clickable (not the entire flex area)
          const labelTextSpan = document.createElement("span");
          labelTextSpan.textContent = track.label;
          labelTextSpan.className = "smart-track-label-text";
          label.appendChild(labelTextSpan);
          
          label.style.display = ""; // Show label again
          labelSpacer.style.display = "none"; // Hide spacer (label is visible)
          labelInput.style.display = "none";
          collapseBtn.style.display = ""; // Show collapse button again
          // Reattach click handler after rebuilding label
          attachLabelClickHandler();
        }
      });
      
      // Create label content
      // Wrap main text in a span so only the text content is clickable (not the entire flex area)
      const labelTextSpan = document.createElement("span");
      labelTextSpan.textContent = track.label;
      labelTextSpan.className = "smart-track-label-text";
      label.appendChild(labelTextSpan);
    } else {
      // For the Locus track, append the extent in parentheses
      if (track.id === "ruler") {
        const extent = Math.floor(state.endBp) - Math.floor(state.startBp);
        label.textContent = `${track.label} (${extent.toLocaleString()} bp)`;
      } else {
        label.textContent = track.label;
      }
    }

    // Add Smart track controls if needed
    if (isSmartTrack) {
      // Hidden checkbox (show/hide track)
      const hiddenCheckbox = document.createElement("input");
      hiddenCheckbox.type = "checkbox";
      hiddenCheckbox.className = "smart-track-hidden-checkbox";
      hiddenCheckbox.checked = !track.hidden;
      hiddenCheckbox.title = track.hidden ? "Show track" : "Hide track";
      hiddenCheckbox.style.width = "18px";
      hiddenCheckbox.style.height = "18px";
      hiddenCheckbox.style.marginLeft = "6px";
      hiddenCheckbox.style.cursor = "pointer";
      hiddenCheckbox.style.pointerEvents = "auto";
      hiddenCheckbox.style.zIndex = "20";
      hiddenCheckbox.style.verticalAlign = "middle";
      hiddenCheckbox.style.marginTop = "0";
      hiddenCheckbox.style.marginBottom = "0";
      hiddenCheckbox.addEventListener("change", (e) => {
        e.stopPropagation();
        e.preventDefault();
        track.hidden = !hiddenCheckbox.checked;
        const trackInArray = state.tracks.find(t => t.id === track.id);
        if (trackInArray) {
          trackInArray.hidden = track.hidden;
        }
        updateTracksHeight();
        renderAll();
        // Update sidebar checkbox to stay in sync
        renderSmartTracksSidebar();
      });
      
      // Reload button (reload current sample)
      const reloadBtn = document.createElement("button");
      reloadBtn.className = "smart-track-reload-btn";
      reloadBtn.textContent = "↻";
      reloadBtn.title = "Reload sample";
      reloadBtn.type = "button";
      reloadBtn.style.fontSize = "16px";
      reloadBtn.style.padding = "0";
      reloadBtn.style.border = "1px solid var(--border2)";
      reloadBtn.style.borderRadius = "4px";
      reloadBtn.style.background = "var(--panel)";
      reloadBtn.style.color = "var(--muted)";
      reloadBtn.style.cursor = "pointer";
      reloadBtn.style.marginLeft = "6px";
      reloadBtn.style.width = "18px";
      reloadBtn.style.height = "18px";
      reloadBtn.style.display = "flex";
      reloadBtn.style.alignItems = "center";
      reloadBtn.style.justifyContent = "center";
      reloadBtn.style.lineHeight = "1";
      reloadBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        reloadSmartTrack(track.id);
      });
      reloadBtn.style.pointerEvents = "auto";
      reloadBtn.style.zIndex = "20";
      
      // Shuffle button (choose new sample)
      const shuffleBtn = document.createElement("button");
      shuffleBtn.className = "smart-track-shuffle-btn";
      shuffleBtn.textContent = "⇆";
      shuffleBtn.title = "Shuffle to new sample";
      shuffleBtn.type = "button";
      shuffleBtn.style.fontSize = "16px";
      shuffleBtn.style.padding = "0";
      shuffleBtn.style.border = "1px solid var(--border2)";
      shuffleBtn.style.borderRadius = "4px";
      shuffleBtn.style.background = "var(--panel)";
      shuffleBtn.style.color = "var(--muted)";
      shuffleBtn.style.cursor = "pointer";
      shuffleBtn.style.marginLeft = "6px";
      shuffleBtn.style.width = "18px";
      shuffleBtn.style.height = "18px";
      shuffleBtn.style.display = "flex";
      shuffleBtn.style.alignItems = "center";
      shuffleBtn.style.justifyContent = "center";
      shuffleBtn.style.lineHeight = "1";
      shuffleBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        shuffleSmartTrack(track.id);
      });
      shuffleBtn.style.pointerEvents = "auto";
      shuffleBtn.style.zIndex = "20";
      
      // Close button
      const closeBtn = document.createElement("button");
      closeBtn.className = "smart-track-close-btn";
      closeBtn.textContent = "✕";  // Use heavy multiplication x for better centering
      closeBtn.title = "Close track";
      closeBtn.type = "button";
      closeBtn.style.fontSize = "16px";
      closeBtn.style.padding = "0";
      closeBtn.style.border = "1px solid var(--border2)";
      closeBtn.style.borderRadius = "4px";
      closeBtn.style.background = "var(--panel)";
      closeBtn.style.color = "var(--muted)";
      closeBtn.style.cursor = "pointer";
      closeBtn.style.marginLeft = "6px";
      closeBtn.style.width = "18px";
      closeBtn.style.height = "18px";
      closeBtn.style.display = "flex";
      closeBtn.style.alignItems = "center";
      closeBtn.style.justifyContent = "center";
      closeBtn.style.lineHeight = "1";
      closeBtn.style.pointerEvents = "auto";
      closeBtn.style.zIndex = "20";
      closeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        // Verify track still exists before removing
        const trackExists = state.smartTracks.find(t => t.id === track.id);
        if (trackExists) {
          removeSmartTrack(track.id);
        }
      });
      
      // In vertical mode, reverse order: label on top, button on bottom
      if (isVertical) {
        controls.appendChild(label);
        controls.appendChild(labelSpacer); // Spacer maintains flex space when label is hidden
        controls.appendChild(labelInput);
        controls.appendChild(hiddenCheckbox);
        controls.appendChild(reloadBtn);
        controls.appendChild(shuffleBtn);
        controls.appendChild(closeBtn);
        controls.appendChild(collapseBtn);
        container.appendChild(controls);
      } else {
        controls.appendChild(collapseBtn);
        controls.appendChild(label);
        controls.appendChild(labelSpacer); // Spacer maintains flex space when label is hidden
        controls.appendChild(labelInput);
        controls.appendChild(hiddenCheckbox);
        controls.appendChild(reloadBtn);
        controls.appendChild(shuffleBtn);
        controls.appendChild(closeBtn);
        container.appendChild(controls);
      }
    } else {
      // In vertical mode, reverse order: label on top, button on bottom
      if (isVertical) {
        controls.appendChild(label);
        controls.appendChild(collapseBtn);
        container.appendChild(controls);
        // After appending, measure the label's width and adjust transform
        // With transform-origin: left center, the first character stays at bottom
        // We need to translate right by half width to center it horizontally
        setTimeout(() => {
          try {
            const width = label.offsetWidth || label.getBoundingClientRect().width;
            if (width > 0) {
              // After -90deg rotation:
              // - translateX moves vertically (negative = up, positive = down)
              // - translateY moves horizontally (negative = left, positive = right)
              // Use translateX(12px) to position vertically and translateY(0.0px) for horizontal
              label.style.transform = `rotate(-90deg) translateX(12px) translateY(0.0px)`;
            }
          } catch (e) {
            console.error('Error adjusting label transform:', e);
          }
        }, 10);
      } else {
        controls.appendChild(collapseBtn);
        controls.appendChild(label);
        container.appendChild(controls);
      }
    }

    if (!track.collapsed) {
      const resizeHandle = document.createElement("div");
      resizeHandle.className = "track-resize-handle";
      resizeHandle.dataset.trackId = track.id;
      container.appendChild(resizeHandle);
    } else if (!isSmartTrack) {
      // For standard tracks (including flow-N): add collapsed indicator and make clickable
      // Smart Tracks handle collapsed state differently (closed = single read, still visible)
      // Mark container as collapsed for CSS styling
      container.classList.add("track-collapsed");
      
      // Store track reference on container for easy access
      container._trackRef = track;
      
      // Expand function - use the track from the container to ensure we have the right reference
      const expandTrack = (e) => {
        e.stopPropagation();
        e.preventDefault();
        // Get track from state to ensure we have the latest reference
        const trackToExpand = state.tracks.find(t => t.id === track.id);
        if (trackToExpand && trackToExpand.collapsed) {
          trackToExpand.collapsed = false;
          updateTracksHeight();
          renderAll();
        }
      };
      
      // Make the entire container clickable when collapsed
      container.style.cursor = "pointer";
      container.style.pointerEvents = "auto";
      container.title = `Click to expand ${track.label}`;
      // Use capture phase to ensure we catch the click before anything else
      container.addEventListener("click", expandTrack, true);
      // Also add mousedown as backup
      container.addEventListener("mousedown", (e) => {
        if (e.button === 0) { // Left click only
          expandTrack(e);
        }
      }, true);
      
      // Add collapsed track indicator - always visible clickable line/bar
      const collapsedIndicator = document.createElement("div");
      collapsedIndicator.className = "track-collapsed-indicator";
      collapsedIndicator.dataset.trackId = track.id;
      collapsedIndicator.title = `Click to expand ${track.label}`;
      collapsedIndicator.style.cursor = "pointer";
      collapsedIndicator.style.pointerEvents = "auto";
      collapsedIndicator._trackRef = track; // Store reference on indicator too
      // Also add click handler directly to indicator as backup
      collapsedIndicator.addEventListener("click", expandTrack, true);
      collapsedIndicator.addEventListener("mousedown", (e) => {
        if (e.button === 0) { // Left click only
          expandTrack(e);
        }
      }, true);
      container.appendChild(collapsedIndicator);
    }
    // For Smart Tracks when collapsed (closed state), we don't add collapsed indicator
    // They still render their content with reduced height (handled in renderSmartTrack)

    // Add hover listeners for standard tracks to show/hide controls
    // Skip hover detection for collapsed tracks - they expand on click
    if ((STANDARD_TRACKS.includes(track.id) || isFlowTrack(track.id)) && !track.collapsed) {
      // Mark container for standard track styling
      container.classList.add("standard-track");
      
      // Add a small hover detection area at the top (24px) for hover detection
      // This allows clicks to pass through to track content below
      const hoverArea = document.createElement("div");
      hoverArea.className = "track-hover-area";
      if (isVertical) {
        hoverArea.style.position = "absolute";
        hoverArea.style.left = "0";
        hoverArea.style.top = "0";
        hoverArea.style.width = "24px";
        hoverArea.style.height = "100%";
      } else {
        hoverArea.style.position = "absolute";
        hoverArea.style.left = "0";
        hoverArea.style.top = "0";
        hoverArea.style.width = "100%";
        hoverArea.style.height = "24px";
      }
      container.appendChild(hoverArea);
      
      // Setup hover detection - only show controls when hovering over controls area
      const setupHoverDetection = () => {
        // Show controls when hovering over hover area (top 24px)
        hoverArea.addEventListener("mouseenter", () => {
          container.classList.add("track-hovered");
        });
        
        hoverArea.addEventListener("mouseleave", () => {
          container.classList.remove("track-hovered");
        });
        
        // Also handle hover on controls themselves
        controls.addEventListener("mouseenter", () => {
          container.classList.add("track-hovered");
        });
        
        controls.addEventListener("mouseleave", () => {
          container.classList.remove("track-hovered");
        });
      };
      
      // Setup after a short delay to ensure DOM is ready
      setTimeout(setupHoverDetection, 100);
    } else if ((STANDARD_TRACKS.includes(track.id) || isFlowTrack(track.id)) && track.collapsed) {
      // For collapsed standard tracks, mark as standard but don't set up hover
      // This ensures proper styling but prevents controls from showing
      container.classList.add("standard-track");
    }

    trackControls.appendChild(container);
  }
}

// -----------------------------
// HUD + renderAll
// -----------------------------
let hudHideTimeout = null;

function renderHUD() {
  const locusText = `${state.contig}:${Math.floor(state.startBp).toLocaleString()}-${Math.floor(state.endBp).toLocaleString()}`;
  hud.textContent = locusText;

  // In inline mode, show HUD and auto-hide after 3 seconds
  if (hostMode === 'inline') {
    hud.classList.add('visible');

    // Clear any existing timeout
    if (hudHideTimeout) {
      clearTimeout(hudHideTimeout);
    }

    // Set new timeout to hide HUD after 3 seconds
    hudHideTimeout = setTimeout(() => {
      hud.classList.remove('visible');
      hudHideTimeout = null;
    }, 3000);
  }
}

function updateTooltip() {
  if (state.hoveredRepeatTooltip) {
    tooltip.textContent = state.hoveredRepeatTooltip.text;
    tooltip.style.left = state.hoveredRepeatTooltip.x + 'px';
    tooltip.style.top = state.hoveredRepeatTooltip.y + 'px';
    tooltip.classList.add('visible');
  } else if (state.hoveredVariantLabelTooltip) {
    tooltip.textContent = state.hoveredVariantLabelTooltip.text;
    tooltip.style.left = state.hoveredVariantLabelTooltip.x + 'px';
    tooltip.style.top = state.hoveredVariantLabelTooltip.y + 'px';
    tooltip.classList.add('visible');
  } else if (state.hoveredAlleleNodeTooltip) {
    tooltip.textContent = state.hoveredAlleleNodeTooltip.text;
    tooltip.style.left = state.hoveredAlleleNodeTooltip.x + 'px';
    tooltip.style.top = state.hoveredAlleleNodeTooltip.y + 'px';
    tooltip.classList.add('visible');
  } else {
    tooltip.classList.remove('visible');
  }
}

// Throttle utility for mousemove handlers (16ms = ~60fps)
function throttle(func, delay) {
  let lastCall = 0;
  let timeoutId = null;
  return function(...args) {
    const now = Date.now();
    const timeSinceLastCall = now - lastCall;
    
    if (timeSinceLastCall >= delay) {
      lastCall = now;
      func.apply(this, args);
    } else {
      // Clear any pending timeout
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
      // Schedule call for after delay
      timeoutId = setTimeout(() => {
        lastCall = Date.now();
        func.apply(this, args);
      }, delay - timeSinceLastCall);
    }
  };
}

// Debounce utility for ResizeObserver callbacks (100ms delay)
function debounce(func, delay) {
  let timeoutId = null;
  return function(...args) {
    // Clear any pending timeout
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
    // Schedule call for after delay
    timeoutId = setTimeout(() => {
      func.apply(this, args);
    }, delay);
  };
}

// Update Locus track variant element hover styles (use hoveredVariantId so multi-track ruler works)
function updateLocusTrackHover() {
  state.locusVariantElements.forEach((elements, idx) => {
    const variantId = elements.lineEl && elements.lineEl.getAttribute("data-variant-id");
    const isHovered = (state.hoveredVariantId != null && variantId != null && String(state.hoveredVariantId) === String(variantId)) || state.hoveredVariantIndex === idx;
    const strokeWidth = isHovered ? 2.5 : 1.2;
    const circleStrokeWidth = isHovered ? 2.2 : 1.4;
    const strokeColor = isHovered ? "var(--blue)" : "rgba(127,127,127,0.5)";
    
    if (elements.lineEl) {
      elements.lineEl.setAttribute("stroke", strokeColor);
      elements.lineEl.setAttribute("stroke-width", strokeWidth);
    }
    if (elements.circleEl) {
      elements.circleEl.setAttribute("stroke", strokeColor);
      elements.circleEl.setAttribute("stroke-width", circleStrokeWidth);
    }
  });
}

// Helpers for multi-track variant hover: flat list of all variants (ruler order) and index/by-id lookup
function getRulerVariants() {
  const variantTracksConfig = (window.GENOMESHADER_CONFIG && window.GENOMESHADER_CONFIG.variant_tracks) || [];
  return variantTracksConfig.length > 0
    ? variantTracksConfig.flatMap(t => t.variants_data || [])
    : variants;
}
function getRulerVariantIndex(variantId) {
  const rulerVariants = getRulerVariants();
  const idx = rulerVariants.findIndex(v => String(v.id) === String(variantId));
  return idx >= 0 ? idx : null;
}
function findVariantById(variantId) {
  const rulerVariants = getRulerVariants();
  return rulerVariants.find(v => String(v.id) === String(variantId)) || null;
}
function getFlowBands() {
  const layout = getTrackLayout();
  const variantTracksConfig = (window.GENOMESHADER_CONFIG && window.GENOMESHADER_CONFIG.variant_tracks) || [];
  const isVertical = isVerticalMode();
  const bands = [];
  if (variantTracksConfig.length > 0) {
    let bandOffset = 0;
    for (let i = 0; i < variantTracksConfig.length; i++) {
      const trackConfig = variantTracksConfig[i];
      const trackLayout = layout.find(l => l.track.id === trackConfig.id);
      if (!trackLayout || trackLayout.track.collapsed) continue;
      const bandHeight = isVertical ? trackLayout.contentWidth : trackLayout.contentHeight;
      bands.push({ track: trackConfig, flowLayout: trackLayout, bandOffset, bandHeight });
      bandOffset += bandHeight;
    }
  }
  return bands;
}

function makeVariantOrderKeyCompat(trackId, variantId) {
  return window.makeVariantOrderKey
    ? window.makeVariantOrderKey(trackId, variantId)
    : String(variantId);
}

function makeAlleleSelectionKeyCompat(trackId, variantId, alleleIndex) {
  return window.makeAlleleSelectionKey
    ? window.makeAlleleSelectionKey(trackId, variantId, alleleIndex)
    : `${variantId}:${alleleIndex}`;
}

function parseAlleleSelectionKeyCompat(key) {
  if (window.parseAlleleSelectionKey) {
    return window.parseAlleleSelectionKey(key);
  }
  const idx = String(key).lastIndexOf(":");
  if (idx <= 0) return null;
  return {
    trackId: "",
    variantId: String(key).slice(0, idx),
    alleleIndex: parseInt(String(key).slice(idx + 1), 10)
  };
}

function getVariantTrackById(trackId) {
  const variantTracksConfig = (window.GENOMESHADER_CONFIG && window.GENOMESHADER_CONFIG.variant_tracks) || [];
  return variantTracksConfig.find(t => String(t.id) === String(trackId)) || null;
}

function findVariantByTrackAndId(trackId, variantId) {
  if (trackId) {
    const track = getVariantTrackById(trackId);
    const fromTrack = track && Array.isArray(track.variants_data)
      ? track.variants_data.find(v => String(v.id) === String(variantId))
      : null;
    if (fromTrack) return fromTrack;
  }
  return findVariantById(variantId);
}

function flowTrackDomId(trackId) {
  return `flow-track-${encodeURIComponent(String(trackId || ""))}`;
}

function flowCanvasDomId(trackId) {
  return `flowCanvas-${encodeURIComponent(String(trackId || ""))}`;
}

function findFlowTrackElementByTrackId(trackId) {
  if (!flow) return null;
  const target = String(trackId || "");
  const tracks = flow.querySelectorAll(".flow-track");
  for (const el of tracks) {
    if ((el.dataset.trackId || "") === target) return el;
  }
  return null;
}

// Set up variant hover areas in canvas overlays
function setupVariantHoverAreas() {
  if (!flowOverlay) return;
  
  const isVertical = isVerticalMode();
  const clearSvg = (svg) => { while (svg.firstChild) svg.removeChild(svg.firstChild); };
  
  // Shared click handler for variant selection (variant may be from any track)
  const handleVariantRectClick = (e, trackId, variantId) => {
    e.stopPropagation();
    
    const variant = findVariantByTrackAndId(trackId, variantId);
    if (!variant) return;
    
    // Get all alleles for this variant (getFormattedLabelsForVariant is from interaction.js)
    const getFormattedLabels = window.getFormattedLabelsForVariant;
    if (!getFormattedLabels) return;
    const { labels } = getFormattedLabels(variant);
    const variantOrderKey = makeVariantOrderKeyCompat(trackId, variant.id);
    let order = state.variantAlleleOrder.get(variantOrderKey);
    if (!order || order.length !== labels.length) {
      order = [...labels];
      state.variantAlleleOrder.set(variantOrderKey, order);
    }
    
    // Create label keys for all alleles in this track/variant.
    const variantAlleleKeys = order.map((label, alleleIndex) =>
      makeAlleleSelectionKeyCompat(trackId, variant.id, alleleIndex)
    );
    
    // Handle selection with Ctrl/Cmd for multi-select
    if (e.ctrlKey || e.metaKey) {
      // Multi-select: toggle all alleles for this variant
      const allSelected = variantAlleleKeys.every(key => state.selectedAlleles.has(key));
      if (allSelected) {
        // All are selected, deselect all
        variantAlleleKeys.forEach(key => state.selectedAlleles.delete(key));
      } else {
        // Not all are selected, select all
        variantAlleleKeys.forEach(key => state.selectedAlleles.add(key));
      }
    } else {
      // Single-select: replace selection with all alleles for this variant
      // If clicking on already-selected variant (all alleles selected), deselect it
      const allSelected = variantAlleleKeys.every(key => state.selectedAlleles.has(key));
      if (allSelected && state.selectedAlleles.size === variantAlleleKeys.length) {
        state.selectedAlleles.clear();
      } else {
        state.selectedAlleles.clear();
        variantAlleleKeys.forEach(key => state.selectedAlleles.add(key));
      }
    }
    
    renderFlowCanvas();
    if (window.updateSelectionDisplay) window.updateSelectionDisplay();
  };
  
  // Clear existing hover areas
  clearSvg(flowOverlay);
  
  // Set overlay dimensions to match containers
  const flowW = flowWidthPx();
  const flowH = flowHeightPx();
  
  flowOverlay.setAttribute("width", flowW);
  flowOverlay.setAttribute("height", flowH);
  flowOverlay.setAttribute("viewBox", `0 0 ${flowW} ${flowH}`);
  
  const variantMode = getVariantLayoutMode();
  const flowBands = getFlowBands();
  const multiTrack = flowBands.length > 1;
  
  // Hover handlers (used by both multi-track per-overlay and single-track shared overlay)
  const handleVariantHover = (e) => {
    const target = e.target;
    const variantId = target.getAttribute("data-variant-id");
    if (!variantId) return;
    state.hoveredVariantId = variantId;
    const variantIdx = getRulerVariantIndex(variantId);
    if (state.hoveredVariantIndex !== variantIdx) {
      state.hoveredVariantIndex = variantIdx;
      renderHoverOnly();
    } else {
      renderHoverOnly();
    }
  };
  const handleVariantLeave = (e) => {
    const target = e.target;
    if (target.hasAttribute("data-variant-id")) {
      if (state.hoveredVariantIndex !== null || state.hoveredVariantId !== null) {
        state.hoveredVariantIndex = null;
        state.hoveredVariantId = null;
        renderHoverOnly();
      }
    }
  };
  
  if (multiTrack) {
    // Per-track overlays so variant click works in every track (first track was blocked by shared overlay stacking)
    flowOverlay.style.pointerEvents = "none";
    flowOverlay.innerHTML = "";
    const junctionY = 18;
    const junctionX = 70;
    for (const band of flowBands) {
      const bandVariants = band.track.variants_data || [];
      const win = typeof visibleVariantWindowFor === "function" ? visibleVariantWindowFor(bandVariants) : bandVariants.filter(v => v.pos >= state.startBp && v.pos <= state.endBp);
      const bandSize = band.bandHeight;
      const trackEl = findFlowTrackElementByTrackId(band.track.id);
      const bandOverlay = trackEl ? trackEl.querySelector(".flow-track-overlay") : null;
      if (!bandOverlay) continue;
      clearSvg(bandOverlay);
      if (isVertical) {
        bandOverlay.setAttribute("width", bandSize);
        bandOverlay.setAttribute("height", flowH);
        bandOverlay.setAttribute("viewBox", `0 0 ${bandSize} ${flowH}`);
      } else {
        bandOverlay.setAttribute("width", flowW);
        bandOverlay.setAttribute("height", bandSize);
        bandOverlay.setAttribute("viewBox", `0 0 ${flowW} ${bandSize}`);
      }
      bandOverlay.style.pointerEvents = "auto";
      // Pass-through rect so clicks in the allele area go to the canvas (for per-allele selection/drag)
      const passThrough = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      if (isVertical) {
        passThrough.setAttribute("x", junctionX);
        passThrough.setAttribute("y", 0);
        passThrough.setAttribute("width", Math.max(0, bandSize - junctionX - 10));
        passThrough.setAttribute("height", flowH);
      } else {
        passThrough.setAttribute("x", 0);
        passThrough.setAttribute("y", junctionY);
        passThrough.setAttribute("width", flowW);
        passThrough.setAttribute("height", Math.max(0, bandSize - junctionY));
      }
      passThrough.setAttribute("fill", "transparent");
      passThrough.style.pointerEvents = "none";
      bandOverlay.appendChild(passThrough);
      // Variant rects only in the label strip so allele-area clicks pass through to canvas hit test.
      if (isVertical) {
        const labelX = 0;
        const labelW = Math.min(30, Math.max(0, bandSize));
        for (let i = 0; i < win.length; i++) {
          const v = win[i];
          const cy = variantMode === "genomic"
            ? yGenomeCanonical(v.pos, flowH)
            : yColumn(i, win.length);
          const hoverRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
          hoverRect.setAttribute("x", labelX);
          hoverRect.setAttribute("y", Math.max(0, cy - 8));
          hoverRect.setAttribute("width", labelW);
          hoverRect.setAttribute("height", 16);
          hoverRect.setAttribute("fill", "transparent");
          hoverRect.setAttribute("data-variant-id", v.id);
          hoverRect.style.cursor = "pointer";
          hoverRect.style.pointerEvents = "auto";
          hoverRect.addEventListener("click", (e) => handleVariantRectClick(e, band.track.id, v.id));
          bandOverlay.appendChild(hoverRect);
        }
      } else {
        for (let i = 0; i < win.length; i++) {
          const v = win[i];
          const cx = variantMode === "genomic"
            ? xGenomeCanonical(v.pos, flowW)
            : xColumn(i, win.length);
          const hoverRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
          hoverRect.setAttribute("x", cx - 8);
          hoverRect.setAttribute("y", 0);
          hoverRect.setAttribute("width", 16);
          hoverRect.setAttribute("height", junctionY);
          hoverRect.setAttribute("fill", "transparent");
          hoverRect.setAttribute("data-variant-id", v.id);
          hoverRect.style.cursor = "pointer";
          hoverRect.style.pointerEvents = "auto";
          hoverRect.addEventListener("click", (e) => handleVariantRectClick(e, band.track.id, v.id));
          bandOverlay.appendChild(hoverRect);
        }
      }
      // Hover delegation on this band's overlay
      bandOverlay._variantHoverHandler = handleVariantHover;
      bandOverlay._variantLeaveHandler = handleVariantLeave;
      bandOverlay.removeEventListener("mouseenter", bandOverlay._variantHoverHandler, true);
      bandOverlay.removeEventListener("mouseleave", bandOverlay._variantLeaveHandler, true);
      bandOverlay.addEventListener("mouseenter", handleVariantHover, true);
      bandOverlay.addEventListener("mouseleave", handleVariantLeave, true);
    }
  } else {
    flowOverlay.style.pointerEvents = "";
  }
  
  if (!multiTrack) {
    // Single track: pass-through in content area so allele clicks work; variant rects only in label strip
    const junctionYSingle = 18;
    const junctionXSingle = 70;
    const passThroughSingle = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    if (isVertical) {
      passThroughSingle.setAttribute("x", junctionXSingle);
      passThroughSingle.setAttribute("y", 0);
      passThroughSingle.setAttribute("width", Math.max(0, flowW - junctionXSingle - 10));
      passThroughSingle.setAttribute("height", flowH);
    } else {
      passThroughSingle.setAttribute("x", 0);
      passThroughSingle.setAttribute("y", junctionYSingle);
      passThroughSingle.setAttribute("width", flowW);
      passThroughSingle.setAttribute("height", Math.max(0, flowH - junctionYSingle));
    }
    passThroughSingle.setAttribute("fill", "transparent");
    passThroughSingle.style.pointerEvents = "none";
    flowOverlay.appendChild(passThroughSingle);
    const win = visibleVariantWindow();
    if (isVertical) {
      const labelX = 0;
      const labelW = Math.min(30, Math.max(0, flowW));
      for (let i = 0; i < win.length; i++) {
        const v = win[i];
        const variantIdx = variants.findIndex(v2 => v2.id === v.id);
        if (variantIdx === -1) continue;
        const cy = variantMode === "genomic"
          ? yGenomeCanonical(v.pos, flowH)
          : yColumn(i, win.length);
        const hoverRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        hoverRect.setAttribute("x", labelX);
        hoverRect.setAttribute("y", Math.max(0, cy - 8));
        hoverRect.setAttribute("width", labelW);
        hoverRect.setAttribute("height", 16);
        hoverRect.setAttribute("fill", "transparent");
        hoverRect.setAttribute("data-variant-id", v.id);
        hoverRect.style.cursor = "pointer";
        hoverRect.style.pointerEvents = "auto";
        hoverRect.addEventListener("click", (e) => handleVariantRectClick(e, "", v.id));
        flowOverlay.appendChild(hoverRect);
      }
    } else {
      for (let i = 0; i < win.length; i++) {
        const v = win[i];
        const variantIdx = state.firstVariantIndex + i;
        if (variantIdx >= variants.length) continue;
        const variant = variants[variantIdx];
        const cx = variantMode === "genomic"
          ? xGenomeCanonical(v.pos, flowW)
          : xColumn(i, win.length);
        const hoverRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        hoverRect.setAttribute("x", cx - 8);
        hoverRect.setAttribute("y", 0);
        hoverRect.setAttribute("width", 16);
        hoverRect.setAttribute("height", junctionYSingle);
        hoverRect.setAttribute("fill", "transparent");
        hoverRect.setAttribute("data-variant-id", variant.id);
        hoverRect.style.cursor = "pointer";
        hoverRect.style.pointerEvents = "auto";
        hoverRect.addEventListener("click", (e) => handleVariantRectClick(e, "", variant.id));
        flowOverlay.appendChild(hoverRect);
      }
    }
  }
  
  // Remove old listeners if they exist (for hover only, clicks are now on rectangles)
  if (flowOverlay._variantHoverHandler) {
    flowOverlay.removeEventListener("mouseenter", flowOverlay._variantHoverHandler, true);
    flowOverlay.removeEventListener("mouseleave", flowOverlay._variantLeaveHandler, true);
  }
  flowOverlay._variantHoverHandler = null;
  flowOverlay._variantLeaveHandler = null;
  
  // Single-track: use shared overlay for hover; multi-track uses per-track overlays (already set up above)
  if (!multiTrack) {
    flowOverlay._variantHoverHandler = handleVariantHover;
    flowOverlay._variantLeaveHandler = handleVariantLeave;
    flowOverlay.addEventListener("mouseenter", handleVariantHover, true);
    flowOverlay.addEventListener("mouseleave", handleVariantLeave, true);
  }
}

// Selective rendering for hover-only state changes (no SVG rebuild)
function renderHoverOnly() {
  // Only redraw canvas elements affected by hover state
  // Skip expensive SVG rebuilds and layout recalculations
  updateLocusTrackHover(); // Update Locus track SVG hover styles
  renderFlowCanvas();
  // Render all Smart tracks to update variant highlights
  state.smartTracks.forEach(track => {
    renderSmartTrack(track.id);
  });
  updateTooltip();
}

function renderAll() {
  updateDerived();
  updateTracksHeight();
  renderTracks();
  renderTrackControls();
  updateFlowAndReadsPosition();
  renderFlowCanvas();
  // Render all Smart tracks in the order they appear in state.tracks
  const smartTracksInOrder = state.tracks
    .filter(t => t.id.startsWith('smart-track-'))
    .map(t => state.smartTracks.find(st => st.id === t.id))
    .filter(st => st !== undefined);
  smartTracksInOrder.forEach(track => {
    renderSmartTrack(track.id);
  });
  renderHUD();
  updateTooltip();
  setupCanvasHover();
  setupVariantHoverAreas(); // Set up ID-based hover areas
  updateDocumentTitle();
}

// Hit testing for WebGPU-rendered repeats (only add listeners once)
if (tracksWebGPU && !tracksWebGPU._tooltipListenersAdded) {
  tracksWebGPU._tooltipListenersAdded = true;
  const tracksWebGPUHoverHandler = (e) => {
    if (!webgpuSupported || repeatHitTestData.length === 0) return;
    
    const rect = tracksWebGPU.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const isVertical = isVerticalMode();
    
    // Get RepeatMasker track layout to restrict hit testing to track bounds
    const layout = getTrackLayout();
    const repeatsLayout = layout.find(l => l.track.id === "repeats");
    if (!repeatsLayout || repeatsLayout.track.collapsed) return;
    
    let repeatsY, repeatsH;
    if (isVertical) {
      repeatsY = 16;
      repeatsH = tracksWidthPx() - 32; // W - 32 in vertical mode
    } else {
      repeatsY = repeatsLayout.contentTop + 8;
      repeatsH = 22;
    }
    
    // Only do hit testing if mouse is within RepeatMasker track bounds
    if (isVertical) {
      // In vertical mode, check X coordinate (genomic axis is vertical)
      const repeatsX = repeatsLayout.contentLeft + 8;
      const repeatsW = 22;
      if (x < repeatsX || x > repeatsX + repeatsW) {
        state.hoveredRepeatTooltip = null;
        updateTooltip();
        return;
      }
    } else {
      // In horizontal mode, check Y coordinate
      if (y < repeatsY || y > repeatsY + repeatsH) {
        state.hoveredRepeatTooltip = null;
        updateTooltip();
        return;
      }
    }
    
    // Convert mouse coordinates to genome position
    let bp;
    if (isVertical) {
      const H = tracksHeightPx();
      bp = bpFromYGenome(y, H);
    } else {
      const W = tracksWidthPx();
      bp = bpFromXGenome(x, W);
    }
    
    // Find overlapping repeat (check against original coordinates)
    const hitRepeat = repeatHitTestData.find(r => 
      bp >= r.start && bp <= r.end
    );
    
    if (hitRepeat) {
      state.hoveredRepeatTooltip = {
        text: `${hitRepeat.cls} repeat\n${Math.floor(hitRepeat.start).toLocaleString()} - ${Math.floor(hitRepeat.end).toLocaleString()}`,
        x: e.clientX + 10,
        y: e.clientY + 10
      };
    } else {
      state.hoveredRepeatTooltip = null;
    }
    updateTooltip();
  };
  
  // Throttle mousemove handler to 16ms (60fps)
  const throttledTracksWebGPUHoverHandler = throttle(tracksWebGPUHoverHandler, 16);
  tracksWebGPU.addEventListener('mousemove', throttledTracksWebGPUHoverHandler);
  
  tracksWebGPU.addEventListener('mouseleave', () => {
    state.hoveredRepeatTooltip = null;
    updateTooltip();
  });
}

// Setup hover detection for canvas elements
let flowHoverHandler = null;
let flowLeaveHandler = null;

function setupCanvasHover() {
  // Remove existing listeners to avoid duplicates
  if (flowHoverHandler) {
    flow.removeEventListener("mousemove", flowHoverHandler);
    flow.removeEventListener("mouseleave", flowLeaveHandler);
  }

  // Flow canvas hover detection
  flowHoverHandler = (e) => {
    const rect = flow.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const isVertical = isVerticalMode();
    const variantMode = getVariantLayoutMode();
    const flowBands = getFlowBands();
    const multiTrack = flowBands.length > 1;
    
    if (isVertical) {
      const junctionX = 40;
      const H = flowHeightPx();
      
      // Check if mouse is over a variant label
      if (window._variantLabelPositions && window._variantLabelPositions.length > 0) {
        for (const labelPos of window._variantLabelPositions) {
          // In vertical mode, labels are rotated 90 degrees at x=14
          // Check if mouse is near the label position (y coordinate) and in the label area (x < 30)
          const labelY = labelPos.y;
          const labelHeight = labelPos.height; // This is the font size (12px)
          if (Math.abs(y - labelY) < labelHeight && x >= 0 && x <= 30) {
            // Show tooltip with all IDs (comma-delimited)
            if (labelPos.allIds && labelPos.allIds.length > 0) {
              state.hoveredVariantLabelTooltip = {
                text: labelPos.allIds.join(', '),
                x: e.clientX + 10,
                y: e.clientY + 10
              };
              updateTooltip();
            } else {
              state.hoveredVariantLabelTooltip = null;
              updateTooltip();
            }
            return;
          }
        }
      }
      
      // Check if mouse is near a column line or diagonal connector (vertical mode); per-band when multi-track (vertical mode: bands stacked along x)
      const x0 = 6;
      const bandsToTestVertical = multiTrack
        ? flowBands.filter(b => x >= b.bandOffset && x < b.bandOffset + b.bandHeight)
        : [{ track: { variants_data: variants }, bandOffset: 0, bandHeight: H }];
      for (const band of bandsToTestVertical) {
        const bandVariants = band.track.variants_data || [];
        const win = multiTrack && typeof visibleVariantWindowFor === "function"
          ? visibleVariantWindowFor(bandVariants)
          : visibleVariantWindow();
        const sortedWin = [...win].sort((a, b) => a.pos - b.pos);
        for (let i = 0; i < sortedWin.length; i++) {
          const v = sortedWin[i];
          const cy = variantMode === "genomic"
            ? yGenomeCanonical(v.pos, H)
            : yColumn(i, sortedWin.length);
          const variantIdx = getRulerVariantIndex(v.id);
          if (variantIdx == null) continue;
          if (Math.abs(y - cy) < 10 && x >= junctionX) {
            if (state.hoveredVariantIndex !== variantIdx || state.hoveredVariantId !== v.id) {
              state.hoveredVariantIndex = variantIdx;
              state.hoveredVariantId = v.id;
              renderHoverOnly();
            }
            state.hoveredVariantLabelTooltip = null;
            updateTooltip();
            return;
          }
        }
        for (let i = 0; i < sortedWin.length; i++) {
          const v = sortedWin[i];
          if (v.pos < state.startBp || v.pos > state.endBp) continue;
          const vy = yGenomeCanonical(v.pos, H);
          const cy = variantMode === "genomic"
            ? yGenomeCanonical(v.pos, H)
            : yColumn(i, sortedWin.length);
          const variantIdx = getRulerVariantIndex(v.id);
          if (variantIdx == null) continue;
          const dist = Math.abs((x - x0) * (cy - vy) / (junctionX - x0) + vy - y);
          if (dist < 5 && x >= x0 && x <= junctionX) {
            if (state.hoveredVariantIndex !== variantIdx || state.hoveredVariantId !== v.id) {
              state.hoveredVariantIndex = variantIdx;
              state.hoveredVariantId = v.id;
              renderHoverOnly();
            }
            state.hoveredVariantLabelTooltip = null;
            updateTooltip();
            return;
          }
        }
      }
    } else {
      const junctionY = 40;
      const W = flowWidthPx();
      
      // Check if mouse is over a variant label
      if (window._variantLabelPositions && window._variantLabelPositions.length > 0) {
        for (const labelPos of window._variantLabelPositions) {
          // In horizontal mode, labels are at the top (y=14)
          if (x >= labelPos.x && x <= labelPos.x + labelPos.width &&
              y >= labelPos.y && y <= labelPos.y + labelPos.height) {
            // Show tooltip with all IDs (comma-delimited)
            if (labelPos.allIds && labelPos.allIds.length > 0) {
              state.hoveredVariantLabelTooltip = {
                text: labelPos.allIds.join(', '),
                x: e.clientX + 10,
                y: e.clientY + 10
              };
              updateTooltip();
            } else {
              state.hoveredVariantLabelTooltip = null;
              updateTooltip();
            }
            return;
          }
        }
      }
      
      // Check if mouse is near a column line or diagonal connector (horizontal mode); per-band when multi-track
      const y0 = 6;
      const bandsToTestHorizontal = multiTrack
        ? flowBands.filter(b => y >= b.bandOffset && y < b.bandOffset + b.bandHeight)
        : [{ track: { variants_data: variants }, bandOffset: 0, bandHeight: flowHeightPx() }];
      for (const band of bandsToTestHorizontal) {
        const bandVariants = band.track.variants_data || [];
        const win = multiTrack && typeof visibleVariantWindowFor === "function"
          ? visibleVariantWindowFor(bandVariants)
          : visibleVariantWindow();
        for (let i = 0; i < win.length; i++) {
          const v = win[i];
          const cx = variantMode === "genomic"
            ? xGenomeCanonical(v.pos, W)
            : xColumn(i, win.length);
          const variantIdx = getRulerVariantIndex(v.id);
          if (variantIdx == null) continue;
          const yInBand = y - band.bandOffset;
          if (yInBand >= junctionY && Math.abs(x - cx) < 10) {
            if (state.hoveredVariantIndex !== variantIdx || state.hoveredVariantId !== v.id) {
              state.hoveredVariantIndex = variantIdx;
              state.hoveredVariantId = v.id;
              renderHoverOnly();
            }
            state.hoveredVariantLabelTooltip = null;
            updateTooltip();
            return;
          }
        }
        for (let i = 0; i < win.length; i++) {
          const v = win[i];
          if (v.pos < state.startBp || v.pos > state.endBp) continue;
          const vx = xGenomeCanonical(v.pos, W);
          const cx = variantMode === "genomic"
            ? xGenomeCanonical(v.pos, W)
            : xColumn(i, win.length);
          const variantIdx = getRulerVariantIndex(v.id);
          if (variantIdx == null) continue;
          const yInBand = y - band.bandOffset;
          const dist = Math.abs((yInBand - y0) * (cx - vx) / (junctionY - y0) + vx - x);
          if (dist < 5 && yInBand >= y0 && yInBand <= junctionY) {
            if (state.hoveredVariantIndex !== variantIdx || state.hoveredVariantId !== v.id) {
              state.hoveredVariantIndex = variantIdx;
              state.hoveredVariantId = v.id;
              renderHoverOnly();
            }
            state.hoveredVariantLabelTooltip = null;
            updateTooltip();
            return;
          }
        }
      }
    }
    
    // No variant hovered
    if (state.hoveredVariantIndex !== null || state.hoveredVariantId !== null) {
      state.hoveredVariantIndex = null;
      state.hoveredVariantId = null;
      renderHoverOnly();
    }
    // Clear variant label tooltip when not hovering anything
    if (state.hoveredVariantLabelTooltip !== null) {
      state.hoveredVariantLabelTooltip = null;
      updateTooltip();
    }
  };
  
  flowLeaveHandler = () => {
    if (state.hoveredVariantIndex !== null || state.hoveredVariantId !== null || state.hoveredAlleleNode !== null) {
      state.hoveredVariantIndex = null;
      state.hoveredVariantId = null;
      state.hoveredAlleleNode = null;
      state.hoveredAlleleNodeTooltip = null;
      renderHoverOnly();
      updateTooltip();
    }
    // Clear variant label tooltip when leaving flow canvas
    if (state.hoveredVariantLabelTooltip !== null) {
      state.hoveredVariantLabelTooltip = null;
      updateTooltip();
    }
  };
  
  flow.addEventListener("mousemove", flowHoverHandler);
  flow.addEventListener("mouseleave", flowLeaveHandler);
  
  // Variant label click-to-pin handler
  let variantLabelClickHandler = null;
  function setupVariantLabelClick() {
    if (variantLabelClickHandler) {
      flow.removeEventListener("click", variantLabelClickHandler);
      if (flowWebGPU) flowWebGPU.removeEventListener("click", variantLabelClickHandler);
    }
    
    variantLabelClickHandler = (e) => {
      // Only handle clicks if not dragging alleles
      if (state.alleleDragState) return;
      
      const rect = flow.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      
      // Check if we clicked on a variant label
      if (!window._variantLabelPositions || window._variantLabelPositions.length === 0) return;
      
      const isVertical = isVerticalMode();
      
      for (const labelPos of window._variantLabelPositions) {
        let clicked = false;
        if (isVertical) {
          // In vertical mode, labels are rotated 90 degrees at x=14
          // Check if click is near the label position (y coordinate) and in the label area (x < 30)
          const labelY = labelPos.y;
          const labelHeight = labelPos.height; // This is the font size (12px)
          if (Math.abs(y - labelY) < labelHeight && x >= 0 && x <= 30) {
            clicked = true;
          }
        } else {
          // In horizontal mode, labels are at the top (y=14)
          if (x >= labelPos.x && x <= labelPos.x + labelPos.width &&
              y >= labelPos.y && y <= labelPos.y + labelPos.height) {
            clicked = true;
          }
        }
        
        if (clicked) {
          // Toggle pinned state
          if (state.pinnedVariantLabels.has(labelPos.variantId)) {
            state.pinnedVariantLabels.delete(labelPos.variantId);
          } else {
            state.pinnedVariantLabels.add(labelPos.variantId);
          }
          renderFlowCanvas();
          e.stopPropagation();
          return;
        }
      }
    };
    
    flow.addEventListener("click", variantLabelClickHandler);
    if (flowWebGPU) flowWebGPU.addEventListener("click", variantLabelClickHandler);
  }
  
  setupVariantLabelClick();
  
  // Allele node drag-and-drop handlers
  let alleleMouseDownHandler = null;
  let alleleMouseMoveHandler = null;
  let alleleMouseUpHandler = null;
  
  function setupAlleleDragDrop() {
    // Remove existing listeners from both possible targets
    if (alleleMouseDownHandler) {
      if (flow) flow.removeEventListener("mousedown", alleleMouseDownHandler);
      if (flowWebGPU) flowWebGPU.removeEventListener("mousedown", alleleMouseDownHandler);
      document.removeEventListener("mousemove", alleleMouseMoveHandler);
      document.removeEventListener("mouseup", alleleMouseUpHandler);
    }
    
    // With multiple variant tracks, flowWebGPU has pointer-events: none; attach to flow so overlays' events bubble here
    const variantTracks = (window.GENOMESHADER_CONFIG && window.GENOMESHADER_CONFIG.variant_tracks) || [];
    const targetElement = variantTracks.length > 1 ? flow : (flowWebGPU || flow);
    const getTrackIdAtClientPoint = (clientX, clientY) => {
      const el = document.elementFromPoint(clientX, clientY);
      const trackEl = el && el.closest ? el.closest(".flow-track") : null;
      return trackEl ? String(trackEl.dataset.trackId || "") : "";
    };
    const filterNodesByTrack = (nodes, trackId) => {
      if (!trackId) return nodes;
      const filtered = nodes.filter(n => String(n.trackId || "") === trackId);
      return filtered.length > 0 ? filtered : nodes;
    };
    
    alleleMouseDownHandler = (e) => {
      if (!window._alleleNodePositions || window._alleleNodePositions.length === 0) return;
      
      // Use flow container for coordinates (same coordinate system as flowCanvas)
      const rect = flow.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const activeTrackId = getTrackIdAtClientPoint(e.clientX, e.clientY);
      const allNodes = window._alleleNodePositions;
      const nodesToTest = filterNodesByTrack(allNodes, activeTrackId);
      const tryStartDragForNodes = (nodes) => {
        for (const node of nodes) {
          if (x >= node.x && x <= node.x + node.w &&
              y >= node.y && y <= node.y + node.h) {
            e.preventDefault();
            e.stopPropagation();
            state.alleleDragState = {
              trackId: node.trackId || "",
              variantId: node.variantId,
              alleleIndex: node.alleleIndex,
              label: node.label,
              startX: x,
              startY: y,
              offsetX: 0,
              offsetY: 0,
              isClick: true // Track if this might be a click (not a drag)
            };
            flowCanvas.style.cursor = "grabbing";
            if (flowWebGPU) flowWebGPU.style.cursor = "grabbing";
            return true;
          }
        }
        return false;
      };
      
      // Find which node was clicked
      if (tryStartDragForNodes(nodesToTest)) return;
      if (nodesToTest !== allNodes) {
        tryStartDragForNodes(allNodes);
      }
    };
    
    alleleMouseMoveHandler = (e) => {
      const rect = flow.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const activeTrackId = getTrackIdAtClientPoint(e.clientX, e.clientY);
      const nodesToTest = filterNodesByTrack(window._alleleNodePositions || [], activeTrackId);
      
      if (state.alleleDragState) {
        // Handle drag
        state.alleleDragState.offsetX = x - state.alleleDragState.startX;
        state.alleleDragState.offsetY = y - state.alleleDragState.startY;
        
        // If moved more than 5 pixels, it's a drag, not a click
        const dragDistance = Math.sqrt(
          Math.pow(state.alleleDragState.offsetX, 2) + 
          Math.pow(state.alleleDragState.offsetY, 2)
        );
        if (dragDistance > 5) {
          state.alleleDragState.isClick = false;
        }
      
      // Calculate drop position to show indicator
      const dragState = state.alleleDragState;
      const variantOrderKey = makeVariantOrderKeyCompat(dragState.trackId, dragState.variantId);
      const order = state.variantAlleleOrder.get(variantOrderKey);
      if (order) {
        const isVertical = isVerticalMode();
        const variantMode = getVariantLayoutMode();
        const variantTrack = getVariantTrackById(dragState.trackId);
        const dragTrackVariants = (variantTrack && Array.isArray(variantTrack.variants_data))
          ? variantTrack.variants_data
          : variants;
        const win = dragTrackVariants.filter(v => v.pos >= state.startBp && v.pos <= state.endBp);
        const constants = window._alleleNodeConstants || { baseNodeW: 4, baseNodeH: 14, gap: 8, MIN_NODE_SIZE: 4 };
        const gap = constants.gap;
        const MIN_NODE_SIZE = constants.MIN_NODE_SIZE;
        const baseNodeW = constants.baseNodeW;
        const baseNodeH = constants.baseNodeH;
        
        // Find the variant to get its allele frequencies
        const v = isVertical 
          ? [...win].sort((a, b) => a.pos - b.pos).find(v => v.id === dragState.variantId)
          : win.find(v => v.id === dragState.variantId);
        
        // Declare newIndex in this scope so it's accessible after the if (v) block
        let newIndex = -1;
        
        if (v) {
          // Get track dimension for size calculation
          const layout = getTrackLayout();
          const flowLayout = layout.find(l => l.track.id === "flow") || layout.find(l => l.track.id && l.track.id.startsWith("flow-"));
          const trackDimension = isVertical 
            ? (flowLayout ? flowLayout.contentWidth : 300)
            : (flowLayout ? flowLayout.contentHeight : 300);
          
          // Calculate allele sizes for this variant
          const calculateAlleleSizesFn = window.calculateAlleleSizes;
          const alleleSizes = calculateAlleleSizesFn 
            ? calculateAlleleSizesFn(v, trackDimension, MIN_NODE_SIZE, gap, order.length)
            : {}; // Fallback to empty if function not available
          
          // Map labels to allele keys
          const formatAlleleLabelFn = window.formatAlleleLabel || function(allele) {
            if (!allele || allele === ".") return ". (no-call)";
            const length = allele.length;
            const lengthLabel = length === 1 ? "1 bp" : `${length} bp`;
            return `${allele} (${lengthLabel})`;
          };
          const noCallLabel = formatAlleleLabelFn(".");
          const refLabel = v.refAllele ? formatAlleleLabelFn(v.refAllele) : null;
          function getAlleleKey(label) {
            if (label === noCallLabel) return ".";
            if (label === refLabel) return "ref";
            if (v.altAlleles && Array.isArray(v.altAlleles)) {
              const altIndex = v.altAlleles.findIndex(alt => formatAlleleLabelFn(alt) === label);
              if (altIndex >= 0) return `a${altIndex + 1}`;
            }
            return ".";
          }
          
          // Calculate margin (same as in calculateAlleleSizes)
          const marginPercent = 0.1;
          const minMargin = 10;
          const margin = Math.max(minMargin, trackDimension * marginPercent);
          if (isVertical) {
            const left = 70;
            const W = flowWidthPx();
            const cy = variantMode === "genomic"
              ? yGenomeCanonical(v.pos, flowHeightPx())
              : yColumn(isVertical ? [...win].sort((a, b) => a.pos - b.pos).findIndex(v2 => v2.id === v.id) : win.findIndex(v2 => v2.id === v.id), isVertical ? [...win].sort((a, b) => a.pos - b.pos).length : win.length);
            
            // Calculate total width and horizontal offset for centering
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
            const availableWidth = W - left - margin;
            const horizontalOffset = Math.max(0, (availableWidth - totalNodesWidth) / 2);
            
            // Calculate cumulative positions for variable-width nodes, starting with left + horizontal offset
            let currentX = left + horizontalOffset;
            for (let j = 0; j < order.length; j++) {
              const label = order[j];
              const alleleKey = getAlleleKey(label);
              const nodeW = alleleSizes[alleleKey] || baseNodeW;
              const nodeCenterX = currentX + nodeW / 2;
              
              if (Math.abs(x - nodeCenterX) < (nodeW + gap) / 2 && 
                  Math.abs(y - cy) < baseNodeH / 2) {
                newIndex = j;
                break;
              }
              currentX += nodeW + gap;
            }
            
            // If no match found, check if mouse is beyond the last node
            if (newIndex === -1 && Math.abs(y - cy) < baseNodeH / 2) {
              let lastX = left + horizontalOffset;
              for (let j = 0; j < order.length; j++) {
                const label = order[j];
                const alleleKey = getAlleleKey(label);
                const nodeW = alleleSizes[alleleKey] || baseNodeW;
                lastX += nodeW + (j < order.length - 1 ? gap : 0);
              }
              if (x > lastX - (baseNodeW + gap) / 2 && x < lastX + baseNodeW + gap) {
                newIndex = order.length - 1;
              }
            }
          } else {
            const cx = variantMode === "genomic"
              ? xGenomeCanonical(v.pos, flowWidthPx())
              : xColumn(win.findIndex(v2 => v2.id === v.id), win.length);
            const top = 20;
            const H = flowHeightPx();
            
            // Calculate total height and vertical offset for centering
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
            const availableHeight = H - top - margin;
            const verticalOffset = Math.max(0, (availableHeight - totalNodesHeight) / 2);
            
            // Calculate cumulative positions for variable-height nodes, starting with top + vertical offset
            let currentY = top + verticalOffset;
            for (let j = 0; j < order.length; j++) {
              const label = order[j];
              const alleleKey = getAlleleKey(label);
              const nodeH = alleleSizes[alleleKey] || baseNodeH;
              const nodeCenterY = currentY + nodeH / 2;
              
              if (Math.abs(x - cx) < baseNodeW / 2 && 
                  Math.abs(y - nodeCenterY) < (nodeH + gap) / 2) {
                newIndex = j;
                break;
              }
              currentY += nodeH + gap;
            }
            
            // If no match found, check if mouse is below the last node
            if (newIndex === -1 && Math.abs(x - cx) < baseNodeW / 2) {
              let lastY = top + verticalOffset;
              for (let j = 0; j < order.length; j++) {
                const label = order[j];
                const alleleKey = getAlleleKey(label);
                const nodeH = alleleSizes[alleleKey] || baseNodeH;
                lastY += nodeH + (j < order.length - 1 ? gap : 0);
              }
              if (y > lastY - (baseNodeH + gap) / 2 && y < lastY + baseNodeH + gap) {
                newIndex = order.length - 1;
              }
            }
          }
        }
        
        // Store drop index for rendering indicator
        state.alleleDragState.dropIndex = newIndex >= 0 ? newIndex : null;
      } else {
        state.alleleDragState.dropIndex = null;
      }
      
      renderFlowCanvas();
      } else {
        // Handle hover detection when not dragging
        if (!window._alleleNodePositions || window._alleleNodePositions.length === 0) {
          if (state.hoveredAlleleNode) {
            state.hoveredAlleleNode = null;
            state.hoveredAlleleNodeTooltip = null;
            renderFlowCanvas();
            updateTooltip();
          }
          return;
        }
        
        // Find which node is hovered (nodesToTest is filtered by track in multi-track)
        let hoveredNode = null;
        let hoveredNodeLabel = null;
        const findHoveredInNodes = (nodes) => {
          for (const node of nodes) {
            if (x >= node.x && x <= node.x + node.w &&
                y >= node.y && y <= node.y + node.h) {
              return {
                node: { trackId: node.trackId || "", variantId: node.variantId, alleleIndex: node.alleleIndex },
                label: node.label
              };
            }
          }
          return null;
        };
        let hovered = findHoveredInNodes(nodesToTest);
        if (!hovered && nodesToTest !== (window._alleleNodePositions || [])) {
          hovered = findHoveredInNodes(window._alleleNodePositions || []);
        }
        if (hovered) {
          hoveredNode = hovered.node;
          const hoveredVariant = findVariantByTrackAndId(hoveredNode.trackId, hoveredNode.variantId);
          let alleleKey = ".";
          if (hoveredNode.alleleIndex === 1) {
            alleleKey = "ref";
          } else if (hoveredNode.alleleIndex >= 2) {
            alleleKey = `a${hoveredNode.alleleIndex - 1}`;
          }
          const sampleCount = (
            hoveredVariant &&
            hoveredVariant.alleleSampleCounts &&
            Object.prototype.hasOwnProperty.call(hoveredVariant.alleleSampleCounts, alleleKey)
          )
            ? hoveredVariant.alleleSampleCounts[alleleKey]
            : 0;
          hoveredNodeLabel = `${hovered.label} - ${sampleCount} sample${sampleCount === 1 ? '' : 's'}`;
        }
        
        // Update hover state and tooltip if changed
        const currentHover = state.hoveredAlleleNode;
        const hoverChanged = (hoveredNode && (!currentHover ||
            (currentHover.trackId || "") !== (hoveredNode.trackId || "") ||
            currentHover.variantId !== hoveredNode.variantId ||
            currentHover.alleleIndex !== hoveredNode.alleleIndex)) ||
            (!hoveredNode && currentHover);
        if (hoverChanged) {
          state.hoveredAlleleNode = hoveredNode;
          state.hoveredAlleleNodeTooltip = hoveredNode && hoveredNodeLabel
            ? { text: hoveredNodeLabel, x: e.clientX + 10, y: e.clientY + 10 }
            : null;
          renderFlowCanvas();
          updateTooltip();
        } else if (hoveredNode && hoveredNodeLabel) {
          // Same node: keep tooltip text but update position so it follows the cursor
          state.hoveredAlleleNodeTooltip = { text: hoveredNodeLabel, x: e.clientX + 10, y: e.clientY + 10 };
          updateTooltip();
        }
      }
    };
    
    alleleMouseUpHandler = (e) => {
      if (!state.alleleDragState) return;
      
      const rect = flow.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      
      const dragState = state.alleleDragState;
      
      // Check if this was a click (not a drag)
      if (dragState.isClick) {
        const labelKey = makeAlleleSelectionKeyCompat(dragState.trackId, dragState.variantId, dragState.alleleIndex);
        
        // Handle selection with Ctrl/Cmd for multi-select
        if (e.ctrlKey || e.metaKey) {
          // Multi-select: toggle this allele in selection
          if (state.selectedAlleles.has(labelKey)) {
            state.selectedAlleles.delete(labelKey);
          } else {
            state.selectedAlleles.add(labelKey);
          }
        } else {
          // Single-select: replace selection with this allele
          // If clicking on already-selected single allele, deselect it
          if (state.selectedAlleles.size === 1 && state.selectedAlleles.has(labelKey)) {
            state.selectedAlleles.clear();
          } else {
            state.selectedAlleles.clear();
            state.selectedAlleles.add(labelKey);
          }
        }
        
        state.alleleDragState = null;
        flowCanvas.style.cursor = "";
        if (flowWebGPU) flowWebGPU.style.cursor = "";
        renderFlowCanvas();
        if (window.updateSelectionDisplay) window.updateSelectionDisplay();
        return;
      }
      
      // Otherwise, handle as a drag/drop
      const variantOrderKey = makeVariantOrderKeyCompat(dragState.trackId, dragState.variantId);
      const order = state.variantAlleleOrder.get(variantOrderKey);
      if (!order) {
        state.alleleDragState = null;
        flowCanvas.style.cursor = "";
        if (flowWebGPU) flowWebGPU.style.cursor = "";
        renderFlowCanvas();
        return;
      }
      
      const isVertical = isVerticalMode();
      const variantMode = getVariantLayoutMode();
      const variantTrack = getVariantTrackById(dragState.trackId);
      const dragTrackVariants = (variantTrack && Array.isArray(variantTrack.variants_data))
        ? variantTrack.variants_data
        : variants;
      const win = dragTrackVariants.filter(v => v.pos >= state.startBp && v.pos <= state.endBp);
      const constants = window._alleleNodeConstants || { baseNodeW: 4, baseNodeH: 14, gap: 8, MIN_NODE_SIZE: 4 };
      const nodeW = constants.baseNodeW;
      const nodeH = constants.baseNodeH;
      const gap = constants.gap;
      
      let newIndex = -1;
      if (isVertical) {
        const sortedWin = [...win].sort((a, b) => a.pos - b.pos);
        const v = sortedWin.find(v => v.id === dragState.variantId);
        if (!v) {
          state.alleleDragState = null;
          flowCanvas.style.cursor = "";
          if (flowWebGPU) flowWebGPU.style.cursor = "";
          renderFlowCanvas();
          return;
        }
        const left = 70;
        const cy = variantMode === "genomic"
          ? yGenomeCanonical(v.pos, flowHeightPx())
          : yColumn(sortedWin.findIndex(v2 => v2.id === v.id), sortedWin.length);
        
        // Check if dropped near a node position
        for (let j = 0; j < order.length; j++) {
          const nodeX = left + j * (nodeW + gap);
          if (Math.abs(x - nodeX) < (nodeW + gap) / 2 && 
              Math.abs(y - cy) < nodeH / 2) {
            newIndex = j;
            break;
          }
        }
        
        // If no match found, check if mouse is beyond the last node (for dropping at last position)
        if (newIndex === -1 && Math.abs(y - cy) < nodeH / 2) {
          const lastNodeX = left + (order.length - 1) * (nodeW + gap);
          // Check if mouse is to the right of the last node (within reasonable distance)
          if (x > lastNodeX - (nodeW + gap) / 2 && x < lastNodeX + nodeW + gap + (nodeW + gap) / 2) {
            newIndex = order.length - 1;
          }
        }
      } else {
        const v = win.find(v => v.id === dragState.variantId);
        if (!v) {
          state.alleleDragState = null;
          flowCanvas.style.cursor = "";
          if (flowWebGPU) flowWebGPU.style.cursor = "";
          renderFlowCanvas();
          return;
        }
        const cx = variantMode === "genomic"
          ? xGenomeCanonical(v.pos, flowWidthPx())
          : xColumn(win.findIndex(v2 => v2.id === v.id), win.length);
        const top = 20;
        
        // Check if dropped near a node position
        for (let j = 0; j < order.length; j++) {
          const nodeY = top + j * (nodeH + gap);
          if (Math.abs(x - cx) < nodeW / 2 && 
              Math.abs(y - nodeY) < (nodeH + gap) / 2) {
            newIndex = j;
            break;
          }
        }
        
        // If no match found, check if mouse is below the last node (for dropping at last position)
        if (newIndex === -1 && Math.abs(x - cx) < nodeW / 2) {
          const lastNodeY = top + (order.length - 1) * (nodeH + gap);
          // Check if mouse is below the last node (within reasonable distance)
          if (y > lastNodeY - (nodeH + gap) / 2 && y < lastNodeY + nodeH + gap + (nodeH + gap) / 2) {
            newIndex = order.length - 1;
          }
        }
      }
      
      // Reorder if dropped at a valid position
      if (newIndex >= 0 && newIndex !== order.indexOf(dragState.label)) {
        const currentIndex = order.indexOf(dragState.label);
        order.splice(currentIndex, 1);
        order.splice(newIndex, 0, dragState.label);
        state.variantAlleleOrder.set(variantOrderKey, order);
      }
      
      state.alleleDragState = null;
      flowCanvas.style.cursor = "";
      if (flowWebGPU) flowWebGPU.style.cursor = "";
      renderFlowCanvas();
    };
    
    // Attach to flow (when multi-track so overlays bubble) or flowWebGPU (single-track)
    targetElement.addEventListener("mousedown", alleleMouseDownHandler, { passive: false });
    document.addEventListener("mousemove", alleleMouseMoveHandler);
    document.addEventListener("mouseup", alleleMouseUpHandler);
  }
  
  setupAlleleDragDrop();
  
  // -----------------------------
  // Sample Selection Strategy UI
  // -----------------------------
  
  // Get information about selected alleles for loading reads
  function getSelectedAlleleInfo() {
    const selectedInfo = [];
    for (const key of state.selectedAlleles) {
      const parsed = parseAlleleSelectionKeyCompat(key);
      if (!parsed) continue;
      const { trackId, variantId, alleleIndex } = parsed;
      
      // Find the variant
      const variant = findVariantByTrackAndId(trackId, variantId);
      if (!variant) continue;
      
      // Find the node position info to get the label
      const nodeInfo = window._alleleNodePositions?.find(n => 
        (n.trackId || "") === (trackId || "") &&
        n.variantId === variantId &&
        n.alleleIndex === alleleIndex
      );
      
      selectedInfo.push({
        trackId,
        variantId,
        alleleIndex,
        label: nodeInfo?.label || `Allele ${alleleIndex}`,
        variant
      });
    }
    return selectedInfo;
  }
  
  // Update context indicator (shows what's selected)
  function updateSampleContext() {
    const currentRoot = getCurrentRoot();
    const contextEl = byId(currentRoot, 'sampleContext');
    
    if (!contextEl) return;
    
    if (state.selectedAlleles.size === 0) {
      contextEl.style.display = 'none';
      return;
    }
    
    // Count selected alleles
    const alleleCount = state.selectedAlleles.size;
    
    // Show allele count directly in the context div
    contextEl.textContent = `${alleleCount} ${alleleCount === 1 ? 'allele' : 'alleles'} selected`;
    contextEl.style.display = 'block';
  }
  
  // Update strategy section state (enable/disable controls)
  function updateSampleStrategySection() {
    const hasSelection = state.selectedAlleles.size > 0;
    const currentRoot = getCurrentRoot();
    const strategySectionEl = byId(currentRoot, 'sampleStrategySection');
    const strategyEl = byId(currentRoot, 'sampleStrategy');
    const sliderEl = byId(currentRoot, 'sampleCountSlider');
    const inputEl = byId(currentRoot, 'sampleCountInput');
    const replaceBtn = byId(currentRoot, 'loadSamplesReplace');
    const addBtn = byId(currentRoot, 'loadSamplesAdd');
    
    // Show/hide entire strategy section based on selection
    if (strategySectionEl) {
      strategySectionEl.style.display = hasSelection ? 'block' : 'none';
    }
    
    // Enable/disable controls based on selection
    const disabled = !hasSelection;
    if (strategyEl) strategyEl.disabled = disabled;
    if (sliderEl) sliderEl.disabled = disabled;
    if (inputEl) inputEl.disabled = disabled;
    if (replaceBtn) replaceBtn.disabled = disabled;
    if (addBtn) addBtn.disabled = disabled;
    
    // Update "Compare branches" option enablement
    if (strategyEl) {
      const compareOption = strategyEl.querySelector('option[value="compare_branches"]');
      if (compareOption) {
        // Enable only when 2+ branches selected
        compareOption.disabled = state.selectedAlleles.size < 2;
      }
    }
    
    // Update preview and button text
    updateSamplePreview();
    updateLoadButtonText();
  }
  
  // Update sample preview
  function updateSamplePreview() {
    const currentRoot = getCurrentRoot();
    const previewEl = byId(currentRoot, 'samplePreview');
    const previewListEl = byId(currentRoot, 'samplePreviewList');
    const candidates = state.sampleSelection.candidateSamples;
    
    if (!previewEl || !previewListEl) return;
    
    if (candidates.length === 0) {
      previewEl.style.display = 'none';
      return;
    }
    
    // Show first 5 samples + count of remaining
    const displayCount = Math.min(5, candidates.length);
    const remaining = candidates.length - displayCount;
    
    let text = candidates.slice(0, displayCount).join(', ');
    if (remaining > 0) {
      text += `, +${remaining} more`;
    }
    
    previewListEl.textContent = text;
    previewEl.style.display = 'block';
    
    // Update Load button text
    updateLoadButtonText();
  }
  
  // Update Load button text to show sample count
  function updateLoadButtonText() {
    const currentRoot = getCurrentRoot();
    const replaceBtn = byId(currentRoot, 'loadSamplesReplace');
    const addBtn = byId(currentRoot, 'loadSamplesAdd');
    const candidates = state.sampleSelection.candidateSamples;
    const numSamples = state.sampleSelection.numSamples || 1;
    
    const totalCandidates = candidates.length;
    const samplesToLoad = Math.min(numSamples, totalCandidates);
    
    if (replaceBtn) {
      if (totalCandidates === 0) {
        replaceBtn.textContent = 'Load';
      } else {
        replaceBtn.textContent = `Load (${samplesToLoad} of ${totalCandidates})`;
      }
    }
    
    if (addBtn) {
      if (totalCandidates === 0) {
        addBtn.textContent = 'Load (add)';
      } else {
        addBtn.textContent = `Load (add ${samplesToLoad} of ${totalCandidates})`;
      }
    }
  }
  
  // Recompute candidate samples based on strategy and selection
  function recomputeCandidateSamples() {
    // Clear previous candidates
    state.sampleSelection.candidateSamples = [];
    
    // If no alleles selected, no candidates
    if (state.selectedAlleles.size === 0) {
      updateSamplePreview();
      return;
    }
    
    // Parse selected alleles into variant/allele pairs
    const selectedAllelePairs = [];
    for (const key of state.selectedAlleles) {
      const parsed = parseAlleleSelectionKeyCompat(key);
      if (!parsed) continue;
      const { trackId, variantId, alleleIndex } = parsed;
      
      const variant = findVariantByTrackAndId(trackId, variantId);
      if (!variant) continue;
      
      selectedAllelePairs.push({
        trackId,
        variantId,
        alleleIndex,
        variant
      });
    }
    
    if (selectedAllelePairs.length === 0) {
      updateSamplePreview();
      return;
    }
    
    // Collect all sample IDs from variant data (for allSampleIds if not populated)
    const allSamplesSet = new Set();
    for (const pair of selectedAllelePairs) {
      if (pair.variant.sampleAlleles) {
        Object.keys(pair.variant.sampleAlleles).forEach(sampleId => allSamplesSet.add(sampleId));
      } else {
        const sampleGenotypes = pair.variant.sampleGenotypes || {};
        Object.keys(sampleGenotypes).forEach(sampleId => allSamplesSet.add(sampleId));
      }
    }
    
    // Also add sample names from sample_mapping (both keys and values)
    if (window.GENOMESHADER_CONFIG && window.GENOMESHADER_CONFIG.sample_mapping) {
      const sampleMapping = window.GENOMESHADER_CONFIG.sample_mapping;
      // Add all keys (VCF sample names)
      Object.keys(sampleMapping).forEach(sampleId => allSamplesSet.add(sampleId));
      // Add all values (BAM sample names)
      Object.values(sampleMapping).forEach(bamSamples => {
        if (Array.isArray(bamSamples)) {
          bamSamples.forEach(sampleId => allSamplesSet.add(sampleId));
        } else if (bamSamples) {
          allSamplesSet.add(bamSamples);
        }
      });
    }
    
    // Populate allSampleIds if empty
    if (state.sampleSelection.allSampleIds.length === 0) {
      state.sampleSelection.allSampleIds = Array.from(allSamplesSet).sort();
    }
    
    // Find samples that match the selection criteria
    const candidateSamplesSet = new Set();
    const combineMode = state.sampleSelection.combineMode;
    
    if (combineMode === 'AND') {
      // Sample must have ALL selected alleles
      // Start with samples from first variant, then filter by others
      const firstPair = selectedAllelePairs[0];
      const firstSamples = getVariantSampleIds(firstPair.variant);
      for (const sampleId of firstSamples) {
        if (!sampleHasSelectedAllele(firstPair.variant, sampleId, firstPair.alleleIndex)) {
          continue;
        }
        let hasAllAlleles = true;
        for (let i = 1; i < selectedAllelePairs.length; i++) {
          const pair = selectedAllelePairs[i];
          if (!sampleHasSelectedAllele(pair.variant, sampleId, pair.alleleIndex)) {
            hasAllAlleles = false;
            break;
          }
        }
        if (hasAllAlleles) {
          candidateSamplesSet.add(sampleId);
        }
      }
    } else {
      // OR mode: Sample must have ANY of the selected alleles
      for (const pair of selectedAllelePairs) {
        for (const sampleId of getVariantSampleIds(pair.variant)) {
          if (sampleHasSelectedAllele(pair.variant, sampleId, pair.alleleIndex)) {
            candidateSamplesSet.add(sampleId);
          }
        }
      }
    }
    
    // Convert to sorted array
    state.sampleSelection.candidateSamples = Array.from(candidateSamplesSet).sort();
    
    updateSamplePreview();
  }
  
  // Helper: Convert allele index to genotype index
  // The labels array from getFormattedLabelsForVariant has:
  //   Index 0: "." (no-call)
  //   Index 1: ref allele (genotype 0)
  //   Index 2: first alt allele (genotype 1)
  //   Index 3: second alt allele (genotype 2), etc.
  // So: genotypeIndex = alleleIndex - 1 (for alleleIndex >= 1)
  function alleleIndexToGenotypeIndex(alleleIndex) {
    // alleleIndex 0 is no-call, which doesn't map to a genotype
    // alleleIndex 1 is ref (genotype 0)
    // alleleIndex 2 is first alt (genotype 1), etc.
    if (alleleIndex === 0) {
      return null; // No-call doesn't map to a genotype index
    }
    return alleleIndex - 1;
  }

  function alleleIndexToAlleleKey(alleleIndex) {
    if (alleleIndex === 0) return ".";
    if (alleleIndex === 1) return "ref";
    return `a${alleleIndex - 1}`;
  }

  function getVariantSampleIds(variant) {
    if (!variant) return [];
    if (variant.sampleAlleles) {
      return Object.keys(variant.sampleAlleles);
    }
    return Object.keys(variant.sampleGenotypes || {});
  }

  function variantHasSampleAlleles(variant) {
    return !!(variant && variant.sampleAlleles);
  }

  function sampleHasSelectedAllele(variant, sampleId, alleleIndex) {
    if (!variant || sampleId == null || alleleIndex == null) return false;
    if (variant.sampleAlleles) {
      const alleleKey = alleleIndexToAlleleKey(alleleIndex);
      const sampleAlleles = variant.sampleAlleles[sampleId] || [];
      return sampleAlleles.includes(alleleKey);
    }
    const genotypeIndex = alleleIndexToGenotypeIndex(alleleIndex);
    if (genotypeIndex === null) return false;
    const sampleGenotypes = variant.sampleGenotypes || {};
    const genotype = sampleGenotypes[sampleId];
    return hasAlleleInGenotype(genotype, genotypeIndex);
  }
  
  // Helper: Check if a genotype string contains a specific allele index
  // Genotype format: "0/1", "1/1", "./.", "0|1", etc.
  // Note: alleleIndex here is the genotype index (0=ref, 1=first alt, 2=second alt, etc.)
  function hasAlleleInGenotype(genotype, alleleIndex) {
    if (!genotype || genotype === './.' || genotype === '.') {
      return false;
    }
    
    // Split by / or | to get individual alleles
    const alleles = genotype.split(/[\/|]/);
    
    // Check if any allele matches the target index
    for (const allele of alleles) {
      const alleleStr = allele.trim();
      // Handle missing alleles
      if (alleleStr === '.' || alleleStr === '') {
        continue;
      }
      const idx = parseInt(alleleStr, 10);
      if (!isNaN(idx) && idx === alleleIndex) {
        return true;
      }
    }
    
    return false;
  }

  // Helper: Compute candidate samples for a specific set of alleles
  // This is used by shuffle to get candidates for a track's specific alleles
  function computeCandidateSamplesForAlleles(selectedAllelesSet, combineMode) {
    const selectedAlleles = Array.from(selectedAllelesSet);
    if (selectedAlleles.length === 0) {
      return [];
    }
    
    // Parse selected alleles into variant/allele pairs
    const selectedAllelePairs = [];
    for (const key of selectedAlleles) {
      const parsed = parseAlleleSelectionKeyCompat(key);
      if (!parsed) continue;
      const { trackId, variantId, alleleIndex } = parsed;
      
      const variant = findVariantByTrackAndId(trackId, variantId);
      if (!variant) continue;
      
      selectedAllelePairs.push({
        trackId,
        variantId,
        alleleIndex,
        variant
      });
    }
    
    if (selectedAllelePairs.length === 0) {
      return [];
    }
    
    // Find samples that match the selection criteria
    const candidateSamplesSet = new Set();
    
    if (combineMode === 'AND') {
      // Sample must have ALL selected alleles
      const firstPair = selectedAllelePairs[0];
      for (const sampleId of getVariantSampleIds(firstPair.variant)) {
        if (!sampleHasSelectedAllele(firstPair.variant, sampleId, firstPair.alleleIndex)) {
          continue;
        }
        let hasAllAlleles = true;
        for (let i = 1; i < selectedAllelePairs.length; i++) {
          const pair = selectedAllelePairs[i];
          if (!sampleHasSelectedAllele(pair.variant, sampleId, pair.alleleIndex)) {
            hasAllAlleles = false;
            break;
          }
        }
        if (hasAllAlleles) {
          candidateSamplesSet.add(sampleId);
        }
      }
    } else {
      // OR mode: Sample must have ANY of the selected alleles
      for (const pair of selectedAllelePairs) {
        for (const sampleId of getVariantSampleIds(pair.variant)) {
          if (sampleHasSelectedAllele(pair.variant, sampleId, pair.alleleIndex)) {
            candidateSamplesSet.add(sampleId);
          }
        }
      }
    }
    
    return Array.from(candidateSamplesSet).sort();
  }
  
  // Export for use in smart-tracks.js
  window.computeCandidateSamplesForAlleles = computeCandidateSamplesForAlleles;
  
  // Helper: Compute evidence score for a sample based on selected alleles
  // Higher score = stronger evidence
  // Returns a score (number) - higher is better
  function computeEvidenceScore(sampleId, selectedAllelesSet, combineMode) {
    const selectedAlleles = Array.from(selectedAllelesSet);
    if (selectedAlleles.length === 0) {
      return 0;
    }
    
    // Parse selected alleles into variant/allele pairs
    const selectedAllelePairs = [];
    for (const key of selectedAlleles) {
      const parsed = parseAlleleSelectionKeyCompat(key);
      if (!parsed) continue;
      const { trackId, variantId, alleleIndex } = parsed;
      
      const variant = findVariantByTrackAndId(trackId, variantId);
      if (!variant) continue;
      
      selectedAllelePairs.push({
        trackId,
        variantId,
        alleleIndex,
        variant
      });
    }
    
    if (selectedAllelePairs.length === 0) {
      return 0;
    }
    
    let totalScore = 0;
    let matchingAlleles = 0;
    
    if (combineMode === 'AND') {
      // Sample must have ALL selected alleles
      // Score based on homozygosity for each allele
      for (const pair of selectedAllelePairs) {
        const sampleGenotypes = pair.variant.sampleGenotypes || {};
        const genotype = sampleGenotypes[sampleId];
        const genotypeIndex = alleleIndexToGenotypeIndex(pair.alleleIndex);
        const hasAllele = sampleHasSelectedAllele(pair.variant, sampleId, pair.alleleIndex);

        if (!hasAllele) {
          // Missing genotype or no-call allele - penalize heavily
          return -1000;
        }
        matchingAlleles++;

        if (variantHasSampleAlleles(pair.variant)) {
          totalScore += 5;
          continue;
        }
        if (!genotype || genotypeIndex === null) return -1000;
        const alleles = genotype.split(/[\/|]/);
        let alleleCount = 0;
        for (const allele of alleles) {
          const alleleStr = allele.trim();
          if (alleleStr === '.' || alleleStr === '') continue;
          const idx = parseInt(alleleStr, 10);
          if (!isNaN(idx) && idx === genotypeIndex) {
            alleleCount++;
          }
        }
        if (alleleCount >= 2) {
          totalScore += 10;
        } else if (alleleCount === 1) {
          totalScore += 5;
        } else {
          return -1000;
        }
      }
      
      // Bonus for having all alleles
      if (matchingAlleles === selectedAllelePairs.length) {
        totalScore += 100; // Bonus for complete match
      }
    } else {
      // OR mode: Sample must have ANY of the selected alleles
      // Score based on number of matching alleles and homozygosity
      for (const pair of selectedAllelePairs) {
        const sampleGenotypes = pair.variant.sampleGenotypes || {};
        const genotype = sampleGenotypes[sampleId];
        const genotypeIndex = alleleIndexToGenotypeIndex(pair.alleleIndex);
        if (sampleHasSelectedAllele(pair.variant, sampleId, pair.alleleIndex)) {
          matchingAlleles++;
          if (variantHasSampleAlleles(pair.variant)) {
            totalScore += 5;
            continue;
          }
          if (!genotype || genotypeIndex === null) continue;
          const alleles = genotype.split(/[\/|]/);
          let alleleCount = 0;
          for (const allele of alleles) {
            const alleleStr = allele.trim();
            if (alleleStr === '.' || alleleStr === '') continue;
            const idx = parseInt(alleleStr, 10);
            if (!isNaN(idx) && idx === genotypeIndex) {
              alleleCount++;
            }
          }
          if (alleleCount >= 2) {
            totalScore += 10;
          } else if (alleleCount === 1) {
            totalScore += 5;
          }
        }
      }
      
      // Bonus for matching more alleles (in OR mode, more matches = better)
      totalScore += matchingAlleles * 20;
    }
    
    return totalScore;
  }
  
  // Helper: Select samples based on strategy
  // Returns an array of sample IDs to use for creating Smart Tracks
  function selectSamplesForStrategy(strategy, candidates, numSamples) {
    if (strategy === 'carriers_controls') {
      // Carriers + controls strategy: select a mix of carriers and controls
      // Carriers are samples with selected alleles (candidates)
      // Controls are samples without selected alleles
      
      // Get all available samples
      const allSamples = state.sampleSelection.allSampleIds || [];
      if (allSamples.length === 0) {
        // Fallback: if allSampleIds not populated, just use candidates (or empty)
        if (!candidates || candidates.length === 0) {
          return [];
        }
        return selectSamplesForStrategy('random', candidates, numSamples);
      }
      
      // Compute controls: samples that are NOT in candidates
      const carriers = candidates || [];
      const carriersSet = new Set(carriers);
      const controls = allSamples.filter(sampleId => !carriersSet.has(sampleId));
      
      // If no controls available and no carriers, return empty
      if (controls.length === 0 && carriers.length === 0) {
        return [];
      }
      
      // If no controls available, fall back to random from carriers
      if (controls.length === 0) {
        console.warn('No control samples available (all samples are carriers), falling back to random selection');
        if (carriers.length === 0) {
          return [];
        }
        return selectSamplesForStrategy('random', carriers, numSamples);
      }
      
      // If no carriers available, just return controls
      if (carriers.length === 0) {
        console.warn('No carrier samples available, returning controls only');
        const selectedSamples = [];
        const controlsCopy = [...controls];
        for (let i = 0; i < numSamples && controlsCopy.length > 0; i++) {
          const randomIndex = Math.floor(Math.random() * controlsCopy.length);
          selectedSamples.push(controlsCopy[randomIndex]);
          controlsCopy.splice(randomIndex, 1);
        }
        return selectedSamples;
      }
      
      // Split numSamples between carriers and controls
      // Try to get roughly equal numbers, but favor carriers if odd number
      const numCarriers = Math.ceil(numSamples / 2);
      const numControls = Math.floor(numSamples / 2);
      
      const selectedSamples = [];
      
      // Select carriers (random from candidates)
      const carriersCopy = [...carriers];
      for (let i = 0; i < numCarriers && carriersCopy.length > 0; i++) {
        const randomIndex = Math.floor(Math.random() * carriersCopy.length);
        selectedSamples.push(carriersCopy[randomIndex]);
        carriersCopy.splice(randomIndex, 1);
      }
      
      // Select controls (random from controls)
      const controlsCopy = [...controls];
      for (let i = 0; i < numControls && controlsCopy.length > 0; i++) {
        const randomIndex = Math.floor(Math.random() * controlsCopy.length);
        selectedSamples.push(controlsCopy[randomIndex]);
        controlsCopy.splice(randomIndex, 1);
      }
      
      // Shuffle the result so carriers and controls are interleaved
      for (let i = selectedSamples.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [selectedSamples[i], selectedSamples[j]] = [selectedSamples[j], selectedSamples[i]];
      }
      
      return selectedSamples;
    }
    
    if (!candidates || candidates.length === 0) {
      return [];
    }
    
    if (strategy === 'random') {
      // Random strategy: select N random samples from candidates
      const selectedSamples = [];
      const candidatesCopy = [...candidates]; // Copy to avoid mutating original
      
      for (let i = 0; i < numSamples; i++) {
        if (candidatesCopy.length === 0) {
          // If we've exhausted unique samples, allow duplicates by resetting
          candidatesCopy.push(...candidates);
        }
        
        // Pick a random index
        const randomIndex = Math.floor(Math.random() * candidatesCopy.length);
        selectedSamples.push(candidatesCopy[randomIndex]);
        
        // Remove the selected sample to avoid duplicates (if possible)
        candidatesCopy.splice(randomIndex, 1);
      }
      
      return selectedSamples;
    } else if (strategy === 'best_evidence') {
      // Best evidence strategy: select samples with strongest evidence for selected alleles
      // Get selected alleles and combine mode from state
      const selectedAlleles = state.selectedAlleles || new Set();
      const combineMode = state.sampleSelection.combineMode || 'AND';
      
      if (selectedAlleles.size === 0) {
        // No alleles selected, fall back to random
        return selectSamplesForStrategy('random', candidates, numSamples);
      }
      
      // Score all candidate samples
      const scoredSamples = candidates.map(sampleId => ({
        sampleId,
        score: computeEvidenceScore(sampleId, selectedAlleles, combineMode)
      }));
      
      // Sort by score (descending) - highest score first
      scoredSamples.sort((a, b) => b.score - a.score);
      
      // Filter out samples with negative scores (disqualified)
      const validSamples = scoredSamples.filter(s => s.score >= 0);
      
      if (validSamples.length === 0) {
        // No valid samples, fall back to random
        console.warn('No samples with valid evidence found, falling back to random selection');
        return selectSamplesForStrategy('random', candidates, numSamples);
      }
      
      // Select top N samples
      const selectedSamples = [];
      for (let i = 0; i < numSamples && i < validSamples.length; i++) {
        selectedSamples.push(validSamples[i].sampleId);
      }
      
      // If we need more samples than available, cycle through top samples
      if (selectedSamples.length < numSamples) {
        for (let i = selectedSamples.length; i < numSamples; i++) {
          selectedSamples.push(validSamples[i % validSamples.length].sampleId);
        }
      }
      
      return selectedSamples;
    } else if (strategy === 'most_diverse') {
      // Most diverse strategy: select samples with maximally different genotype profiles
      // This helps explore the full range of genetic variation in the dataset
      
      if (!candidates || candidates.length === 0) {
        return [];
      }
      
      // If only one sample requested, just return it
      if (numSamples === 1) {
        return [candidates[0]];
      }
      
      // Determine which variants to consider
      const selectedAlleles = state.selectedAlleles || new Set();
      let variantsToConsider = [];
      
      if (selectedAlleles.size > 0) {
        // If alleles are selected, only consider those variants
        const selectedVariants = [];
        const selectedVariantKeys = new Set();
        for (const key of selectedAlleles) {
          const parsed = parseAlleleSelectionKeyCompat(key);
          if (!parsed) continue;
          const composite = `${parsed.trackId || ""}::${parsed.variantId}`;
          if (selectedVariantKeys.has(composite)) continue;
          const variant = findVariantByTrackAndId(parsed.trackId, parsed.variantId);
          if (!variant) continue;
          selectedVariantKeys.add(composite);
          selectedVariants.push(variant);
        }
        variantsToConsider = selectedVariants;
      } else {
        // If no alleles selected, consider all variants
        variantsToConsider = variants;
      }
      
      if (variantsToConsider.length === 0) {
        // No variants to consider, fall back to random
        console.warn('No variants available for diversity calculation, falling back to random selection');
        return selectSamplesForStrategy('random', candidates, numSamples);
      }
      
      // Compute genotype profile for each candidate sample
      // Profile is a string representing genotypes across all variants
      function computeGenotypeProfile(sampleId) {
        const profile = [];
        for (const variant of variantsToConsider) {
          const sampleGenotypes = variant.sampleGenotypes || {};
          const genotype = sampleGenotypes[sampleId];
          // Normalize genotype: use a canonical representation
          // Missing genotypes are represented as "."
          if (!genotype || genotype === './.' || genotype === '.') {
            profile.push('.');
          } else {
            // Normalize: sort alleles for unphased genotypes to ensure consistency
            const alleles = genotype.split(/[\/|]/).map(a => a.trim());
            if (alleles.length >= 2) {
              // Check if phased (contains |) or unphased (contains /)
              const isPhased = genotype.includes('|');
              if (isPhased) {
                // Keep phased order
                profile.push(alleles.join('|'));
              } else {
                // Sort unphased alleles for consistency
                const sorted = alleles.slice().sort((a, b) => {
                  const aNum = a === '.' ? -1 : parseInt(a, 10);
                  const bNum = b === '.' ? -1 : parseInt(b, 10);
                  return aNum - bNum;
                });
                profile.push(sorted.join('/'));
              }
            } else {
              profile.push(genotype);
            }
          }
        }
        return profile.join('|');
      }
      
      // Compute Hamming distance between two genotype profiles
      // Profiles are strings with genotype values separated by '|'
      function profileDistance(profile1, profile2) {
        const parts1 = profile1.split('|');
        const parts2 = profile2.split('|');
        
        if (parts1.length !== parts2.length) {
          // Different number of variants - use length difference as penalty
          return Math.abs(parts1.length - parts2.length) * 10;
        }
        
        let distance = 0;
        for (let i = 0; i < parts1.length; i++) {
          if (parts1[i] !== parts2[i]) {
            distance++;
          }
        }
        return distance;
      }
      
      // Compute minimum distance from a sample to a set of already-selected samples
      function minDistanceToSet(sampleProfile, selectedProfiles) {
        if (selectedProfiles.length === 0) {
          return Infinity; // First sample has infinite distance
        }
        
        let minDist = Infinity;
        for (const selectedProfile of selectedProfiles) {
          const dist = profileDistance(sampleProfile, selectedProfile);
          if (dist < minDist) {
            minDist = dist;
          }
        }
        return minDist;
      }
      
      // Compute profiles for all candidates
      const candidateProfiles = new Map();
      for (const sampleId of candidates) {
        candidateProfiles.set(sampleId, computeGenotypeProfile(sampleId));
      }
      
      // Greedy algorithm: iteratively select the sample that is most different
      // from all previously selected samples
      const selectedSamples = [];
      const selectedProfiles = [];
      
      // Start with a random sample (or first candidate)
      const firstSample = candidates[Math.floor(Math.random() * candidates.length)];
      selectedSamples.push(firstSample);
      selectedProfiles.push(candidateProfiles.get(firstSample));
      
      // Select remaining samples
      const remainingCandidates = candidates.filter(s => s !== firstSample);
      
      for (let i = 1; i < numSamples && remainingCandidates.length > 0; i++) {
        let bestSample = null;
        let bestDistance = -1;
        
        // Find the candidate that maximizes minimum distance to selected samples
        for (const candidateId of remainingCandidates) {
          const candidateProfile = candidateProfiles.get(candidateId);
          const minDist = minDistanceToSet(candidateProfile, selectedProfiles);
          
          if (minDist > bestDistance) {
            bestDistance = minDist;
            bestSample = candidateId;
          }
        }
        
        if (bestSample) {
          selectedSamples.push(bestSample);
          selectedProfiles.push(candidateProfiles.get(bestSample));
          // Remove from remaining candidates
          const index = remainingCandidates.indexOf(bestSample);
          if (index > -1) {
            remainingCandidates.splice(index, 1);
          }
        } else {
          // No more diverse samples available, break
          break;
        }
      }
      
      // If we still need more samples, fill with remaining candidates
      if (selectedSamples.length < numSamples && remainingCandidates.length > 0) {
        for (let i = selectedSamples.length; i < numSamples && remainingCandidates.length > 0; i++) {
          const randomIndex = Math.floor(Math.random() * remainingCandidates.length);
          const sample = remainingCandidates.splice(randomIndex, 1)[0];
          selectedSamples.push(sample);
        }
      }
      
      return selectedSamples;
    } else if (strategy === 'compare_branches') {
      // Compare branches strategy: select samples representing different combinations
      // of the selected alleles to compare different "branches" of the allele tree
      
      if (!candidates || candidates.length === 0) {
        return [];
      }
      
      const selectedAlleles = state.selectedAlleles || new Set();
      if (selectedAlleles.size < 2) {
        // Need at least 2 alleles to compare branches
        console.warn('Compare branches requires 2+ selected alleles, falling back to random selection');
        return selectSamplesForStrategy('random', candidates, numSamples);
      }
      
      // Parse selected alleles into variant/allele pairs
      const selectedAllelePairs = [];
      for (const key of selectedAlleles) {
        const parsed = parseAlleleSelectionKeyCompat(key);
        if (!parsed) continue;
        const { trackId, variantId, alleleIndex } = parsed;
        
        const variant = findVariantByTrackAndId(trackId, variantId);
        if (!variant) continue;
        
        selectedAllelePairs.push({
          trackId,
          variantId,
          alleleIndex,
          variant
        });
      }
      
      if (selectedAllelePairs.length < 2) {
        console.warn('Compare branches requires 2+ valid alleles, falling back to random selection');
        return selectSamplesForStrategy('random', candidates, numSamples);
      }
      
      // Compute which alleles each sample has
      // For each sample, create a "branch signature" representing which selected alleles it carries
      function computeBranchSignature(sampleId) {
        const signature = [];
        for (const pair of selectedAllelePairs) {
          const sampleGenotypes = pair.variant.sampleGenotypes || {};
          const genotype = sampleGenotypes[sampleId];
          const genotypeIndex = alleleIndexToGenotypeIndex(pair.alleleIndex);
          
          if (genotypeIndex !== null && hasAlleleInGenotype(genotype, genotypeIndex)) {
            signature.push(1); // Sample has this allele
          } else {
            signature.push(0); // Sample doesn't have this allele
          }
        }
        return signature.join(''); // Binary string like "101" means has allele 0, not 1, has 2
      }
      
      // Group samples by their branch signature
      const branchGroups = new Map(); // Map<signature, sampleIds[]>
      for (const sampleId of candidates) {
        const signature = computeBranchSignature(sampleId);
        if (!branchGroups.has(signature)) {
          branchGroups.set(signature, []);
        }
        branchGroups.get(signature).push(sampleId);
      }
      
      // Sort branch groups by signature (to get consistent ordering)
      // Prefer groups with more unique allele combinations
      const sortedBranches = Array.from(branchGroups.entries()).sort((a, b) => {
        // Count how many alleles each branch has
        const aCount = (a[0].match(/1/g) || []).length;
        const bCount = (b[0].match(/1/g) || []).length;
        
        // Prefer branches with different allele counts (more diverse)
        if (aCount !== bCount) {
          return bCount - aCount; // Higher count first
        }
        
        // If same count, prefer lexicographically different signatures
        return a[0].localeCompare(b[0]);
      });
      
      // Select samples from different branches
      const selectedSamples = [];
      const usedBranches = new Set();
      
      // First pass: try to get one sample from each unique branch
      for (const [signature, sampleIds] of sortedBranches) {
        if (selectedSamples.length >= numSamples) break;
        if (usedBranches.has(signature)) continue;
        
        // Pick a random sample from this branch
        const randomIndex = Math.floor(Math.random() * sampleIds.length);
        selectedSamples.push(sampleIds[randomIndex]);
        usedBranches.add(signature);
      }
      
      // Second pass: if we need more samples, cycle through branches
      if (selectedSamples.length < numSamples) {
        let branchIndex = 0;
        while (selectedSamples.length < numSamples && sortedBranches.length > 0) {
          const [signature, sampleIds] = sortedBranches[branchIndex % sortedBranches.length];
          
          // Pick a different sample from this branch if possible
          const availableSamples = sampleIds.filter(s => !selectedSamples.includes(s));
          if (availableSamples.length > 0) {
            const randomIndex = Math.floor(Math.random() * availableSamples.length);
            selectedSamples.push(availableSamples[randomIndex]);
          } else if (sampleIds.length > 0) {
            // All samples from this branch already used, allow reuse
            const randomIndex = Math.floor(Math.random() * sampleIds.length);
            selectedSamples.push(sampleIds[randomIndex]);
          }
          
          branchIndex++;
        }
      }
      
      // Shuffle to mix branches (optional, but makes comparison more interesting)
      for (let i = selectedSamples.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [selectedSamples[i], selectedSamples[j]] = [selectedSamples[j], selectedSamples[i]];
      }
      
      return selectedSamples;
    } else {
      // For other strategies, cycle through candidates (current behavior)
      const selectedSamples = [];
      for (let i = 0; i < numSamples; i++) {
        selectedSamples.push(candidates[i % candidates.length]);
      }
      return selectedSamples;
    }
  }
  
  // Export for use in smart-tracks.js
  window.selectSamplesForStrategy = selectSamplesForStrategy;
  
  // Strategy change handler
  function onStrategyChange() {
    const currentRoot = getCurrentRoot();
    const strategyEl = byId(currentRoot, 'sampleStrategy');
    if (strategyEl) {
      state.sampleSelection.strategy = strategyEl.value;
    }
    recomputeCandidateSamples();
  }
  
  // Setup sample search with autocomplete
  function setupSampleSearch() {
    const currentRoot = getCurrentRoot();
    const searchInput = byId(currentRoot, 'sampleSearchInput');
    const resultsEl = byId(currentRoot, 'sampleSearchResults');
    
    if (!searchInput || !resultsEl) return;
    
    let searchTimeout = null;
    
    searchInput.addEventListener('input', (e) => {
      clearTimeout(searchTimeout);
      const query = e.target.value.trim().toLowerCase();
      
      if (query.length === 0) {
        resultsEl.style.display = 'none';
        return;
      }
      
      searchTimeout = setTimeout(() => {
        // Filter sample IDs by prefix/substring match
        const matches = state.sampleSelection.allSampleIds
          .filter(id => id.toLowerCase().includes(query))
          .slice(0, 8); // Top 8 matches
        
        if (matches.length === 0) {
          resultsEl.style.display = 'none';
          return;
        }
        
        // Render results
        resultsEl.innerHTML = '';
        matches.forEach(sampleId => {
          const resultEl = document.createElement('div');
          resultEl.className = 'sampleSearchResult';
          resultEl.textContent = sampleId;
          resultEl.addEventListener('click', () => {
            loadSmartTrackForSample(sampleId);
            searchInput.value = '';
            resultsEl.style.display = 'none';
          });
          resultsEl.appendChild(resultEl);
        });
        
        resultsEl.style.display = 'block';
      }, 150); // Debounce search
    });
    
    // Hide results when clicking outside
    document.addEventListener('click', (e) => {
      if (!searchInput.contains(e.target) && !resultsEl.contains(e.target)) {
        resultsEl.style.display = 'none';
      }
    });
    
    // Handle Enter key
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const query = searchInput.value.trim();
        if (query.length > 0) {
          // Check if there's a matching result
          const firstResult = resultsEl.querySelector('.sampleSearchResult');
          if (firstResult) {
            firstResult.click();
          } else {
            // If no results shown but query exists, try to load directly if it matches a sample
            const exactMatch = state.sampleSelection.allSampleIds.find(
              id => id.toLowerCase() === query.toLowerCase()
            );
            if (exactMatch) {
              loadSmartTrackForSample(exactMatch);
              searchInput.value = '';
              resultsEl.style.display = 'none';
            }
          }
        }
      }
    });
  }
  
  // Function to load a Smart Track for a specific sample
  function loadSmartTrackForSample(sampleId) {
    // Use currently selected alleles if any, otherwise use empty set
    const selectedAlleles = state.selectedAlleles.size > 0 
      ? Array.from(state.selectedAlleles) 
      : [];
    
    // Use current strategy, or 'random' as fallback
    const strategy = state.sampleSelection.strategy || 'random';
    
    // Create Smart Track
    const track = createSmartTrack(strategy, selectedAlleles);
    
    // Set sampleType for carriers_controls strategy
    if (strategy === 'carriers_controls') {
      const combineMode = state.sampleSelection.combineMode;
      const carriers = window.computeCandidateSamplesForAlleles 
        ? window.computeCandidateSamplesForAlleles(selectedAlleles, combineMode)
        : [];
      const carriersSet = new Set(carriers);
      track.sampleType = carriersSet.has(sampleId) ? 'carrier' : 'control';
    }
    
    // Fetch reads for the specific sample
    fetchReadsForSmartTrack(track.id, strategy, track.selectedAlleles, sampleId)
      .catch(err => {
        console.error('Failed to load reads for Smart track:', err);
      });
  }
  
  // Main update function for selection display
  function updateSelectionDisplay() {
    updateSampleContext();
    updateSampleStrategySection();
    recomputeCandidateSamples();
  }
  
  // Setup sample selection strategy controls
  const strategyEl = byId(root, 'sampleStrategy');
  const sliderEl = byId(root, 'sampleCountSlider');
  const sampleCountInputEl = byId(root, 'sampleCountInput');
  const combineAndBtn = byId(root, 'combineAnd');
  const combineOrBtn = byId(root, 'combineOr');
  const replaceBtn = byId(root, 'loadSamplesReplace');
  const addBtn = byId(root, 'loadSamplesAdd');
  
  // Strategy dropdown
  if (strategyEl) {
    strategyEl.addEventListener('change', onStrategyChange);
  }
  
  // Sample count sync between slider and input
  if (sliderEl) {
    sliderEl.addEventListener('input', (e) => {
      if (sampleCountInputEl) sampleCountInputEl.value = e.target.value;
      state.sampleSelection.numSamples = parseInt(e.target.value);
      recomputeCandidateSamples();
      updateLoadButtonText();
    });
  }
  
  if (sampleCountInputEl) {
    sampleCountInputEl.addEventListener('change', (e) => {
      const value = Math.max(1, Math.min(20, parseInt(e.target.value) || 1));
      if (sliderEl) sliderEl.value = value;
      sampleCountInputEl.value = value;
      state.sampleSelection.numSamples = value;
      recomputeCandidateSamples();
      updateLoadButtonText();
    });
  }
  
  // Combine mode toggle
  if (combineAndBtn) {
    combineAndBtn.addEventListener('click', () => {
      state.sampleSelection.combineMode = 'AND';
      combineAndBtn.classList.add('active');
      if (combineOrBtn) {
        combineOrBtn.classList.remove('active');
        combineOrBtn.style.color = 'var(--muted)';
      }
      combineAndBtn.style.color = 'white';
      updateSampleContext();
      recomputeCandidateSamples();
    });
  }
  
  if (combineOrBtn) {
    combineOrBtn.addEventListener('click', () => {
      state.sampleSelection.combineMode = 'OR';
      combineOrBtn.classList.add('active');
      if (combineAndBtn) {
        combineAndBtn.classList.remove('active');
        combineAndBtn.style.color = 'var(--muted)';
      }
      combineOrBtn.style.color = 'white';
      updateSampleContext();
      recomputeCandidateSamples();
    });
  }
  
  // Load buttons
  if (replaceBtn && !replaceBtn._listenerAttached) {
    replaceBtn._listenerAttached = true;
    replaceBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      
      // Use button's disabled state as the loading flag
      if (replaceBtn.disabled) {
        return; // Prevent multiple simultaneous loads
      }
      
      if (state.selectedAlleles.size === 0) {
        console.warn('No alleles selected');
        return;
      }
      
      replaceBtn.disabled = true;
      
      const strategy = state.sampleSelection.strategy;
      const candidates = state.sampleSelection.candidateSamples;
      const selectedAlleles = Array.from(state.selectedAlleles);
      const numSamples = state.sampleSelection.numSamples || 1;
      
      // Select samples based on strategy (will pick new random samples each time for Random strategy)
      const selectedSamples = selectSamplesForStrategy(strategy, candidates, numSamples);
      
      // For carriers_controls strategy, determine which samples are carriers vs controls
      let sampleTypes = {};
      if (strategy === 'carriers_controls') {
        const carriersSet = new Set(candidates);
        for (const sampleId of selectedSamples) {
          sampleTypes[sampleId] = carriersSet.has(sampleId) ? 'carrier' : 'control';
        }
      }
      
      // Create Smart tracks based on selected samples (add, don't replace)
      const trackPromises = [];
      for (let i = 0; i < selectedSamples.length; i++) {
        const track = createSmartTrack(strategy, selectedAlleles);
        const sampleId = selectedSamples[i];
        
        // Set sampleType for carriers_controls strategy
        if (strategy === 'carriers_controls' && sampleTypes[sampleId]) {
          track.sampleType = sampleTypes[sampleId];
        }
        
        // Fetch reads
        trackPromises.push(
          fetchReadsForSmartTrack(track.id, strategy, track.selectedAlleles, sampleId)
            .catch(err => {
              console.error('Failed to load reads for Smart track:', err);
            })
        );
      }
      
      // Re-enable button after all tracks are created (reads may still be loading)
      Promise.all(trackPromises).finally(() => {
        replaceBtn.disabled = false;
      });
    });
  }
  
  if (addBtn && !addBtn._listenerAttached) {
    addBtn._listenerAttached = true;
    addBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      
      // Use button's disabled state as the loading flag
      if (addBtn.disabled) {
        return; // Prevent multiple simultaneous loads
      }
      
      if (state.selectedAlleles.size === 0) {
        console.warn('No alleles selected');
        return;
      }
      
      addBtn.disabled = true;
      
      const strategy = state.sampleSelection.strategy;
      const candidates = state.sampleSelection.candidateSamples;
      const selectedAlleles = Array.from(state.selectedAlleles);
      const numSamples = state.sampleSelection.numSamples || 1;
      
      // Select samples based on strategy
      const selectedSamples = selectSamplesForStrategy(strategy, candidates, numSamples);
      
      // For carriers_controls strategy, determine which samples are carriers vs controls
      let sampleTypes = {};
      if (strategy === 'carriers_controls') {
        const carriersSet = new Set(candidates);
        for (const sampleId of selectedSamples) {
          sampleTypes[sampleId] = carriersSet.has(sampleId) ? 'carrier' : 'control';
        }
      }
      
      // Create Smart tracks based on selected samples (add, don't replace)
      const trackPromises = [];
      for (let i = 0; i < selectedSamples.length; i++) {
        const track = createSmartTrack(strategy, selectedAlleles);
        const sampleId = selectedSamples[i];
        
        // Set sampleType for carriers_controls strategy
        if (strategy === 'carriers_controls' && sampleTypes[sampleId]) {
          track.sampleType = sampleTypes[sampleId];
        }
        
        // Fetch reads
        trackPromises.push(
          fetchReadsForSmartTrack(track.id, strategy, track.selectedAlleles, sampleId)
            .catch(err => {
              console.error('Failed to load reads for Smart track:', err);
            })
        );
      }
      
      // Re-enable button after all tracks are created (reads may still be loading)
      Promise.all(trackPromises).finally(() => {
        addBtn.disabled = false;
      });
    });
  }
  
  // Setup search
  setupSampleSearch();
  
  // Initial update
  updateSelectionDisplay();
  
  // Export updateSelectionDisplay so it can be called after selection changes
  window.updateSelectionDisplay = updateSelectionDisplay;
}

function ensureFlowContainers(flowLayouts) {
  if (!flow || flowLayouts.length <= 1) return;
  const variantTracksConfig = (window.GENOMESHADER_CONFIG && window.GENOMESHADER_CONFIG.variant_tracks) || [];
  if (variantTracksConfig.length <= 1) return;

  const expectedTrackIds = flowLayouts.map(l => String(l.track.id));
  const existingTrackEls = Array.from(flow.querySelectorAll(".flow-track"));
  const existingTrackIds = existingTrackEls.map(el => String(el.dataset.trackId || ""));
  const hasAllTracks = expectedTrackIds.length === existingTrackIds.length &&
    expectedTrackIds.every(id => existingTrackIds.includes(id));
  if (hasAllTracks) return;

  const flowWebGPUEl = document.getElementById("flowWebGPU");
  const flowOverlayEl = document.getElementById("flowOverlay");
  while (flow.firstChild) flow.removeChild(flow.firstChild);
  // Append flowWebGPU first so it is behind flow-tracks; then clicks in each track hit the correct track
  if (flowWebGPUEl) {
    flow.appendChild(flowWebGPUEl);
    flowWebGPUEl.style.pointerEvents = "none";
  }
  const flowTrackDivs = [];
  for (let i = 0; i < flowLayouts.length; i++) {
    const track = flowLayouts[i].track;
    const div = document.createElement("div");
    div.className = "flow-track";
    div.id = flowTrackDomId(track.id);
    div.dataset.trackId = String(track.id || "");
    div.style.position = "absolute";
    div.style.left = "0";
    div.style.width = "100%";
    const canvas = document.createElement("canvas");
    canvas.className = "canvas";
    canvas.id = flowCanvasDomId(track.id);
    div.appendChild(canvas);
    const overlay = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    overlay.setAttribute("class", "overlay flow-track-overlay");
    overlay.setAttribute("data-track-id", track.id);
    overlay.style.pointerEvents = "auto";
    div.appendChild(overlay);
    flowTrackDivs.push(div);
  }
  // Append in reverse order so the first configured track is on top.
  for (let i = flowTrackDivs.length - 1; i >= 0; i--) {
    flow.appendChild(flowTrackDivs[i]);
  }
  if (flowOverlayEl) flow.appendChild(flowOverlayEl);
}

function updateFlowAndReadsPosition() {
  const layout = getTrackLayout();
  const isVertical = isVerticalMode();
  const flowLayouts = layout.filter(l => l.track.id === "flow" || (l.track.id && l.track.id.startsWith("flow-")));
  if (flowLayouts.length > 0 && flow) {
    ensureFlowContainers(flowLayouts);
    const visible = flowLayouts.filter(l => !l.track.collapsed);
    if (visible.length === 0) {
      flow.style.display = "none";
    } else {
      if (isVertical) {
        const left = Math.min(...visible.map(l => l.contentLeft));
        const right = Math.max(...visible.map(l => l.contentLeft + l.contentWidth));
        flow.style.left = `${left}px`;
        flow.style.width = `${right - left}px`;
        flow.style.top = "0";
        flow.style.height = "100%";
      } else {
        const top = Math.min(...visible.map(l => l.contentTop));
        const bottom = Math.max(...visible.map(l => l.contentTop + l.contentHeight));
        flow.style.top = `${top}px`;
        flow.style.height = `${bottom - top}px`;
        flow.style.left = "0";
        flow.style.width = "100%";
      }
      flow.style.display = "block";
      let offset = 0;
      for (let i = 0; i < visible.length; i++) {
        const flowTrackEl = findFlowTrackElementByTrackId(visible[i].track.id);
        if (flowTrackEl) {
          const ch = visible[i].contentHeight;
          const cw = visible[i].contentWidth;
          if (isVertical) {
            flowTrackEl.style.top = "0";
            flowTrackEl.style.left = `${offset}px`;
            flowTrackEl.style.width = `${cw}px`;
            flowTrackEl.style.height = "100%";
            offset += cw;
          } else {
            flowTrackEl.style.top = `${offset}px`;
            flowTrackEl.style.height = `${ch}px`;
            offset += ch;
          }
        }
      }
    }
  }
  
  // Update Smart track container positions (actual rendering is done in renderSmartTrack)
  // This is just for initial positioning
  state.smartTracks.forEach(track => {
    const trackLayout = layout.find(l => l.track.id === track.id);
    if (trackLayout) {
      const renderer = state.smartTrackRenderers.get(track.id);
      if (renderer && renderer.container) {
        // Position is handled in renderSmartTrack, but we ensure container exists
      }
    }
  });
}

// -----------------------------
// Pan + Zoom helpers
// -----------------------------
function clampSpan(span) {
  const MIN_SPAN = 50;
  const MAX_SPAN = 5_000_000;
  return Math.max(MIN_SPAN, Math.min(MAX_SPAN, span));
}

function zoomByFactor(factor, anchorBp) {
  const oldSpan = state.endBp - state.startBp;
  const newSpan = clampSpan(oldSpan / factor);

  const leftFrac = (anchorBp - state.startBp) / oldSpan;
  const newStart = anchorBp - leftFrac * newSpan;

  state.startBp = newStart;
  state.endBp = newStart + newSpan;

  // Clamp to chromosome boundaries
  clampToChromosomeBounds();

  renderAll();
}

function panByPixels(dxPx, dyPx) {
  const isVertical = isVerticalMode();
  const deltaPx = isVertical ? (dyPx !== undefined ? dyPx : 0) : (dxPx !== undefined ? dxPx : 0);
  const deltaBp = deltaPx / state.pxPerBp;
  // In vertical mode: down = lower locus (increase), up = higher locus (decrease)
  // In horizontal mode: right = higher locus (increase), left = lower locus (decrease)
  if (isVertical) {
    state.startBp += deltaBp;
    state.endBp   += deltaBp;
  } else {
    state.startBp -= deltaBp;
    state.endBp   -= deltaBp;
  }

  // Clamp to chromosome boundaries
  clampToChromosomeBounds();

  // Placeholder heuristic for shifting the variant window
  const win = visibleVariantWindow();
  if (win.length > 0) {
    const first = win[0].pos;
    while (state.firstVariantIndex > 0 && first > state.endBp) state.firstVariantIndex--;
    while (state.firstVariantIndex + 1 < variants.length &&
           first < state.startBp - (state.endBp-state.startBp)*0.25) {
      state.firstVariantIndex++;
      if (state.firstVariantIndex + state.K > variants.length) break;
    }
    state.firstVariantIndex = Math.max(0, Math.min(state.firstVariantIndex, Math.max(0, variants.length - state.K)));
  }

  renderAll();
}

function anchorBpFromClientX(clientX) {
  const rectSource = (typeof tracksContainer !== 'undefined' && tracksContainer)
    ? tracksContainer
    : tracksSvg;
  const rect = rectSource.getBoundingClientRect();
  const xInPane = clientX - rect.left;
  return bpFromXGenome(xInPane, tracksWidthPx());
}
function anchorBpFromClientY(clientY) {
  const rectSource = (typeof tracksContainer !== 'undefined' && tracksContainer)
    ? tracksContainer
    : tracksSvg;
  const rect = rectSource.getBoundingClientRect();
  const yInPane = clientY - rect.top;
  return bpFromYGenome(yInPane, tracksHeightPx());
}
function anchorBpFromClient(clientX, clientY) {
  const isVertical = isVerticalMode();
  if (isVertical) {
    return anchorBpFromClientY(clientY);
  } else {
    return anchorBpFromClientX(clientX);
  }
}

// -----------------------------
// Interaction (right pane)
// -----------------------------

// Bind wheel, pointer, and dblclick events to main element
// Returns a destroy function to clean up listeners
function bindInteractions(root, state, main) {
  if (!main) {
    return { destroy() {} };
  }

  // Wheel: pan/zoom gestures
  // Use composedPath() as primary gate to ensure event is over viewport
  function shouldHandleWheel(e) {
    const path = e.composedPath ? e.composedPath() : [];
    return path.includes(main); // main is the viewport element that should pan/zoom
  }

  const onWheel = (e) => {
    // Extra safety: ignore wheel not originating inside this viewer
    const path = e.composedPath ? e.composedPath() : [];
    if (!path.includes(main)) return;

    // Allow scrolling in reads container - don't intercept wheel events there
    const readsEl = byId(root, "reads");
    if (readsEl) {
      // Check if event target is within reads container (including canvas children)
      const target = e.target;
      if (readsEl.contains(target) || path.includes(readsEl)) {
        // Check if reads container is scrollable and has overflow
        if (readsEl.scrollHeight > readsEl.clientHeight) {
          // Allow native scrolling - don't prevent default
          return;
        }
      }
    }

    // Allow scrolling in Smart Tracks even if container has pointer-events:none
    // Determine if wheel event is over a Smart Track content area
    const smartTracks = state.smartTracks || [];
    if (smartTracks.length > 0) {
      const layout = getTrackLayout();
      const svgRect = tracksSvg.getBoundingClientRect();
      const isVertical = isVerticalMode();
      const clientX = e.clientX;
      const clientY = e.clientY;
      const xInPane = clientX - svgRect.left;
      const yInPane = clientY - svgRect.top;
      for (const track of smartTracks) {
        const layoutItem = layout.find(l => l.track.id === track.id);
        if (!layoutItem) continue;
        const inTrack = isVertical
          ? (xInPane >= layoutItem.contentLeft && xInPane <= layoutItem.contentLeft + layoutItem.contentWidth)
          : (yInPane >= layoutItem.contentTop && yInPane <= layoutItem.contentTop + layoutItem.contentHeight);
        if (!inTrack) continue;

        const renderer = state.smartTrackRenderers.get(track.id);
        if (!renderer || !renderer.container) continue;
        const container = renderer.container;
        if (!container.classList.contains('scrollable')) continue;

        // Scroll the Smart Track container directly
        e.preventDefault();
        e.stopPropagation();
        const delta = isVertical ? e.deltaX : e.deltaY;
        const maxScroll = container.scrollHeight - container.clientHeight;
        if (maxScroll > 0) {
          const next = Math.max(0, Math.min(maxScroll, container.scrollTop + delta));
          if (next !== container.scrollTop) {
            container.scrollTop = next;
            renderSmartTrack(track.id);
          }
        }
        return;
      }
    }

    // Allow scrolling in Smart Track containers - don't intercept wheel events there
    const target = e.target;
    for (const [trackId, renderer] of state.smartTrackRenderers.entries()) {
      const smartContainer = renderer.container;
      if (smartContainer && (smartContainer.contains(target) || path.includes(smartContainer))) {
        // If smart track is scrollable, allow native scrolling
        if (smartContainer.classList.contains('scrollable')) {
          return;
        }
      }
    }

    const isPinchZoom = e.ctrlKey === true || e.metaKey === true;
    const isVertical = isVerticalMode();
    const dx = e.deltaX;
    const dy = e.deltaY;

    if (isPinchZoom) {
      // Handle pinch-to-zoom (trackpad gesture with ctrl/meta)
      e.preventDefault();
      e.stopPropagation(); // Prevent bubbling to window/document
      const zoomIntensity = 0.0018;
      // Use vertical delta for pinch zoom (standard trackpad convention)
      const factor = Math.exp(-dy * zoomIntensity);
      const anchorBp = isVertical 
        ? anchorBpFromClientY(e.clientY)
        : anchorBpFromClientX(e.clientX);
      zoomByFactor(factor, anchorBp);
      return;
    }
    
    if (isVertical) {
      // In vertical mode: vertical wheel = pan, horizontal wheel = zoom
      const wantPan = e.shiftKey || Math.abs(dy) > Math.abs(dx);
      
      if (wantPan) {
        e.preventDefault();
        e.stopPropagation(); // Prevent bubbling to window/document
        const panDy = e.shiftKey ? dx : dy;
        panByPixels(0, panDy);
        return;
      }

      e.preventDefault();
      e.stopPropagation(); // Prevent bubbling to window/document
      const zoomIntensity = 0.0018;
      const factor = Math.exp(-dx * zoomIntensity);

      const anchorBp = anchorBpFromClientY(e.clientY);
      zoomByFactor(factor, anchorBp);
    } else {
      // In horizontal mode: horizontal wheel = pan, vertical wheel = zoom
      const wantPan = e.shiftKey || Math.abs(dx) > Math.abs(dy);

      if (wantPan) {
        e.preventDefault();
        e.stopPropagation(); // Prevent bubbling to window/document
        const panDx = e.shiftKey ? dy : dx;
        panByPixels(-panDx, 0);
        return;
      }

      e.preventDefault();
      e.stopPropagation(); // Prevent bubbling to window/document
      const zoomIntensity = 0.0018;
      const factor = Math.exp(-dy * zoomIntensity);

      const anchorBp = anchorBpFromClientX(e.clientX);
      zoomByFactor(factor, anchorBp);
    }
  };

  const onPointerDown = (e) => {
    const target = e.target;
    // Don't start pan/drag if clicking on variant selection rects (flow overlay or per-track overlay)
    if (target && target.getAttribute && target.getAttribute("data-variant-id")) return;
    if (target && target.closest && (target.closest(".flow-track-overlay") || target.closest("#flowOverlay"))) return;
    // Don't start drag if clicking on a variant (for insertion expansion) in Locus track
    if (target && target.tagName && (target.tagName === "line" || target.tagName === "circle" || target.tagName === "rect")) {
      const stroke = target.getAttribute ? target.getAttribute("stroke") : null;
      if (stroke && (stroke === "var(--blue)" || stroke === cssVar("--blue") || stroke.includes("blue"))) {
        return;
      }
      if (target.getAttribute && target.getAttribute("fill") === "transparent" && target.getAttribute("width") === "10") {
        return;
      }
    }
    
    state.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    main.setPointerCapture(e.pointerId);

    if (state.pointers.size === 1) {
      state.dragging = true;
      state.lastX = e.clientX;
      state.lastY = e.clientY;
    } else {
      state.dragging = false;
    }
  };

  const onPointerMove = (e) => {
    if (!state.pointers.has(e.pointerId)) return;
    state.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (state.pointers.size === 2) {
      const pts = Array.from(state.pointers.values());
      const dx = pts[0].x - pts[1].x;
      const dy = pts[0].y - pts[1].y;
      const dist = Math.hypot(dx, dy);

      if (state.pinchStartDist == null) {
        state.pinchStartDist = dist;
        state.pinchStartSpan = (state.endBp - state.startBp);

        const midX = (pts[0].x + pts[1].x) / 2;
        const midY = (pts[0].y + pts[1].y) / 2;
        state.pinchAnchorBp = anchorBpFromClient(midX, midY);
      } else {
        const scale = dist / state.pinchStartDist; // >1 apart => zoom in
        const oldSpan = state.pinchStartSpan;
        const newSpan = clampSpan(oldSpan / scale);

        const anchorBp = state.pinchAnchorBp ?? (state.startBp + (state.endBp-state.startBp)/2);
        const leftFrac = (anchorBp - state.startBp) / (state.endBp - state.startBp);
        const newStart = anchorBp - leftFrac * newSpan;

        state.startBp = newStart;
        state.endBp = newStart + newSpan;

        // Clamp to chromosome boundaries
        clampToChromosomeBounds();

        renderAll();
      }
      return;
    }

    if (state.dragging) {
      const isVertical = isVerticalMode();
      const dx = e.clientX - state.lastX;
      const dy = e.clientY - state.lastY;
      state.lastX = e.clientX;
      state.lastY = e.clientY;
      if (isVertical) {
        panByPixels(0, -dy);
      } else {
        panByPixels(dx, 0);
      }
    }
  };

  function endPointer(e) {
    state.pointers.delete(e.pointerId);
    if (state.pointers.size < 2) {
      state.pinchStartDist = null;
      state.pinchStartSpan = null;
      state.pinchAnchorBp = null;
    }
    if (state.pointers.size === 0) state.dragging = false;
  }

  const onPointerUp = endPointer;
  const onPointerCancel = endPointer;

  const onDblClick = (e) => {
    const anchorBp = anchorBpFromClient(e.clientX, e.clientY);
    zoomByFactor(1.6, anchorBp);
  };

  // Attach event listeners
  main.addEventListener("wheel", onWheel, { passive: false });
  main.addEventListener("pointerdown", onPointerDown);
  main.addEventListener("pointermove", onPointerMove);
  main.addEventListener("pointerup", onPointerUp);
  main.addEventListener("pointercancel", onPointerCancel);
  main.addEventListener("dblclick", onDblClick);

  // Return destroy function
  return {
    destroy() {
      main.removeEventListener("wheel", onWheel, { passive: false });
      main.removeEventListener("pointerdown", onPointerDown);
      main.removeEventListener("pointermove", onPointerMove);
      main.removeEventListener("pointerup", onPointerUp);
      main.removeEventListener("pointercancel", onPointerCancel);
      main.removeEventListener("dblclick", onDblClick);
    }
  };
}

// Remove any wheel listeners on window/document that could cause global behavior
// Note: getEventListeners is a DevTools-only function, so this only works when DevTools is open
function removeGlobalWheelListeners() {
  if (typeof getEventListeners === 'function') {
    try {
      const windowWheel = getEventListeners(window).wheel;
      const docWheel = getEventListeners(document).wheel;
      if (windowWheel && windowWheel.length > 0) {
        windowWheel.forEach(listener => {
          try {
            window.removeEventListener("wheel", listener.listener, listener.useCapture);
          } catch (e) {
            console.warn("[gs] Failed to remove window wheel listener:", e);
          }
        });
      }
      if (docWheel && docWheel.length > 0) {
        docWheel.forEach(listener => {
          try {
            document.removeEventListener("wheel", listener.listener, listener.useCapture);
          } catch (e) {
            console.warn("[gs] Failed to remove document wheel listener:", e);
          }
        });
      }
    } catch (e) {
      console.warn("[gs] Error checking for global wheel listeners:", e);
    }
  }
}

// Remove global wheel listeners before binding our scoped ones
removeGlobalWheelListeners();

// Bind interactions and store destroy function
interactionBinding = bindInteractions(root, state, main);

// -----------------------------
// Track interactions (drag, resize)
// -----------------------------
if (trackControls) {
trackControls.addEventListener("pointerdown", (e) => {
  // Don't start drag if clicking on buttons or interactive elements
  const trackLabel = e.target.closest(".track-label");
  const isSmartTrackLabel = trackLabel && trackLabel.closest(".track-controls[data-track-id^='smart-track-']");
  
  if (e.target.closest(".track-collapse-btn") ||
      e.target.closest(".smart-track-close-btn") ||
      e.target.closest(".smart-track-reload-btn") ||
      e.target.closest(".smart-track-shuffle-btn") ||
      e.target.closest(".smart-track-label-input") ||
      isSmartTrackLabel ||
      e.target.closest("button") ||
      e.target.closest("select") ||
      e.target.closest("input")) {
    e.stopPropagation();
    return;
  }
  
  const controls = e.target.closest(".track-controls");
  const resizeHandle = e.target.closest(".track-resize-handle");
  
  if (resizeHandle) {
    // Start resizing
    e.stopPropagation();
    const trackId = resizeHandle.dataset.trackId;
    const track = state.tracks.find(t => t.id === trackId);
    if (!track) return;
    
    e.preventDefault();
    const isVertical = isVerticalMode();
    state.trackResizeState = {
      trackId,
      startX: e.clientX,
      startY: e.clientY,
      startHeight: track.height
    };
    trackControls.setPointerCapture(e.pointerId);
  } else if (controls) {
    // Start dragging for reorder
    e.stopPropagation();
    const trackId = controls.dataset.trackId;
    e.preventDefault();
    const isVertical = isVerticalMode();
    state.trackDragState = {
      trackId,
      startX: e.clientX,
      startY: e.clientY,
      offsetX: 0,
      offsetY: 0
    };
    trackControls.setPointerCapture(e.pointerId);
  }
});

trackControls.addEventListener("pointermove", (e) => {
  if (state.trackResizeState) {
    // Resizing
    const track = state.tracks.find(t => t.id === state.trackResizeState.trackId);
    if (!track) return;
    
    e.preventDefault();
    const isVertical = isVerticalMode();
    let delta;
    if (isVertical) {
      // In vertical mode, resize based on horizontal movement
      delta = e.clientX - state.trackResizeState.startX;
    } else {
      // In horizontal mode, resize based on vertical movement
      delta = e.clientY - state.trackResizeState.startY;
    }
    const newHeight = Math.max(track.minHeight, state.trackResizeState.startHeight + delta);
    track.height = newHeight;
    updateTracksHeight();
    renderAll();
  } else if (state.trackDragState) {
    // Dragging for reorder
    e.preventDefault();
    const isVertical = isVerticalMode();
    const dx = e.clientX - state.trackDragState.startX;
    const dy = e.clientY - state.trackDragState.startY;
    
    if (isVertical) {
      state.trackDragState.offsetX = dx;
    } else {
      state.trackDragState.offsetY = dy;
    }
    
    // Visual feedback: move the dragged track and show drop indicator
    const layout = getTrackLayout();
    const draggedItem = layout.find(l => l.track.id === state.trackDragState.trackId);
    if (draggedItem) {
      const container = trackControls.querySelector(`[data-track-id="${state.trackDragState.trackId}"]`);
      if (container) {
        // Move the dragged track
        if (isVertical) {
          container.style.transform = `translateX(${dx}px)`;
        } else {
          container.style.transform = `translateY(${dy}px)`;
        }
        container.style.zIndex = "1000";
        container.style.opacity = "0.7";
        container.style.filter = "drop-shadow(0 4px 8px rgba(0,0,0,0.3))";
        container.classList.add("track-dragging");
        
        // Calculate and show drop indicator
        let dropIndex = 0;
        if (isVertical) {
          const newX = draggedItem.left + dx;
          for (let i = 0; i < layout.length; i++) {
            if (newX > layout[i].left + layout[i].width / 2) {
              dropIndex = i + 1;
            }
          }
        } else {
          const newY = draggedItem.top + dy;
          for (let i = 0; i < layout.length; i++) {
            if (newY > layout[i].top + layout[i].height / 2) {
              dropIndex = i + 1;
            }
          }
        }
        dropIndex = Math.max(0, Math.min(dropIndex, layout.length - 1));
        
        // Remove existing drop indicator
        const existingIndicator = document.querySelector(".track-drop-indicator");
        if (existingIndicator) {
          existingIndicator.remove();
        }
        
        // Create drop indicator at the calculated position
        if (dropIndex < layout.length) {
          const dropTarget = layout[dropIndex];
          // Position indicator before the drop target
          const indicatorPosition = isVertical ? dropTarget.left : dropTarget.top;
          
          const indicator = document.createElement("div");
          indicator.className = "track-drop-indicator";
          indicator.style.position = "absolute";
          indicator.style.pointerEvents = "none";
          indicator.style.zIndex = "999";
          indicator.style.backgroundColor = "var(--accent)";
          indicator.style.opacity = "0.8";
          
          if (isVertical) {
            indicator.style.left = `${indicatorPosition}px`;
            indicator.style.top = "0";
            indicator.style.width = "2px";
            indicator.style.height = "100%";
          } else {
            indicator.style.left = "0";
            indicator.style.top = `${indicatorPosition}px`;
            indicator.style.width = "100%";
            indicator.style.height = "2px";
          }
          
          const tracksContainer = document.getElementById("tracksContainer");
          if (tracksContainer) {
            tracksContainer.appendChild(indicator);
          }
        }
      }
    }
  }
});

function endTrackInteraction(e) {
  // Only process if we have an active interaction
  if (!state.trackResizeState && !state.trackDragState) return;
  
  // Release pointer capture
  if (e.target.releasePointerCapture) {
    try {
      e.target.releasePointerCapture(e.pointerId);
    } catch (err) {
      // Ignore if already released
    }
  }
  
  if (state.trackResizeState) {
    state.trackResizeState = null;
  } else if (state.trackDragState) {
    // Handle reordering
    const layout = getTrackLayout();
    const draggedItem = layout.find(l => l.track.id === state.trackDragState.trackId);
    if (draggedItem) {
      const container = trackControls.querySelector(`[data-track-id="${state.trackDragState.trackId}"]`);
      if (container) {
        container.style.transform = "";
        container.style.zIndex = "";
        container.style.opacity = "";
        container.style.filter = "";
        container.classList.remove("track-dragging");
      }
      
      // Remove drop indicator
      const existingIndicator = document.querySelector(".track-drop-indicator");
      if (existingIndicator) {
        existingIndicator.remove();
      }
      
      // Find new position based on orientation
      const isVertical = isVerticalMode();
      let newIndex = 0;
      if (isVertical) {
        const newX = draggedItem.left + state.trackDragState.offsetX;
        for (let i = 0; i < layout.length; i++) {
          if (newX > layout[i].left + layout[i].width / 2) {
            newIndex = i + 1;
          }
        }
      } else {
        const newY = draggedItem.top + state.trackDragState.offsetY;
        for (let i = 0; i < layout.length; i++) {
          if (newY > layout[i].top + layout[i].height / 2) {
            newIndex = i + 1;
          }
        }
      }
      newIndex = Math.max(0, Math.min(newIndex, layout.length - 1));
      
      // Reorder tracks
      const currentIndex = state.tracks.findIndex(t => t.id === state.trackDragState.trackId);
      if (currentIndex !== newIndex && currentIndex !== -1) {
        const [track] = state.tracks.splice(currentIndex, 1);
        state.tracks.splice(newIndex, 0, track);
        renderAll();
      } else {
        // Just re-render to reset visual state
        renderAll();
      }
    }
    state.trackDragState = null;
  }
}

trackControls.addEventListener("pointerup", endTrackInteraction);
trackControls.addEventListener("pointercancel", endTrackInteraction);

// Also listen on document to catch pointerup events that might occur outside
document.addEventListener("pointerup", (e) => {
  if (state.trackResizeState || state.trackDragState) {
    endTrackInteraction(e);
  }
});
document.addEventListener("pointercancel", (e) => {
  if (state.trackResizeState || state.trackDragState) {
    endTrackInteraction(e);
  }
});
}

// Resize - debounced to batch resize events (100ms delay)
new ResizeObserver(debounce(() => {
  // Handle WebGPU canvas resize
  if (webgpuCore && webgpuSupported) {
    try {
      webgpuCore.handleResize();
    } catch (error) {
      console.error("WebGPU resize error:", error);
    }
  }
  renderAll();
}, 100)).observe(flow);
new ResizeObserver(debounce(() => {
  // Handle WebGPU canvas resize when tracks container resizes
  if (webgpuCore && webgpuSupported) {
    try {
      webgpuCore.handleResize();
    } catch (error) {
      console.error("WebGPU resize error:", error);
    }
  }
  renderAll();
}, 100)).observe(tracksSvg);
window.addEventListener("resize", () => {
  // Handle WebGPU canvas resize
  if (webgpuCore && webgpuSupported) {
    try {
      webgpuCore.handleResize();
    } catch (error) {
      console.error("WebGPU resize error:", error);
    }
  }
  renderAll();
});

renderAll();
