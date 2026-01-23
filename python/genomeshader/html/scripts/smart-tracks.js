// Smart Tracks
// -----------------------------

// Process raw reads data into a layout structure (used by Smart Tracks)
function processReadsData(rawReads) {
  if (!rawReads || !rawReads.query_name) return null;
  
  // Convert column-oriented data to row-oriented
  const numRows = rawReads.query_name.length;
  const reads = [];
  
  // Group by query_name to get unique reads (element_type 0 = READ)
  const readMap = new Map();
  for (let i = 0; i < numRows; i++) {
    if (rawReads.element_type[i] === 0) { // READ element
      const name = rawReads.query_name[i];
      if (!readMap.has(name)) {
        readMap.set(name, {
          name: name,
          start: rawReads.reference_start[i],
          end: rawReads.reference_end[i],
          isForward: rawReads.is_forward[i],
          haplotype: rawReads.haplotype[i],
          sample: rawReads.sample_name[i],
          elements: []
        });
      }
    }
  }
  
  // Add non-read elements (insertions, deletions, etc.)
  for (let i = 0; i < numRows; i++) {
    const name = rawReads.query_name[i];
    const read = readMap.get(name);
    if (read && rawReads.element_type[i] !== 0) {
      read.elements.push({
        type: rawReads.element_type[i],
        start: rawReads.reference_start[i],
        end: rawReads.reference_end[i],
        sequence: rawReads.sequence[i]
      });
    }
  }
  
  // Convert to array and sort by start position
  const readArray = Array.from(readMap.values());
  readArray.sort((a, b) => a.start - b.start);
  
  // Improved greedy packing: assign reads to rows, checking if read fits anywhere in each row
  const rows = [];
  for (const read of readArray) {
    let placed = false;
    // Try to place in existing rows
    for (let r = 0; r < rows.length; r++) {
      // Check if read can fit in this row (doesn't overlap with any existing read)
      let canFit = true;
      for (const existingRead of rows[r]) {
        // Check for overlap: read overlaps if it starts before existing ends and ends after existing starts
        if (!(read.end < existingRead.start - 10 || read.start > existingRead.end + 10)) {
          canFit = false;
          break;
        }
      }
      if (canFit) {
        read.row = r;
        rows[r].push(read);
        // Keep row sorted by start position for better packing
        rows[r].sort((a, b) => a.start - b.start);
        placed = true;
        break;
      }
    }
    if (!placed) {
      read.row = rows.length;
      rows.push([read]);
    }
  }
  
  // Only log in debug mode or for first few calls to avoid console spam
  // console.log('Genomeshader: Processed ' + readArray.length + ' reads into ' + rows.length + ' rows');
  return { reads: readArray, rowCount: rows.length };
}

// Create a new Smart track
function createSmartTrack(strategy, selectedAlleles) {
  const timestamp = Date.now();
  const index = state.smartTracks.length;
  const trackId = `smart-track-${timestamp}-${index}`;
  
  // Check if track with this ID already exists (shouldn't happen, but guard against it)
  if (state.smartTracks.find(t => t.id === trackId)) {
    console.warn(`Smart track ${trackId} already exists, skipping creation`);
    return state.smartTracks.find(t => t.id === trackId);
  }
  
  // console.log(`Creating Smart track ${trackId} (total tracks: ${state.smartTracks.length})`);
  
  // Create track object
  const track = {
    id: trackId,
    label: "Loading...",  // Initial label, will be updated when sample is loaded
    collapsed: true,  // true = closed (~22px single read) by default, false = open (220px)
    hidden: false,      // true = not displayed at all
    height: 220,       // Open height
    closedHeight: 22,  // Closed height (single read: 2px top + 18px row + 2px bottom, no header gap)
    minHeight: 50,
    strategy: strategy,
    selectedAlleles: new Set(selectedAlleles),
    sampleId: null,
    sampleType: null, // 'carrier' or 'control' (for carriers_controls strategy)
    readsData: null,
    readsLayout: null,
    loading: false,
    bamUrls: []
  };
  
  // Add to smartTracks array
  state.smartTracks.push(track);
  
  // Insert after the flow track
  const flowIndex = state.tracks.findIndex(t => t.id === "flow");
  const insertIndex = flowIndex >= 0 ? flowIndex + 1 : state.tracks.length;
  state.tracks.splice(insertIndex, 0, track);
  
  // Initialize WebGPU renderer (async, but don't await - it will complete in background)
  initSmartTrackWebGPU(trackId);
  
  // Update layout
  updateTracksHeight();
  renderAll();
  renderSmartTracksSidebar();
  
  return track;
}

