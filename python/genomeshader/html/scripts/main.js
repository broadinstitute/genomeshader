// Render a Smart track
// -----------------------------

// Render a Smart track
function renderSmartTrack(trackId) {
  const track = state.smartTracks.find(t => t.id === trackId);
  if (!track) return;
  
  const layout = getTrackLayout();
  const trackLayout = layout.find(l => l.track.id === trackId);
  if (!trackLayout || trackLayout.track.collapsed) {
    // Hide container and clear renderer instances if collapsed
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
  // Ensure container is visible when track is expanded (we know it's not collapsed here)
  container.style.display = "block";
  
  if (!canvas || !webgpuCanvas) return;
  
  const dpr = window.devicePixelRatio || 1;
  const W = isVertical ? trackLayout.contentHeight : trackLayout.contentWidth;
  let H = isVertical ? trackLayout.contentWidth : trackLayout.contentHeight;
  
  // Calculate total content height if reads are loaded (horizontal mode)
  let totalContentHeight = H;
  if (!isVertical && track.readsLayout && track.readsLayout.reads && track.readsLayout.reads.length > 0) {
    const top = 8;
    const rowH = 18;
    const totalRows = track.readsLayout.rowCount || Math.max(...track.readsLayout.reads.map(r => r.row)) + 1;
    totalContentHeight = top + totalRows * rowH + 12;
    
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
    
    webgpuCanvas.style.height = totalContentHeight + 'px';
    webgpuCanvas.style.width = W + 'px';
    webgpuCanvas.style.gridRow = '1';
    webgpuCanvas.style.gridColumn = '1';
    webgpuCanvas.style.position = 'static';
    webgpuCanvas.style.inset = 'auto';
    
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
    }
  }
  
  const ctx = canvas.getContext("2d");
  ctx.setTransform(1,0,0,1,0,0);
  ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.scale(dpr, dpr);
  
  // Clear WebGPU renderer instances
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
      const isHovered = state.hoveredVariantIndex === idx;
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
    const top = 8;
    const rowH = 18;
    
    let totalRows = Math.floor((H - top - 12) / rowH);
    if (track.readsLayout && track.readsLayout.reads && track.readsLayout.reads.length > 0) {
      totalRows = track.readsLayout.rowCount || Math.max(...track.readsLayout.reads.map(r => r.row)) + 1;
      const scrollTop = container.scrollTop || 0;
      
      const startRow = Math.max(0, Math.floor(scrollTop / rowH) - 1);
      const endRow = Math.min(totalRows, Math.ceil((scrollTop + H) / rowH) + 1);
      
      ctx.strokeStyle = grid;
      ctx.lineWidth = 1;
      for (let i = startRow; i < endRow; i++) {
        const y = top + i*rowH + rowH/2 - scrollTop;
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
      const rows = Math.floor((H - top - 12) / rowH);
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
      for (const read of track.readsLayout.reads) {
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
        
        const x1 = xGenomeCanonical(read.start, W);
        const x2 = xGenomeCanonical(read.end, W);
        const y = top + read.row * rowH + 2 - scrollTop;
        const h = rowH - 4;
        const x = Math.max(0, x1);
        const w = Math.max(4, Math.min(x2, W) - x);
        
        if (y + h < 0 || y > totalContentHeight) continue;
        
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
        
        // Draw insertion/deletion/diff markers (horizontal mode)
        if (read.elements && read.elements.length > 0) {
          for (const elem of read.elements) {
            if (elem.start < state.startBp || elem.start > state.endBp) continue;
            const ex = xGenomeCanonical(elem.start, W);
            const ey = y;
            const eh = h;
            
            if (elem.type === 2) { // Insertion - purple tick
              ctx.fillStyle = 'rgba(200,100,255,0.9)';
              ctx.fillRect(ex - 1, ey, 2, eh);
            } else if (elem.type === 3) { // Deletion - black gap
              const ex2 = xGenomeCanonical(elem.end, W);
              ctx.fillStyle = 'rgba(0,0,0,0.4)';
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
              
              // Draw background
              const drawWidth = Math.max(2, actualBaseWidth);
              ctx.fillStyle = bgColor;
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
      const isHovered = state.hoveredVariantIndex === idx;
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
      const width = webgpuCanvas.clientWidth * dpr;
      let height = webgpuCanvas.clientHeight * dpr;
      if (!isVertical && track.readsLayout && track.readsLayout.reads && track.readsLayout.reads.length > 0) {
        height = totalContentHeight * dpr;
        webgpuCanvas.height = height;
      }
      
      if (webgpuCanvas.width !== width || webgpuCanvas.height !== height) {
        webgpuCanvas.width = width;
        webgpuCanvas.height = height;
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
      console.error(`Smart track ${trackId} WebGPU render error:`, error);
      if (instancedRenderer) instancedRenderer.clear();
    }
  } else if (webgpuSupported && instancedRenderer) {
    // Clear WebGPU canvas if no instances
    try {
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
const trackControls = document.getElementById("trackControls");
function renderTrackControls() {
  trackControls.innerHTML = "";
  const layout = getTrackLayout();
  const isVertical = isVerticalMode();

  for (const item of layout) {
    const track = item.track;
    const container = document.createElement("div");
    container.className = "track-control-container";
    
    if (isVertical) {
      container.style.position = "absolute";
      container.style.left = `${item.left}px`;
      container.style.width = `${item.width}px`;
      container.style.top = "0";
      container.style.height = "100%";
    } else {
      container.style.position = "absolute";
      container.style.left = "0";
      container.style.right = "0";
      container.style.top = `${item.top}px`;
      container.style.height = `${item.height}px`;
    }
    container.dataset.trackId = track.id;

    const controls = document.createElement("div");
    controls.className = "track-controls";
    controls.dataset.trackId = track.id;

    const collapseBtn = document.createElement("button");
    collapseBtn.className = "track-collapse-btn";
    if (isVertical) {
      collapseBtn.textContent = track.collapsed ? "▲" : "▶";
    } else {
      collapseBtn.textContent = track.collapsed ? "▶" : "▼";
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
    
    // Check if this is a Smart track
    const isSmartTrack = track.id.startsWith("smart-track-");
    
    if (isSmartTrack) {
      // Make label editable for Smart tracks
      label.style.cursor = "text";
      label.contentEditable = false;
      label.title = "Click to edit label";
      
      // Create input field for editing (hidden initially)
      const labelInput = document.createElement("input");
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
      
      // Click handler to start editing
      label.addEventListener("click", (e) => {
        e.stopPropagation();
        label.style.display = "none";
        labelInput.style.display = "inline-block";
        labelInput.focus();
        labelInput.select();
      });
      
      // Save on blur or Enter
      const saveLabel = () => {
        const newLabel = labelInput.value.trim() || track.label;
        label.textContent = newLabel;
        label.style.display = "";
        labelInput.style.display = "none";
        editSmartTrackLabel(track.id, newLabel);
      };
      
      labelInput.addEventListener("blur", saveLabel);
      labelInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          saveLabel();
        } else if (e.key === "Escape") {
          e.preventDefault();
          labelInput.value = track.label;
          label.style.display = "";
          labelInput.style.display = "none";
        }
      });
      
      label.textContent = track.label;
      controls.appendChild(labelInput);
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
      // Strategy dropdown
      const strategySelect = document.createElement("select");
      strategySelect.className = "smart-track-strategy-select";
      strategySelect.id = `smart-track-strategy-${track.id}`;
      strategySelect.name = `smart-track-strategy-${track.id}`;
      strategySelect.style.fontSize = "11px";
      strategySelect.style.padding = "2px 4px";
      strategySelect.style.border = "1px solid var(--border2)";
      strategySelect.style.borderRadius = "4px";
      strategySelect.style.background = "var(--panel)";
      strategySelect.style.color = "var(--text)";
      strategySelect.style.marginLeft = "6px";
      strategySelect.style.cursor = "pointer";
      
      const strategies = [
        { value: "best_evidence", label: "Best evidence" },
        { value: "most_diverse", label: "Most diverse" },
        { value: "compare_branches", label: "Compare branches" },
        { value: "carriers_controls", label: "Carriers + controls" },
        { value: "random", label: "Random" }
      ];
      
      strategies.forEach(s => {
        const option = document.createElement("option");
        option.value = s.value;
        option.textContent = s.label;
        if (s.value === track.strategy) {
          option.selected = true;
        }
        strategySelect.appendChild(option);
      });
      
      strategySelect.addEventListener("change", (e) => {
        e.stopPropagation();
        updateSmartTrackStrategy(track.id, e.target.value);
      });
      strategySelect.style.pointerEvents = "auto";
      strategySelect.style.zIndex = "20";
      
      // Reload button (reload current sample)
      const reloadBtn = document.createElement("button");
      reloadBtn.className = "smart-track-reload-btn";
      reloadBtn.textContent = "↻";
      reloadBtn.title = "Reload sample";
      reloadBtn.type = "button";
      reloadBtn.style.fontSize = "16px";
      reloadBtn.style.padding = "0";
      reloadBtn.style.border = "none";
      reloadBtn.style.borderRadius = "0";
      reloadBtn.style.background = "transparent";
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
      shuffleBtn.style.border = "none";
      shuffleBtn.style.borderRadius = "0";
      shuffleBtn.style.background = "transparent";
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
      closeBtn.textContent = "×";
      closeBtn.title = "Close track";
      closeBtn.type = "button";
      closeBtn.style.fontSize = "16px";
      closeBtn.style.padding = "0";
      closeBtn.style.border = "none";
      closeBtn.style.borderRadius = "0";
      closeBtn.style.background = "transparent";
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
        controls.appendChild(strategySelect);
        controls.appendChild(reloadBtn);
        controls.appendChild(shuffleBtn);
        controls.appendChild(closeBtn);
        controls.appendChild(collapseBtn);
        container.appendChild(controls);
      } else {
        controls.appendChild(collapseBtn);
        controls.appendChild(label);
        controls.appendChild(strategySelect);
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

// Update Locus track variant element hover styles
function updateLocusTrackHover() {
  state.locusVariantElements.forEach((elements, idx) => {
    const isHovered = state.hoveredVariantIndex === idx;
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

// Set up variant hover areas in canvas overlays
function setupVariantHoverAreas() {
  if (!flowOverlay) return;
  
  const isVertical = isVerticalMode();
  const clearSvg = (svg) => { while (svg.firstChild) svg.removeChild(svg.firstChild); };
  
  // Shared click handler for variant selection
  const handleVariantRectClick = (e, variantId) => {
    e.stopPropagation();
    
    // Find variant by ID
    const variant = variants.find(v => String(v.id) === String(variantId));
    if (!variant) return;
    
    // Get all alleles for this variant
    const { labels } = getFormattedLabelsForVariant(variant);
    let order = state.variantAlleleOrder.get(variant.id);
    if (!order || order.length !== labels.length) {
      order = [...labels];
      state.variantAlleleOrder.set(variant.id, order);
    }
    
    // Create label keys for all alleles: "variantId:alleleIndex"
    const variantAlleleKeys = order.map((label, alleleIndex) => `${variant.id}:${alleleIndex}`);
    
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
  
  // Create hover areas for Variants/Haplotypes track
  const win = visibleVariantWindow();
  const variantMode = getVariantLayoutMode();
  
  if (isVertical) {
    const junctionX = 70;
    const left = 8;
    
    for (let i = 0; i < win.length; i++) {
      const v = win[i];
      const variantIdx = variants.findIndex(v2 => v2.id === v.id);
      if (variantIdx === -1) continue;
      
      const cy = variantMode === "genomic"
        ? yGenomeCanonical(v.pos, flowH)
        : yColumn(i, win.length);
      
      // Create hover rectangle for the column
      const hoverRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      hoverRect.setAttribute("x", junctionX);
      hoverRect.setAttribute("y", cy - 8);
      hoverRect.setAttribute("width", Math.max(0, flowW - junctionX - 10));
      hoverRect.setAttribute("height", 16);
      hoverRect.setAttribute("fill", "transparent");
      hoverRect.setAttribute("data-variant-id", v.id);
      hoverRect.style.cursor = "pointer";
      hoverRect.style.pointerEvents = "auto";
      hoverRect.addEventListener("click", (e) => handleVariantRectClick(e, v.id));
      flowOverlay.appendChild(hoverRect);
    }
  } else {
    const junctionY = 40;
    
    for (let i = 0; i < win.length; i++) {
      const v = win[i];
      const variantIdx = state.firstVariantIndex + i;
      if (variantIdx >= variants.length) continue;
      const variant = variants[variantIdx];
      
      const cx = variantMode === "genomic"
        ? xGenomeCanonical(v.pos, flowW)
        : xColumn(i, win.length);
      
      // Create hover rectangle for the column
      const hoverRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      hoverRect.setAttribute("x", cx - 8);
      hoverRect.setAttribute("y", junctionY);
      hoverRect.setAttribute("width", 16);
      hoverRect.setAttribute("height", Math.max(0, flowH - junctionY - 10));
      hoverRect.setAttribute("fill", "transparent");
      hoverRect.setAttribute("data-variant-id", variant.id);
      hoverRect.style.cursor = "pointer";
      hoverRect.style.pointerEvents = "auto";
      hoverRect.addEventListener("click", (e) => handleVariantRectClick(e, variant.id));
      flowOverlay.appendChild(hoverRect);
    }
  }
  
  // Set up event delegation for hover detection
  // Use a single handler for all hover areas
  const handleVariantHover = (e) => {
    const target = e.target;
    const variantId = target.getAttribute("data-variant-id");
    if (!variantId) return;
    
    // Find variant index by ID
    const variantIdx = variants.findIndex(v => String(v.id) === String(variantId));
    if (variantIdx === -1) return;
    
    if (state.hoveredVariantIndex !== variantIdx) {
      state.hoveredVariantIndex = variantIdx;
      renderHoverOnly();
    }
  };
  
  const handleVariantLeave = (e) => {
    const target = e.target;
    if (target.hasAttribute("data-variant-id")) {
      if (state.hoveredVariantIndex !== null) {
        state.hoveredVariantIndex = null;
        renderHoverOnly();
      }
    }
  };
  
  // Remove old listeners if they exist (for hover only, clicks are now on rectangles)
  if (flowOverlay._variantHoverHandler) {
    flowOverlay.removeEventListener("mouseenter", flowOverlay._variantHoverHandler, true);
    flowOverlay.removeEventListener("mouseleave", flowOverlay._variantHoverHandler, true);
  }
  
  // Add new listeners with capture phase to catch events on child elements (hover only)
  flowOverlay._variantHoverHandler = handleVariantHover;
  flowOverlay._variantLeaveHandler = handleVariantLeave;
  flowOverlay.addEventListener("mouseenter", handleVariantHover, true);
  flowOverlay.addEventListener("mouseleave", handleVariantLeave, true);
}

// Selective rendering for hover-only state changes (no SVG rebuild)
function renderHoverOnly() {
  // Only redraw canvas elements affected by hover state
  // Skip expensive SVG rebuilds and layout recalculations
  updateLocusTrackHover(); // Update Locus track SVG hover styles
  renderFlowCanvas();
  updateTooltip();
}

function renderAll() {
  updateDerived();
  updateTracksHeight();
  renderTracks();
  renderTrackControls();
  updateFlowAndReadsPosition();
  renderFlowCanvas();
  // Render all Smart tracks
  state.smartTracks.forEach(track => {
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
    const win = visibleVariantWindow();
    
    if (isVertical) {
      const junctionX = 40;
      const H = flowHeightPx();
      const sortedWin = [...win].sort((a, b) => a.pos - b.pos);
      
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
      
      // Check if mouse is near a column line (horizontal in vertical mode)
      for (let i = 0; i < sortedWin.length; i++) {
        const v = sortedWin[i];
        // Position based on variant layout mode
        const cy = variantMode === "genomic"
          ? yGenomeCanonical(v.pos, H)
          : yColumn(i, sortedWin.length);
        const variantIdx = variants.findIndex(v2 => v2.id === v.id);
        
        if (Math.abs(y - cy) < 10 && x >= junctionX) {
          if (state.hoveredVariantIndex !== variantIdx) {
            state.hoveredVariantIndex = variantIdx;
            renderHoverOnly();
          }
          // Clear variant label tooltip when hovering column
          state.hoveredVariantLabelTooltip = null;
          updateTooltip();
          return;
        }
      }
      
      // Check if mouse is near a diagonal connector
      const x0 = 6;
      for (let i = 0; i < sortedWin.length; i++) {
        const v = sortedWin[i];
        if (v.pos < state.startBp || v.pos > state.endBp) continue;
        const vy = yGenomeCanonical(v.pos, H); // always genomic for ruler connection
        const cy = variantMode === "genomic"
          ? yGenomeCanonical(v.pos, H)
          : yColumn(i, sortedWin.length);
        const variantIdx = variants.findIndex(v2 => v2.id === v.id);
        
        const dist = Math.abs((x - x0) * (cy - vy) / (junctionX - x0) + vy - y);
        if (dist < 5 && x >= x0 && x <= junctionX) {
          if (state.hoveredVariantIndex !== variantIdx) {
            state.hoveredVariantIndex = variantIdx;
            renderHoverOnly();
          }
          // Clear variant label tooltip when hovering connector
          state.hoveredVariantLabelTooltip = null;
          updateTooltip();
          return;
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
      
      // Check if mouse is near a column line
      for (let i = 0; i < win.length; i++) {
        // Position based on variant layout mode
        const cx = variantMode === "genomic"
          ? xGenomeCanonical(win[i].pos, W)
          : xColumn(i, win.length);
        const variantIdx = state.firstVariantIndex + i;
        
        if (Math.abs(x - cx) < 10 && y >= junctionY) {
          if (state.hoveredVariantIndex !== variantIdx) {
            state.hoveredVariantIndex = variantIdx;
            renderHoverOnly();
          }
          // Clear variant label tooltip when hovering column
          state.hoveredVariantLabelTooltip = null;
          updateTooltip();
          return;
        }
      }
      
      // Check if mouse is near a diagonal connector
      const y0 = 6;
      for (let i = 0; i < win.length; i++) {
        const v = win[i];
        if (v.pos < state.startBp || v.pos > state.endBp) continue;
        const vx = xGenomeCanonical(v.pos, W); // always genomic for ruler connection
        const cx = variantMode === "genomic"
          ? xGenomeCanonical(v.pos, W)
          : xColumn(i, win.length);
        const variantIdx = state.firstVariantIndex + i;
        
        const dist = Math.abs((y - y0) * (cx - vx) / (junctionY - y0) + vx - x);
        if (dist < 5 && y >= y0 && y <= junctionY) {
          if (state.hoveredVariantIndex !== variantIdx) {
            state.hoveredVariantIndex = variantIdx;
            renderHoverOnly();
          }
          return;
        }
      }
    }
    
    // No variant hovered
    if (state.hoveredVariantIndex !== null) {
      state.hoveredVariantIndex = null;
      renderHoverOnly();
    }
    // Clear variant label tooltip when not hovering anything
    if (state.hoveredVariantLabelTooltip !== null) {
      state.hoveredVariantLabelTooltip = null;
      updateTooltip();
    }
  };
  
  flowLeaveHandler = () => {
    if (state.hoveredVariantIndex !== null || state.hoveredAlleleNode !== null) {
      state.hoveredVariantIndex = null;
      state.hoveredAlleleNode = null;
      renderHoverOnly();
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
    // Remove existing listeners
    if (alleleMouseDownHandler) {
      const oldTarget = flowWebGPU || flow;
      oldTarget.removeEventListener("mousedown", alleleMouseDownHandler);
      document.removeEventListener("mousemove", alleleMouseMoveHandler);
      document.removeEventListener("mouseup", alleleMouseUpHandler);
    }
    
    alleleMouseDownHandler = (e) => {
      if (!window._alleleNodePositions || window._alleleNodePositions.length === 0) return;
      
      // Use flow container for coordinates (same coordinate system as flowCanvas)
      const rect = flow.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      
      // Find which node was clicked
      for (const node of window._alleleNodePositions) {
        if (x >= node.x && x <= node.x + node.w && 
            y >= node.y && y <= node.y + node.h) {
          e.preventDefault();
          e.stopPropagation();
          state.alleleDragState = {
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
          return;
        }
      }
    };
    
    alleleMouseMoveHandler = (e) => {
      const rect = flow.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      
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
      const order = state.variantAlleleOrder.get(dragState.variantId);
      if (order) {
        const isVertical = isVerticalMode();
        const variantMode = getVariantLayoutMode();
        const win = visibleVariantWindow();
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
          const flowLayout = layout.find(l => l.track.id === "flow");
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
            renderFlowCanvas();
          }
          return;
        }
        
        // Find which node is hovered
        let hoveredNode = null;
        for (const node of window._alleleNodePositions) {
          if (x >= node.x && x <= node.x + node.w && 
              y >= node.y && y <= node.y + node.h) {
            hoveredNode = { variantId: node.variantId, alleleIndex: node.alleleIndex };
            break;
          }
        }
        
        // Update hover state if changed
        const currentHover = state.hoveredAlleleNode;
        if ((hoveredNode && (!currentHover || currentHover.variantId !== hoveredNode.variantId || currentHover.alleleIndex !== hoveredNode.alleleIndex)) ||
            (!hoveredNode && currentHover)) {
          state.hoveredAlleleNode = hoveredNode;
          renderFlowCanvas();
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
        const labelKey = `${dragState.variantId}:${dragState.alleleIndex}`;
        
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
      const order = state.variantAlleleOrder.get(dragState.variantId);
      if (!order) {
        state.alleleDragState = null;
        flowCanvas.style.cursor = "";
        if (flowWebGPU) flowWebGPU.style.cursor = "";
        renderFlowCanvas();
        return;
      }
      
      const isVertical = isVerticalMode();
      const variantMode = getVariantLayoutMode();
      const win = visibleVariantWindow();
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
        state.variantAlleleOrder.set(dragState.variantId, order);
      }
      
      state.alleleDragState = null;
      flowCanvas.style.cursor = "";
      if (flowWebGPU) flowWebGPU.style.cursor = "";
      renderFlowCanvas();
    };
    
    // Attach to flowWebGPU canvas (which is on top) or flow container
    // Both flowCanvas and flowWebGPU are inside flow, so coordinates are relative to flow
    const targetElement = flowWebGPU || flow;
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
      const [variantId, alleleIndexStr] = key.split(':');
      const alleleIndex = parseInt(alleleIndexStr, 10);
      
      // Find the variant
      const variant = variants.find(v => v.id === variantId);
      if (!variant) continue;
      
      // Find the node position info to get the label
      const nodeInfo = window._alleleNodePositions?.find(n => 
        n.variantId === variantId && n.alleleIndex === alleleIndex
      );
      
      selectedInfo.push({
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
      const [variantId, alleleIndexStr] = key.split(':');
      const alleleIndex = parseInt(alleleIndexStr, 10);
      
      const variant = variants.find(v => v.id === variantId);
      if (!variant) continue;
      
      selectedAllelePairs.push({
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
      const sampleGenotypes = pair.variant.sampleGenotypes || {};
      Object.keys(sampleGenotypes).forEach(sampleId => allSamplesSet.add(sampleId));
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
      const firstGenotypes = firstPair.variant.sampleGenotypes || {};
      const firstGenotypeIndex = alleleIndexToGenotypeIndex(firstPair.alleleIndex);
      
      // Only process if first allele is valid
      if (firstGenotypeIndex !== null) {
        for (const sampleId of Object.keys(firstGenotypes)) {
          const genotype = firstGenotypes[sampleId];
          
          // Check if this sample has the first allele
          if (hasAlleleInGenotype(genotype, firstGenotypeIndex)) {
            // Check if this sample has ALL other selected alleles
            let hasAllAlleles = true;
            for (let i = 1; i < selectedAllelePairs.length; i++) {
              const pair = selectedAllelePairs[i];
              const pairGenotypes = pair.variant.sampleGenotypes || {};
              const pairGenotype = pairGenotypes[sampleId];
              
              if (!pairGenotype) {
                hasAllAlleles = false;
                break;
              }
              
              const pairGenotypeIndex = alleleIndexToGenotypeIndex(pair.alleleIndex);
              if (pairGenotypeIndex === null || !hasAlleleInGenotype(pairGenotype, pairGenotypeIndex)) {
                hasAllAlleles = false;
                break;
              }
            }
            
            if (hasAllAlleles) {
              candidateSamplesSet.add(sampleId);
            }
          }
        }
      }
    } else {
      // OR mode: Sample must have ANY of the selected alleles
      // Iterate through each variant's samples directly (more efficient than collecting all first)
      for (const pair of selectedAllelePairs) {
        const sampleGenotypes = pair.variant.sampleGenotypes || {};
        const genotypeIndex = alleleIndexToGenotypeIndex(pair.alleleIndex);
        
        // Skip no-call alleles (alleleIndex 0)
        if (genotypeIndex === null) continue;
        
        // Iterate through samples that have genotype data for this variant
        for (const sampleId of Object.keys(sampleGenotypes)) {
          const genotype = sampleGenotypes[sampleId];
          if (hasAlleleInGenotype(genotype, genotypeIndex)) {
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
      const [variantId, alleleIndexStr] = key.split(':');
      const alleleIndex = parseInt(alleleIndexStr, 10);
      
      const variant = variants.find(v => v.id === variantId);
      if (!variant) continue;
      
      selectedAllelePairs.push({
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
      const firstGenotypes = firstPair.variant.sampleGenotypes || {};
      const firstGenotypeIndex = alleleIndexToGenotypeIndex(firstPair.alleleIndex);
      
      if (firstGenotypeIndex !== null) {
        for (const sampleId of Object.keys(firstGenotypes)) {
          const genotype = firstGenotypes[sampleId];
          
          if (hasAlleleInGenotype(genotype, firstGenotypeIndex)) {
            let hasAllAlleles = true;
            for (let i = 1; i < selectedAllelePairs.length; i++) {
              const pair = selectedAllelePairs[i];
              const pairGenotypes = pair.variant.sampleGenotypes || {};
              const pairGenotype = pairGenotypes[sampleId];
              
              if (!pairGenotype) {
                hasAllAlleles = false;
                break;
              }
              
              const pairGenotypeIndex = alleleIndexToGenotypeIndex(pair.alleleIndex);
              if (pairGenotypeIndex === null || !hasAlleleInGenotype(pairGenotype, pairGenotypeIndex)) {
                hasAllAlleles = false;
                break;
              }
            }
            
            if (hasAllAlleles) {
              candidateSamplesSet.add(sampleId);
            }
          }
        }
      }
    } else {
      // OR mode: Sample must have ANY of the selected alleles
      for (const pair of selectedAllelePairs) {
        const sampleGenotypes = pair.variant.sampleGenotypes || {};
        const genotypeIndex = alleleIndexToGenotypeIndex(pair.alleleIndex);
        
        if (genotypeIndex === null) continue;
        
        for (const sampleId of Object.keys(sampleGenotypes)) {
          const genotype = sampleGenotypes[sampleId];
          if (hasAlleleInGenotype(genotype, genotypeIndex)) {
            candidateSamplesSet.add(sampleId);
          }
        }
      }
    }
    
    return Array.from(candidateSamplesSet).sort();
  }
  
  // Export for use in smart-tracks.js
  window.computeCandidateSamplesForAlleles = computeCandidateSamplesForAlleles;
  
  // Helper: Select samples based on strategy
  // Returns an array of sample IDs to use for creating Smart Tracks
  function selectSamplesForStrategy(strategy, candidates, numSamples) {
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
            // TODO: Load reads for this sample
            console.log('Load sample:', sampleId);
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
        const firstResult = resultsEl.querySelector('.sampleSearchResult');
        if (firstResult) {
          firstResult.click();
        }
      }
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
      
      // Create Smart tracks based on selected samples (add, don't replace)
      const trackPromises = [];
      for (let i = 0; i < selectedSamples.length; i++) {
        const track = createSmartTrack(strategy, selectedAlleles);
        const sampleId = selectedSamples[i];
        
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
      
      // Create Smart tracks based on selected samples (add, don't replace)
      const trackPromises = [];
      for (let i = 0; i < selectedSamples.length; i++) {
        const track = createSmartTrack(strategy, selectedAlleles);
        const sampleId = selectedSamples[i];
        
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

function updateFlowAndReadsPosition() {
  const layout = getTrackLayout();
  const isVertical = isVerticalMode();
  
  const flowLayout = layout.find(l => l.track.id === "flow");
  if (flowLayout && flow) {
    if (isVertical) {
      flow.style.left = `${flowLayout.contentLeft}px`;
      flow.style.width = flowLayout.track.collapsed ? "0px" : `${flowLayout.contentWidth}px`;
      flow.style.top = "0";
      flow.style.height = "100%";
    } else {
      flow.style.top = `${flowLayout.contentTop}px`;
      flow.style.height = flowLayout.track.collapsed ? "0px" : `${flowLayout.contentHeight}px`;
      flow.style.left = "0";
      flow.style.width = "100%";
    }
    flow.style.display = flowLayout.track.collapsed ? "none" : "block";
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
  const rect = tracksSvg.getBoundingClientRect();
  const xInPane = clientX - rect.left;
  return bpFromXGenome(xInPane, tracksWidthPx());
}
function anchorBpFromClientY(clientY) {
  const rect = tracksSvg.getBoundingClientRect();
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
    // Don't start drag if clicking on a variant (for insertion expansion)
    // Check if clicking on SVG elements that are variants
    const target = e.target;
    if (target && target.tagName && (target.tagName === "line" || target.tagName === "circle" || target.tagName === "rect")) {
      // Check if this is a variant element (has blue stroke or is in the variant area)
      const stroke = target.getAttribute ? target.getAttribute("stroke") : null;
      if (stroke && (stroke === "var(--blue)" || stroke === cssVar("--blue") || stroke.includes("blue"))) {
        // This might be a variant - don't start dragging, let click handler work
        return;
      }
      // Also check if it's the invisible click area for insertions
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
  if (e.target.closest(".track-collapse-btn") ||
      e.target.closest(".smart-track-close-btn") ||
      e.target.closest(".smart-track-reload-btn") ||
      e.target.closest(".smart-track-shuffle-btn") ||
      e.target.closest(".smart-track-strategy-select") ||
      e.target.closest(".smart-track-label-input") ||
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
    
    // Visual feedback: move the dragged track
    const layout = getTrackLayout();
    const draggedItem = layout.find(l => l.track.id === state.trackDragState.trackId);
    if (draggedItem) {
      const container = trackControls.querySelector(`[data-track-id="${state.trackDragState.trackId}"]`);
      if (container) {
        if (isVertical) {
          container.style.transform = `translateX(${dx}px)`;
        } else {
          container.style.transform = `translateY(${dy}px)`;
        }
        container.style.zIndex = "100";
        container.style.opacity = "0.8";
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
