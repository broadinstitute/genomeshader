// SVG helpers
// -----------------------------
const SVGNS = "http://www.w3.org/2000/svg";
function clearSvg(svg) { while (svg.firstChild) svg.removeChild(svg.firstChild); }
function el(tag, attrs = {}, text = null) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k,v] of Object.entries(attrs)) {
    // Skip null/undefined values
    if (v == null) {
      continue;
    }
    
    let value = v;
    
    // Check if value is already NaN (number or string "NaN")
    if (typeof value === 'number' && isNaN(value)) {
      console.warn(`Genomeshader: NaN value for ${k} in <${tag}>, using 0`);
      value = 0;
    } else if (typeof value === 'string' && (value === 'NaN' || value.toLowerCase() === 'nan')) {
      console.warn(`Genomeshader: "NaN" string for ${k} in <${tag}>, using 0`);
      value = 0;
    } else {
      // Validate numeric attributes that must be non-negative
      if (['width', 'height', 'r', 'rx', 'ry'].includes(k)) {
        // Handle both number and string inputs
        let numVal;
        if (typeof value === 'number') {
          numVal = value;
        } else {
          numVal = parseFloat(value);
        }
        
        // Check for NaN first
        if (isNaN(numVal)) {
          console.warn(`Genomeshader: Invalid ${k} value ${v} (NaN) for <${tag}>, using 0`);
          value = 0;
        } 
        // Check for negative values - SVG doesn't allow negative width/height
        else if (numVal < 0) {
          console.warn(`Genomeshader: Invalid ${k} value ${v} (negative) for <${tag}>, using 0`);
          value = 0;
        } 
        // Use the parsed/validated number
        else {
          value = numVal;
        }
      }
      // Validate position attributes that must be valid numbers (can be negative for positioning)
      else if (['x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy'].includes(k)) {
        const numVal = parseFloat(value);
        if (isNaN(numVal)) {
          console.warn(`Genomeshader: Invalid ${k} value ${v} (NaN) for <${tag}>, using 0`);
          value = 0;
        } else {
          value = numVal; // Use parsed number (can be negative for positioning)
        }
      }
      // For any other numeric-looking attribute, validate it's not NaN
      else if (typeof value === 'number' && isNaN(value)) {
        console.warn(`Genomeshader: NaN value for ${k} in <${tag}>, using 0`);
        value = 0;
      }
    }
    
    n.setAttribute(k, String(value));
  }
  if (text !== null) n.textContent = text;
  return n;
}

// -----------------------------
// "Nice" tick selection for ruler
// -----------------------------
function trimZeros(s) {
  return s.replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1");
}
function formatBp(bp, spanBp = null) {
  // Determine precision based on span if provided
  let kbPrecision = 1;
  
  if (spanBp !== null) {
    if (spanBp < 100) {
      // Very zoomed in - show full base pair position with commas
      return `${Math.round(bp).toLocaleString()} bp`;
    } else if (spanBp < 1_000) {
      // Zoomed in - show more decimal places for kb
      kbPrecision = 2;
    } else if (spanBp < 10_000) {
      // Moderately zoomed - show 2 decimal places
      kbPrecision = 2;
    } else {
      // Normal zoom - show 1 decimal place
      kbPrecision = 1;
    }
  }
  
  if (bp >= 1_000_000) return `${trimZeros((bp / 1_000_000).toFixed(2))} Mb`;
  if (bp >= 1_000)     return `${trimZeros((bp / 1_000).toFixed(kbPrecision))} kb`;
  return `${bp} bp`;
}
function chooseNiceTickBp(spanBp, desiredTicks) {
  const target = spanBp / desiredTicks;
  const pow = Math.pow(10, Math.floor(Math.log10(target)));
  const candidates = [1,2,5,10].map(m => m*pow);
  let best = candidates[0], bestDiff = Infinity;
  for (const c of candidates) {
    const diff = Math.abs((spanBp / c) - desiredTicks);
    if (diff < bestDiff) { bestDiff = diff; best = c; }
  }
  return best;
}

