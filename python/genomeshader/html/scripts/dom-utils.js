// Theme + menu
// -----------------------------
// Find root container for scoping event handlers in inline mode
const root = document.querySelector('[id^="genomeshader-root-"]') ||
              (document.querySelector('.app')?.closest('[id^="genomeshader-root-"]')) ||
              document.body; // Fallback to body if not found

// Dynamic root lookup - finds the current container (overlay modal or original root)
// This is needed because the viewer moves to an overlay modal in full-screen mode
function getCurrentRoot() {
  // Check if we're in overlay mode by looking for the app element in an overlay
  const appEl = document.querySelector('.app');
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
const aggregateRareAllelesItem = getElementById("aggregateRareAllelesItem");
const aggregateRareAllelesToggle = getElementById("aggregateRareAllelesToggle");
const aggregateRareAllelesCutoffItem = getElementById("aggregateRareAllelesCutoffItem");
const aggregateRareAllelesCutoffInput = getElementById("aggregateRareAllelesCutoffInput");

// Debug: Check if elements are found

// In inline mode, keep menu in root initially, but we'll move it to body when opening
// This ensures fixed positioning works relative to viewport, not container
if (hostMode === 'inline' && root && ctxMenu && !root.contains(ctxMenu)) {
  root.appendChild(ctxMenu);
}

// Sidebar collapse/expand
function getSidebarCollapsed() {
  return localStorage.getItem("genomeshader.sidebarCollapsed") === "true";
}
function setSidebarCollapsed(collapsed) {
  localStorage.setItem("genomeshader.sidebarCollapsed", String(collapsed));
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
  // Let ResizeObserver-driven rendering handle transition layout changes.
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
    if (target.closest('select, input, button, label, .sampleStrategyControls, .sampleSearchControls, #samplePreview, #sampleContext')) {
      return; // Let form element handlers fire
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
}

updateSidebarState();

function getStoredTheme() {
  return localStorage.getItem("genomeshader.theme"); // "dark" | "light" | "auto" | null
}
function setTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("genomeshader.theme", theme);
  updateThemeLabel();
}
function updateThemeLabel() {
  const t = document.documentElement.getAttribute("data-theme") || "auto";
  themeLabel.textContent = t === "auto" ? "Auto" : (t === "light" ? "Light" : "Dark");
}
function getStoredOrientation() {
  return localStorage.getItem("genomeshader.orientation"); // "horizontal" | "vertical" | null
}
function setOrientation(o) {
  localStorage.setItem("genomeshader.orientation", o);
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
  return localStorage.getItem("genomeshader.variantLayoutMode"); // "equidistant" | "genomic" | null
}
function setVariantLayoutMode(mode) {
  localStorage.setItem("genomeshader.variantLayoutMode", mode);
  state.variantLayoutMode = mode;
  updateVariantLayoutModeLabel();
}
function updateVariantLayoutModeLabel() {
  const mode = state.variantLayoutMode || "equidistant";
  const labelEl = document.getElementById("variantLayoutModeLabel");
  if (labelEl) {
    labelEl.textContent = mode === "equidistant" ? "Equidistant" : "Genomic";
  }
}
function getVariantLayoutMode() {
  return state.variantLayoutMode || "equidistant";
}
function getStoredAggregateRareAlleles() {
  return localStorage.getItem("genomeshader.aggregateRareAlleles") === "true";
}
function setAggregateRareAlleles(enabled) {
  const v = enabled === true;
  localStorage.setItem("genomeshader.aggregateRareAlleles", v ? "true" : "false");
  state.aggregateRareAlleles = v;
  updateAggregateRareAllelesControls();
}
function getStoredAggregateRareAllelesCutoff() {
  const raw = parseFloat(localStorage.getItem("genomeshader.aggregateRareAllelesCutoffPct"));
  if (!isFinite(raw)) return 2.0;
  return Math.max(0, Math.min(50, raw));
}
function setAggregateRareAllelesCutoff(cutoffPct) {
  const clamped = Math.max(0, Math.min(50, Number(cutoffPct)));
  localStorage.setItem("genomeshader.aggregateRareAllelesCutoffPct", String(clamped));
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

const stored = getStoredTheme();
document.documentElement.setAttribute("data-theme", stored ?? "auto");
updateThemeLabel();

function openMenu() {
  // In inline mode, move menu to body so fixed positioning works relative to viewport
  if (hostMode === 'inline' && ctxMenu.parentElement !== document.body) {
    document.body.appendChild(ctxMenu);
  }
  
  // Temporarily show menu to measure its actual dimensions
  ctxMenu.style.position = 'fixed';
  ctxMenu.style.visibility = 'hidden';
  ctxMenu.style.display = 'block';
  ctxMenu.classList.add("open");
  ctxMenu.setAttribute("aria-hidden", "false");
  
  // Get actual menu dimensions
  const menuRect = ctxMenu.getBoundingClientRect();
  const menuHeight = menuRect.height;
  const menuWidth = menuRect.width;
  
  // Use fixed positioning so menu appears over everything (including Jupyter UI)
  const r = menuBtn.getBoundingClientRect();
  const padding = 8;
  const viewportHeight = window.innerHeight;
  const viewportWidth = window.innerWidth;
  
  // Calculate positions for above and below the button
  const spaceAbove = r.top;
  const spaceBelow = viewportHeight - r.bottom;
  const topIfAbove = r.top - menuHeight - padding;
  const topIfBelow = r.bottom + padding;
  
  // Determine best position: prefer above, but use below if not enough space above
  // However, if below would extend off screen, position above even with limited space
  let top, left = r.left;
  
  // Check if positioning below would extend off screen
  const wouldExtendBelow = (topIfBelow + menuHeight) > (viewportHeight - padding);
  
  if (spaceAbove >= menuHeight + padding && !wouldExtendBelow) {
    // Enough space above, position above
    top = topIfAbove;
  } else if (spaceBelow >= menuHeight + padding && !wouldExtendBelow) {
    // Not enough space above, but enough below, position below
    top = topIfBelow;
  } else {
    // Not enough space in either direction, position above and adjust to fit
    // This ensures menu never extends below viewport
    top = Math.max(padding, viewportHeight - menuHeight - padding);
  }
  
  // Ensure menu doesn't go off right edge
  if (left + menuWidth > viewportWidth - padding) {
    left = Math.max(padding, viewportWidth - menuWidth - padding);
  }
  
  // Final check: ensure menu never extends below viewport
  if (top + menuHeight > viewportHeight - padding) {
    top = Math.max(padding, viewportHeight - menuHeight - padding);
  }
  
  // Apply final positioning
  ctxMenu.style.left = `${left}px`;
  ctxMenu.style.top = `${top}px`;
  ctxMenu.style.zIndex = '2147483647';
  ctxMenu.style.visibility = 'visible';
  ctxMenu.style.pointerEvents = 'auto';
  ctxMenu.style.opacity = '1';

  // Update variant layout mode label when menu opens
  updateVariantLayoutModeLabel();
  updateAggregateRareAllelesControls();
}
function closeMenu() {
  ctxMenu.classList.remove("open");
  ctxMenu.setAttribute("aria-hidden", "true");
  ctxMenu.style.display = 'none';
  ctxMenu.style.visibility = 'hidden';
  ctxMenu.style.pointerEvents = 'none';
  
  // In inline mode, move menu back to root when closed
  if (hostMode === 'inline' && root && ctxMenu.parentElement === document.body) {
    root.appendChild(ctxMenu);
  }
}
function toggleMenu() {
  ctxMenu.classList.contains("open") ? closeMenu() : openMenu();
}

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

orientationItem.addEventListener("click", () => {
  const cur = getStoredOrientation() ?? "horizontal";
  const next = (cur === "horizontal") ? "vertical" : "horizontal";
  setOrientation(next);
  renderAll();
});

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
        loadReadsLabel.textContent = "✗";
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
    closeBtn.textContent = '✕';
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

    if (placeholder && originalParent) {
      if (originalNextSibling) {
        originalParent.insertBefore(viewerEl, originalNextSibling);
      } else {
        originalParent.appendChild(viewerEl);
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
if (fullscreenItem && app) {
  focusModeController = installFocusMode({
    viewerEl: app,
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

  // Full screen toggle: 'f'
  if (key === 'f' && fullscreenItem && focusModeController && !focusModeController.isActive()) {
    e.preventDefault();
    e.stopPropagation();
    focusModeController.enter();
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
        loadReadsLabel.textContent = "✗";
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