// Initialize WebGPU renderer for a Smart track
async function initSmartTrackWebGPU(trackId) {
  // Check if renderer already exists - prevent re-initialization
  if (state.smartTrackRenderers.has(trackId)) {
    // console.log(`Smart track ${trackId}: WebGPU already initialized, skipping`);
    return;
  }
  
  if (!webgpuSupported || !navigator.gpu) {
    console.warn('WebGPU not supported, Smart track will use Canvas2D fallback');
    return;
  }
  
  const track = state.smartTracks.find(t => t.id === trackId);
  if (!track) return;
  
  // Find tracks container
  const tracksContainer = document.getElementById('tracksContainer');
  if (!tracksContainer) return;
  
  // Create container div for this Smart track
  const container = document.createElement('div');
  container.className = 'smart-track-container';
  container.id = `smart-track-container-${trackId}`;
  container.dataset.trackId = trackId;
  container.style.position = 'absolute';
  container.style.width = '100%';
  container.style.height = '100%';
  container.style.pointerEvents = 'none';
  
  // Create Canvas2D canvas
  const canvas = document.createElement('canvas');
  canvas.className = 'canvas';
  canvas.id = `smart-track-canvas-${trackId}`;
  canvas.style.position = 'absolute';
  canvas.style.top = '0';
  canvas.style.left = '0';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.pointerEvents = 'none';
  
  // Create WebGPU canvas
  const webgpuCanvas = document.createElement('canvas');
  webgpuCanvas.className = 'webgpu-canvas';
  webgpuCanvas.id = `smart-track-webgpu-${trackId}`;
  webgpuCanvas.style.position = 'absolute';
  webgpuCanvas.style.top = '0';
  webgpuCanvas.style.left = '0';
  webgpuCanvas.style.width = '100%';
  webgpuCanvas.style.height = '100%';
  webgpuCanvas.style.pointerEvents = 'none';
  
  container.appendChild(canvas);
  container.appendChild(webgpuCanvas);
  tracksContainer.appendChild(container);
  
  try {
    // Wait for canvas to have dimensions
    const checkDimensions = () => {
      const rect = webgpuCanvas.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    
    // Wait up to 2 seconds for dimensions
    for (let i = 0; i < 40; i++) {
      if (checkDimensions()) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    
    if (!checkDimensions()) {
      console.warn(`Smart track ${trackId}: Canvas dimensions not ready`);
      return;
    }
    
    // Initialize WebGPU
    const webgpuCore = new WebGPUCore();
    await webgpuCore.init(webgpuCanvas);
    const instancedRenderer = new InstancedRenderer(webgpuCore);
    
    // Store renderer objects
    state.smartTrackRenderers.set(trackId, {
      webgpuCore,
      instancedRenderer,
      canvas,
      webgpuCanvas,
      container
    });
    
    // Scroll and wheel handlers will be attached in renderSmartTrack when container becomes scrollable
    // But we need a basic scroll handler for re-rendering
    container.addEventListener("scroll", () => {
      renderSmartTrack(trackId);
    });
    
    console.log(`Smart track ${trackId}: WebGPU initialized`);
  } catch (error) {
    console.warn(`Smart track ${trackId}: Failed to initialize WebGPU:`, error);
    // Continue without WebGPU - will use Canvas2D fallback
    
    // Still store the renderer objects (without WebGPU)
    state.smartTrackRenderers.set(trackId, {
      webgpuCore: null,
      instancedRenderer: null,
      canvas,
      webgpuCanvas: null,
      container
    });
    
    // Scroll and wheel handlers will be attached in renderSmartTrack when container becomes scrollable
    // But we need a basic scroll handler for re-rendering
    container.addEventListener("scroll", () => {
      renderSmartTrack(trackId);
    });
  }
}

// Remove WebGPU renderer for a Smart track
function removeSmartTrackWebGPU(trackId) {
  const renderer = state.smartTrackRenderers.get(trackId);
  if (renderer) {
    // Clean up WebGPU resources
    if (renderer.webgpuCore && renderer.webgpuCore.device) {
      // WebGPU cleanup is handled automatically when canvas is removed
    }
    
    // Remove DOM elements
    if (renderer.container) {
      if (renderer.container.parentNode) {
        renderer.container.parentNode.removeChild(renderer.container);
      }
      // Also try to remove by ID as fallback
      const containerById = document.getElementById(`smart-track-container-${trackId}`);
      if (containerById && containerById.parentNode) {
        containerById.parentNode.removeChild(containerById);
      }
    }
    
    // Remove from Map
    state.smartTrackRenderers.delete(trackId);
  }
}

// Fetch reads for a Smart track
function fetchReadsForSmartTrack(trackId, strategy, selectedAlleles, sampleId) {
  const track = state.smartTracks.find(t => t.id === trackId);
  if (!track) {
    console.error(`Smart track ${trackId} not found`);
    return Promise.reject(new Error('Track not found'));
  }
  
  track.loading = true;
  renderAll();
  
  // Convert selectedAlleles Set to array
  const allelesArray = Array.from(selectedAlleles);
  
  return sendCommMessage('fetch_reads', {
    strategy: strategy,
    selected_alleles: allelesArray,
    sample_id: sampleId || null
  })
    .then(function(response) {
      track.loading = false;
      if (response.type === 'fetch_reads_response') {
        track.readsData = response.reads;
        track.readsLayout = processReadsData(response.reads);
        track.sampleId = sampleId || response.sample_id || null;
        track.bamUrls = response.bam_urls || [];
        
        // Update track label to use sample name
        updateSmartTrackLabel(track);
        
        // Set sampleType for carriers_controls strategy if not already set
        if (strategy === 'carriers_controls' && track.sampleId && !track.sampleType) {
          // Determine if this sample is a carrier or control
          const combineMode = state.sampleSelection.combineMode;
          const carriers = window.computeCandidateSamplesForAlleles 
            ? window.computeCandidateSamplesForAlleles(selectedAlleles, combineMode)
            : [];
          const carriersSet = new Set(carriers);
          track.sampleType = carriersSet.has(track.sampleId) ? 'carrier' : 'control';
        }
        
        renderAll();
        return track.readsLayout;
      } else if (response.type === 'fetch_reads_error') {
        console.error(`Failed to fetch reads for Smart track ${trackId}:`, response.error);
        throw new Error(response.error);
      }
      return null;
    })
    .catch(function(err) {
      track.loading = false;
      console.error(`Failed to fetch reads for Smart track ${trackId}:`, err);
      renderAll();
      throw err;
    });
}

// Remove a Smart track
function removeSmartTrack(trackId) {
  // Remove from tracks array
  const trackIndex = state.tracks.findIndex(t => t.id === trackId);
  if (trackIndex >= 0) {
    state.tracks.splice(trackIndex, 1);
  }
  
  // Remove from smartTracks array
  const smartIndex = state.smartTracks.findIndex(t => t.id === trackId);
  if (smartIndex >= 0) {
    state.smartTracks.splice(smartIndex, 1);
  }
  
  // Clean up WebGPU renderer
  removeSmartTrackWebGPU(trackId);
  
  // Update layout and re-render
  updateTracksHeight();
  renderAll();
  renderSmartTracksSidebar();
}

// Update Smart track strategy and reload
function updateSmartTrackStrategy(trackId, newStrategy) {
  const track = state.smartTracks.find(t => t.id === trackId);
  if (!track) return;
  
  track.strategy = newStrategy;
  
  // Get candidate samples based on new strategy
  const candidates = state.sampleSelection.candidateSamples;
  const sampleId = candidates && candidates.length > 0 ? candidates[0] : null;
  
  // Fetch reads with new strategy
  fetchReadsForSmartTrack(trackId, newStrategy, track.selectedAlleles, sampleId)
    .catch(err => {
      console.error(`Failed to update strategy for track ${trackId}:`, err);
    });
}

// Reload Smart track (reload with current sample)
function reloadSmartTrack(trackId) {
  const track = state.smartTracks.find(t => t.id === trackId);
  if (!track) return;
  
  // Reload with the same sample ID
  fetchReadsForSmartTrack(trackId, track.strategy, track.selectedAlleles, track.sampleId)
    .catch(err => {
      console.error(`Failed to reload track ${trackId}:`, err);
    });
}

// Shuffle Smart track (choose a new/different sample)
function shuffleSmartTrack(trackId) {
  const track = state.smartTracks.find(t => t.id === trackId);
  if (!track) return;
  
  // For carriers_controls strategy, preserve the sample type (carrier vs control)
  if (track.strategy === 'carriers_controls' && track.sampleType) {
    // Get all available samples
    const allSamples = state.sampleSelection.allSampleIds || [];
    if (allSamples.length === 0) {
      console.warn(`No samples available for shuffling track ${trackId}`);
      return;
    }
    
    // Compute candidates for this track's alleles
    const combineMode = state.sampleSelection.combineMode;
    const carriers = window.computeCandidateSamplesForAlleles 
      ? window.computeCandidateSamplesForAlleles(track.selectedAlleles, combineMode)
      : [];
    
    // Compute controls: samples that are NOT carriers
    const carriersSet = new Set(carriers);
    const controls = allSamples.filter(sampleId => !carriersSet.has(sampleId));
    
    // Get candidates based on sample type
    let typeCandidates = [];
    if (track.sampleType === 'carrier') {
      typeCandidates = carriers.filter(s => s !== track.sampleId);
    } else if (track.sampleType === 'control') {
      typeCandidates = controls.filter(s => s !== track.sampleId);
    }
    
    if (typeCandidates.length === 0) {
      // If no other samples of this type, allow the same sample or fallback
      if (track.sampleType === 'carrier' && carriers.length > 0) {
        typeCandidates = carriers;
      } else if (track.sampleType === 'control' && controls.length > 0) {
        typeCandidates = controls;
      } else {
        console.warn(`No ${track.sampleType} samples available for shuffling track ${trackId}`);
        return;
      }
    }
    
    // Pick a random sample from the type-specific candidates
    const randomIndex = Math.floor(Math.random() * typeCandidates.length);
    const sampleId = typeCandidates[randomIndex];
    
    // Fetch reads with new sample (preserving the sampleType)
    fetchReadsForSmartTrack(trackId, track.strategy, track.selectedAlleles, sampleId)
      .catch(err => {
        console.error(`Failed to shuffle track ${trackId}:`, err);
      });
    
    return;
  }
  
  // For other strategies, use the original logic
  // Compute candidate samples for this track's specific alleles
  // Use the track's strategy and the current combine mode
  const combineMode = state.sampleSelection.combineMode;
  const candidates = window.computeCandidateSamplesForAlleles 
    ? window.computeCandidateSamplesForAlleles(track.selectedAlleles, combineMode)
    : [];
  
  if (!candidates || candidates.length === 0) {
    console.warn(`No candidate samples found for track ${trackId}`);
    return;
  }
  
  // Select a new sample based on the track's strategy
  let sampleId = null;
  
  if (window.selectSamplesForStrategy && track.strategy) {
    // Use the strategy-based selection (for Random, this will pick a random sample)
    const selectedSamples = window.selectSamplesForStrategy(track.strategy, candidates, 1);
    if (selectedSamples.length > 0) {
      sampleId = selectedSamples[0];
      
      // If we got the same sample and there are other candidates, try to get a different one
      if (sampleId === track.sampleId && candidates.length > 1) {
        // Filter out the current sample and pick randomly from the rest
        const otherCandidates = candidates.filter(s => s !== track.sampleId);
        if (otherCandidates.length > 0) {
          sampleId = otherCandidates[Math.floor(Math.random() * otherCandidates.length)];
        }
      }
    }
  } else {
    // Fallback: pick a random different sample
    if (candidates.length === 1) {
      sampleId = candidates[0];
    } else {
      // Try to get a different sample
      const otherCandidates = track.sampleId 
        ? candidates.filter(s => s !== track.sampleId)
        : candidates;
      if (otherCandidates.length > 0) {
        sampleId = otherCandidates[Math.floor(Math.random() * otherCandidates.length)];
      } else {
        sampleId = candidates[Math.floor(Math.random() * candidates.length)];
      }
    }
  }
  
  // Fetch reads with new sample
  if (sampleId) {
    fetchReadsForSmartTrack(trackId, track.strategy, track.selectedAlleles, sampleId)
      .catch(err => {
        console.error(`Failed to shuffle track ${trackId}:`, err);
      });
  }
}

// Update Smart track label based on sampleId or BAM URLs
// Note: This function uses getBasename and truncatePath from main.js,
// which are available at runtime after all scripts are loaded
function updateSmartTrackLabel(track) {
  if (!track) return;
  
  let newLabel;
  
  // Use sampleId (VCF sample name from sample mapping) if available
  if (track.sampleId) {
    newLabel = track.sampleId;
  } else if (track.bamUrls && track.bamUrls.length > 0) {
    // Fallback to BAM basenames if sampleId not available
    // Use functions from main.js (available at runtime)
    const isInlineMode = (window.GENOMESHADER_CONFIG && window.GENOMESHADER_CONFIG.hostMode === 'inline');
    
    if (isInlineMode) {
      // In inline mode: show only basename(s)
      if (track.bamUrls.length === 1) {
        newLabel = getBasename(track.bamUrls[0]);
      } else {
        newLabel = track.bamUrls.map(url => getBasename(url)).join(", ");
      }
    } else {
      // In overlay mode: show full path(s) with truncation if needed
      const bamPath = track.bamUrls.length === 1 
        ? track.bamUrls[0] 
        : track.bamUrls.join(", ");
      newLabel = truncatePath(bamPath, 80);
    }
  } else {
    // Fallback to default label if no sample info available
    const index = state.smartTracks.findIndex(t => t.id === track.id);
    newLabel = `Smart Track ${index + 1}`;
  }
  
  // Only update if label actually changed
  if (track.label !== newLabel) {
    editSmartTrackLabel(track.id, newLabel);
  }
}

// Update Smart track label
function editSmartTrackLabel(trackId, newLabel) {
  const track = state.smartTracks.find(t => t.id === trackId);
  if (!track) return;
  
  // Also update in tracks array
  const trackInArray = state.tracks.find(t => t.id === trackId);
  if (trackInArray) {
    trackInArray.label = newLabel;
  }
  
  track.label = newLabel;
  renderAll();
  renderSmartTracksSidebar();
}

// Right sidebar for Smart Tracks
// -----------------------------

// Render Smart Tracks list in right sidebar
function renderSmartTracksSidebar() {
  const smartTracksList = document.getElementById('smartTracksList');
  if (!smartTracksList) return;
  
  smartTracksList.innerHTML = '';

  const applySmartTrackOrderFromDom = () => {
    const items = Array.from(smartTracksList.querySelectorAll('.smart-track-item'));
    const newOrder = items.map(item => item.dataset.trackId);
    if (newOrder.length === 0) return;

    const currentOrder = state.tracks
      .filter(t => t.id.startsWith('smart-track-'))
      .map(t => t.id);

    if (JSON.stringify(currentOrder) === JSON.stringify(newOrder)) {
      return;
    }

    const smartTrackMap = new Map();
    state.smartTracks.forEach(track => {
      smartTrackMap.set(track.id, track);
    });

    const orderedSmartTracks = newOrder
      .map(id => smartTrackMap.get(id))
      .filter(track => track);

    state.smartTracks = orderedSmartTracks;

    const allTracks = [...state.tracks];
    const reorderedTracks = [];
    let smartTracksInserted = false;

    for (const track of allTracks) {
      if (!track.id.startsWith('smart-track-')) {
        reorderedTracks.push(track);
        if (track.id === 'flow' && !smartTracksInserted) {
          reorderedTracks.push(...orderedSmartTracks);
          smartTracksInserted = true;
        }
      }
    }

    if (!smartTracksInserted) {
      reorderedTracks.push(...orderedSmartTracks);
    }

    state.tracks = reorderedTracks;
    updateTracksHeight();
    renderAll();
    setTimeout(() => {
      renderSmartTracksSidebar();
    }, 0);
  };
  
  // Get Smart Tracks in the order they appear in state.tracks
  const smartTracksInOrder = state.tracks
    .filter(t => t.id.startsWith('smart-track-'))
    .map(t => state.smartTracks.find(st => st.id === t.id))
    .filter(st => st !== undefined);
  
  if (smartTracksInOrder.length === 0) {
    const emptyMsg = document.createElement('div');
    emptyMsg.style.padding = '9px 10px';
    emptyMsg.style.fontSize = '11px';
    emptyMsg.style.color = 'var(--muted)';
    emptyMsg.textContent = 'No Smart Tracks';
    smartTracksList.appendChild(emptyMsg);
    return;
  }
  
  // Remove existing event listeners if any (to avoid duplicates)
  const existingDropHandler = smartTracksList._dropHandler;
  if (existingDropHandler) {
    smartTracksList.removeEventListener('drop', existingDropHandler);
    smartTracksList.removeEventListener('dragover', smartTracksList._dragoverHandler);
  }
  
  // Add drop handler to the container to catch all drops
  const handleContainerDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    
    // Remove dragging class from all items
    document.querySelectorAll('.smart-track-item.dragging').forEach(item => {
      item.classList.remove('dragging');
    });

    applySmartTrackOrderFromDom();
  };
  
  const handleContainerDragover = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };
  
  // Store handlers to allow removal later
  smartTracksList._dropHandler = handleContainerDrop;
  smartTracksList._dragoverHandler = handleContainerDragover;
  
  // Add drop handler to container
  smartTracksList.addEventListener('dragover', handleContainerDragover);
  smartTracksList.addEventListener('drop', handleContainerDrop);
  
  smartTracksInOrder.forEach((track, index) => {
    const item = document.createElement('div');
    item.className = 'smart-track-item';
    item.dataset.trackId = track.id;
    item.draggable = true;
    
    const header = document.createElement('div');
    header.className = 'smart-track-item-header';
    
    const label = document.createElement('div');
    label.className = 'smart-track-item-label';
    label.textContent = track.label;
    label.style.cursor = 'text';
    label.title = 'Click to edit label';
    
    // Create input field for editing (hidden initially)
    const labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.className = 'smart-track-item-label-input';
    labelInput.value = track.label;
    labelInput.style.display = 'none';
    labelInput.style.fontSize = '12px';
    labelInput.style.fontWeight = '500';
    labelInput.style.color = 'var(--text)';
    labelInput.style.background = 'var(--panel)';
    labelInput.style.border = '1px solid var(--border2)';
    labelInput.style.borderRadius = '4px';
    labelInput.style.padding = '2px 4px';
    labelInput.style.width = '100%';
    labelInput.style.boxSizing = 'border-box';
    
    // Click handler to start editing
    label.addEventListener('click', (e) => {
      e.stopPropagation();
      label.style.display = 'none';
      labelInput.style.display = 'block';
      labelInput.focus();
      labelInput.select();
    });
    
    // Save on blur or Enter
    const saveLabel = () => {
      const newLabel = labelInput.value.trim() || track.label;
      label.textContent = newLabel;
      label.style.display = '';
      labelInput.style.display = 'none';
      editSmartTrackLabel(track.id, newLabel);
    };
    
    labelInput.addEventListener('blur', saveLabel);
    labelInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        saveLabel();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        labelInput.value = track.label;
        label.style.display = '';
        labelInput.style.display = 'none';
      }
    });
    
    const controls = document.createElement('div');
    controls.className = 'smart-track-item-controls';
    
    // Collapse button (controls collapsed/expanded state)
    const collapseBtn = document.createElement('button');
    collapseBtn.className = 'smart-track-item-collapse-btn';
    collapseBtn.type = 'button';
    // For Smart Tracks: collapsed = closed (single read), !collapsed = open (full height)
    collapseBtn.textContent = track.collapsed ? "▶" : "▼";
    collapseBtn.title = track.collapsed ? "Expand to full height" : "Collapse to single read";
    collapseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      track.collapsed = !track.collapsed;
      const trackInArray = state.tracks.find(t => t.id === track.id);
      if (trackInArray) {
        trackInArray.collapsed = track.collapsed;
      }
      updateTracksHeight();
      renderAll();
      // Re-render sidebar to update button state
      renderSmartTracksSidebar();
    });
    
    // Checkbox for show/hide (controls hidden state)
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'smart-track-item-checkbox';
    // Default to false (not hidden) if undefined for backwards compatibility
    checkbox.checked = !(track.hidden === true);
    checkbox.addEventListener('change', (e) => {
      e.stopPropagation();
      track.hidden = !checkbox.checked;
      const trackInArray = state.tracks.find(t => t.id === track.id);
      if (trackInArray) {
        trackInArray.hidden = track.hidden;
      }
      updateTracksHeight();
      renderAll();
    });
    
    // Refresh button
    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'smart-track-item-btn refresh';
    refreshBtn.title = 'Refresh';
    refreshBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      reloadSmartTrack(track.id);
    });
    
    // Shuffle button
    const shuffleBtn = document.createElement('button');
    shuffleBtn.className = 'smart-track-item-btn shuffle';
    shuffleBtn.title = 'Shuffle';
    shuffleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      shuffleSmartTrack(track.id);
    });
    
    // Close button
    const closeBtn = document.createElement('button');
    closeBtn.className = 'smart-track-item-btn close';
    closeBtn.title = 'Close';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeSmartTrack(track.id);
      renderSmartTracksSidebar();
    });
    
    controls.appendChild(collapseBtn);
    controls.appendChild(checkbox);
    controls.appendChild(refreshBtn);
    controls.appendChild(shuffleBtn);
    controls.appendChild(closeBtn);
    
    header.appendChild(label);
    header.appendChild(labelInput);
    header.appendChild(controls);
    
    item.appendChild(header);
    
    // Drag and drop handlers
    item.addEventListener('dragstart', (e) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', track.id);
      item.classList.add('dragging');
    });
    
    item.addEventListener('dragend', (e) => {
      item.classList.remove('dragging');
      applySmartTrackOrderFromDom();
    });
    
    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      
      const afterElement = getDragAfterElement(smartTracksList, e.clientY);
      const dragging = document.querySelector('.smart-track-item.dragging');
      if (afterElement == null) {
        smartTracksList.appendChild(dragging);
      } else {
        smartTracksList.insertBefore(dragging, afterElement);
      }
    });
    
    // Drop handler on individual items - just prevent default, container handles the reordering
    item.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    
    smartTracksList.appendChild(item);
  });
}