// -----------------------------
// Track layout calculation
// -----------------------------
function getTrackLayout() {
  const layout = [];
  const headerH = 24;
  const padding = 8;
  const isVertical = isVerticalMode();
  
  // Standard tracks that should have hover-only controls (no reserved space)
  const standardTracks = ["ideogram", "genes", "repeats", "reference", "ruler", "flow"];
  
  function isStandardTrack(trackId) {
    return standardTracks.includes(trackId);
  }

  if (isVertical) {
    // Vertical mode: tracks side-by-side (left/width based)
    let currentX = 0;
    const mainHeight = rectH(main);
    // Ensure mainHeight is valid
    const safeMainHeight = (isNaN(mainHeight) || mainHeight <= 0) ? 0 : mainHeight;
    
    for (const track of state.tracks) {
      // For standard tracks, don't reserve space for header (controls overlay on hover)
      // For Smart tracks, keep the header space
      const usesHeaderSpace = !isStandardTrack(track.id);
      const effectiveWidth = track.collapsed 
        ? (usesHeaderSpace ? headerH : 0)
        : (usesHeaderSpace ? headerH + (track.height || 0) : (track.height || 0));
      const safeContentLeft = usesHeaderSpace ? currentX + headerH : currentX;
      const safeContentWidth = track.collapsed ? 0 : (track.height || 0);
      
      // Validate all values are numbers
      if (isNaN(currentX) || isNaN(effectiveWidth) || isNaN(safeContentLeft) || isNaN(safeContentWidth)) {
        console.warn('Genomeshader: Invalid layout values in vertical mode', { currentX, effectiveWidth, safeContentLeft, safeContentWidth, track: track.id });
        continue;
      }
      
      layout.push({
        track,
        left: currentX,
        width: effectiveWidth,
        contentLeft: safeContentLeft,
        contentWidth: safeContentWidth,
        // Also include top/height for compatibility
        top: 0,
        height: safeMainHeight,
        contentTop: 0,
        contentHeight: safeMainHeight
      });
      currentX += effectiveWidth; // no gap between tracks
    }
  } else {
    // Horizontal mode: tracks stacked vertically (top/height based)
    let currentY = 0;
    const mainWidth = rectW(main);
    // Ensure mainWidth is valid
    const safeMainWidth = (isNaN(mainWidth) || mainWidth <= 0) ? 0 : mainWidth;
    
    for (const track of state.tracks) {
      // For standard tracks, don't reserve space for header (controls overlay on hover)
      // For Smart tracks, keep the header space
      const usesHeaderSpace = !isStandardTrack(track.id);
      const effectiveHeight = track.collapsed 
        ? (usesHeaderSpace ? headerH : 0)
        : (usesHeaderSpace ? headerH + (track.height || 0) : (track.height || 0));
      const safeContentTop = usesHeaderSpace ? currentY + headerH : currentY;
      const safeContentHeight = track.collapsed ? 0 : (track.height || 0);
      
      // Validate all values are numbers
      if (isNaN(currentY) || isNaN(effectiveHeight) || isNaN(safeContentTop) || isNaN(safeContentHeight)) {
        console.warn('Genomeshader: Invalid layout values in horizontal mode', { currentY, effectiveHeight, safeContentTop, safeContentHeight, track: track.id });
        continue;
      }
      
      layout.push({
        track,
        top: currentY,
        height: effectiveHeight,
        contentTop: safeContentTop,
        contentHeight: safeContentHeight,
        // Also include left/width for compatibility
        left: 0,
        width: safeMainWidth,
        contentLeft: 0,
        contentWidth: safeMainWidth
      });
      currentY += effectiveHeight; // no gap between tracks
    }
  }

  return layout;
}

function updateTracksHeight() {
  const layout = getTrackLayout();
  const isVertical = isVerticalMode();
  // Exclude flow and reads from tracks height/width since they're positioned separately
  const tracksLayout = layout.filter(l => l.track.id !== "flow" && l.track.id !== "reads");
  if (isVertical) {
    const totalW = tracksLayout.length > 0 
      ? tracksLayout[tracksLayout.length - 1].left + tracksLayout[tracksLayout.length - 1].width
      : 0;
    // In vertical mode, tracks are side-by-side, so we don't need to set --tracks-h
    // But we might want to set a width variable if needed
  } else {
    const totalH = tracksLayout.length > 0 
      ? tracksLayout[tracksLayout.length - 1].top + tracksLayout[tracksLayout.length - 1].height
      : 0;
    // Use default height if calculation fails or returns 0
    const finalHeight = totalH > 0 ? totalH : 280; // Default to 280px if calculation fails
    document.documentElement.style.setProperty('--tracks-h', `${finalHeight}px`);
  }
}
