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
    label: `Smart Track ${index + 1}`,
    collapsed: false,
    height: 220,
    minHeight: 50,
    strategy: strategy,
    selectedAlleles: new Set(selectedAlleles),
    sampleId: null,
    readsData: null,
    readsLayout: null,
    loading: false
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
}