// Helper function for drag and drop
function getDragAfterElement(container, y) {
  const draggableElements = [...container.querySelectorAll('.smart-track-item:not(.dragging)')];
  
  return draggableElements.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    
    if (offset < 0 && offset > closest.offset) {
      return { offset: offset, element: child };
    } else {
      return closest;
    }
  }, { offset: Number.NEGATIVE_INFINITY }).element;
}

// Right sidebar collapse/expand
function getRightSidebarCollapsed() {
  const stored = localStorage.getItem("genomeshader.rightSidebarCollapsed");
  // Default to collapsed (true) if not set
  if (stored === null) {
    return true;
  }
  return stored === "true";
}
function setRightSidebarCollapsed(collapsed) {
  localStorage.setItem("genomeshader.rightSidebarCollapsed", String(collapsed));
  updateRightSidebarState();
}
function updateRightSidebarState() {
  const collapsed = getRightSidebarCollapsed();
  const app = document.querySelector('.app');
  if (!app) {
    return;
  }
  if (collapsed) {
    app.classList.add("sidebar-right-collapsed");
  } else {
    app.classList.remove("sidebar-right-collapsed");
  }
  // Trigger resize after CSS transition completes
  setTimeout(() => {
    window.dispatchEvent(new Event('resize'));
  }, 220);
}

// Initialize right sidebar (closed by default)
// Wait for DOM to be ready
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeRightSidebar);
  } else {
    initializeRightSidebar();
  }
}

function initializeRightSidebar() {
  const app = document.querySelector('.app');
  if (!app) {
    // Retry after a short delay if app isn't ready yet
    setTimeout(initializeRightSidebar, 100);
    return;
  }
  
  // Initialize state (defaults to collapsed if not set)
  updateRightSidebarState();
  
  // Make right sidebar border clickable
  const sidebarRight = document.getElementById('sidebarRight');
  if (sidebarRight) {
    let autoCloseTimer = null;
    
    const handleRightSidebarToggle = (e) => {
      // Don't intercept clicks on form elements or their containers
      const target = e.target;
      if (target.closest('input, button, .smart-track-item')) {
        return;
      }
      
      const collapsed = getRightSidebarCollapsed();
      const rect = sidebarRight.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      
      // Check if click is within 12px of the left edge (or anywhere if collapsed)
      if (collapsed) {
        e.preventDefault();
        e.stopPropagation();
        setRightSidebarCollapsed(false);
        // Clear any pending auto-close timer when opening
        if (autoCloseTimer) {
          clearTimeout(autoCloseTimer);
          autoCloseTimer = null;
        }
      } else if (clickX <= 12) {
        e.preventDefault();
        e.stopPropagation();
        setRightSidebarCollapsed(true);
        // Clear any pending auto-close timer when closing manually
        if (autoCloseTimer) {
          clearTimeout(autoCloseTimer);
          autoCloseTimer = null;
        }
      }
    };
    
    // Auto-close when mouse leaves sidebar (after 3 seconds)
    const handleMouseEnter = () => {
      // Clear any pending auto-close timer when mouse enters
      if (autoCloseTimer) {
        clearTimeout(autoCloseTimer);
        autoCloseTimer = null;
      }
    };
    
    const handleMouseLeave = () => {
      // Only auto-close if sidebar is open
      if (!getRightSidebarCollapsed()) {
        // Clear any existing timer
        if (autoCloseTimer) {
          clearTimeout(autoCloseTimer);
        }
        // Set new timer to close after 3 seconds
        autoCloseTimer = setTimeout(() => {
          setRightSidebarCollapsed(true);
          autoCloseTimer = null;
        }, 3000);
      }
    };
    
    sidebarRight.addEventListener("click", handleRightSidebarToggle, true);
    sidebarRight.addEventListener("pointerdown", handleRightSidebarToggle, true);
    sidebarRight.addEventListener("pointerup", handleRightSidebarToggle, true);
    sidebarRight.addEventListener("mousedown", handleRightSidebarToggle, true);
    sidebarRight.addEventListener("mouseenter", handleMouseEnter);
    sidebarRight.addEventListener("mouseleave", handleMouseLeave);
    
    sidebarRight.style.pointerEvents = "auto";
    
    // Initial render
    renderSmartTracksSidebar();
  }
}
