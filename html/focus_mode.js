// Focus mode (pseudo-fullscreen overlay) for Genomeshader viewer
// This module provides a CSS-based fullscreen overlay that works in environments
// where the Fullscreen API is blocked (e.g., Terra Classic Notebook)

export function installFocusMode({
  viewerEl,          // the root .app element containing the whole app UI
  toggleEl,          // settings menu button/checkbox element
  viewId,            // unique view ID for scoping
  onEnter,           // optional callback (resize)
  onExit             // optional callback (resize)
}) {
  if (!viewerEl || !toggleEl || !viewId) {
    console.error('installFocusMode: missing required parameters');
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

  function createOverlay() {
    // Create overlay backdrop
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
    `;

    // Create modal container
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
    `;

    // Create topbar
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

    // Create modal body (where viewer will be moved)
    const modalBody = document.createElement('div');
    modalBody.style.cssText = `
      flex: 1;
      overflow: hidden;
      position: relative;
      touch-action: none;
    `;

    modal.appendChild(topbar);
    modal.appendChild(modalBody);
    overlay.appendChild(modal);

    // Handle backdrop click (close on click outside modal)
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        exit();
      }
    });

    // Handle Escape key
    const handleEscape = (e) => {
      if (e.key === 'Escape' && isActive) {
        exit();
      }
    };
    document.addEventListener('keydown', handleEscape);

    // Store escape handler for cleanup
    overlay._escapeHandler = handleEscape;

    return { overlay, modal, modalBody };
  }

  function enter() {
    if (isActive) return;

    const { overlay, modal, modalBody } = createOverlay();
    
    // Store original position
    originalParent = viewerEl.parentNode;
    originalNextSibling = viewerEl.nextSibling;

    // Create placeholder to mark original position
    placeholder = document.createElement('div');
    placeholder.id = placeholderId;
    placeholder.style.cssText = `
      width: ${viewerEl.offsetWidth}px;
      height: ${viewerEl.offsetHeight}px;
      min-height: 600px;
    `;

    // Insert placeholder at original position
    if (originalNextSibling) {
      originalParent.insertBefore(placeholder, originalNextSibling);
    } else {
      originalParent.appendChild(placeholder);
    }

    // Move viewer into modal body
    modalBody.appendChild(viewerEl);

    // Append overlay to body
    document.body.appendChild(overlay);

    // Lock body scroll
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Store original overflow for restoration
    overlay._originalOverflow = originalOverflow;

    isActive = true;
    updateToggleLabel();

    // Trigger resize after DOM has settled
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (onEnter) {
          onEnter();
        }
      });
    });
  }

  function exit() {
    if (!isActive) return;

    // Restore body scroll
    if (overlay && overlay._originalOverflow !== undefined) {
      document.body.style.overflow = overlay._originalOverflow;
    } else {
      document.body.style.overflow = '';
    }

    // Remove escape handler
    if (overlay && overlay._escapeHandler) {
      document.removeEventListener('keydown', overlay._escapeHandler);
    }

    // Move viewer back to original position
    if (placeholder && originalParent) {
      if (originalNextSibling) {
        originalParent.insertBefore(viewerEl, originalNextSibling);
      } else {
        originalParent.appendChild(viewerEl);
      }
      placeholder.remove();
      placeholder = null;
    }

    // Remove overlay
    if (overlay) {
      overlay.remove();
      overlay = null;
      modal = null;
      topbar = null;
    }

    isActive = false;
    updateToggleLabel();

    // Trigger resize after DOM has settled
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (onExit) {
          onExit();
        }
      });
    });
  }

  function updateToggleLabel() {
    const labelSpan = toggleEl.querySelector('.menuRight') || toggleEl.querySelector('span:last-child');
    if (labelSpan) {
      labelSpan.textContent = isActive ? 'Exit full screen' : 'Enter full screen';
    }
  }

  // Set up toggle button
  toggleEl.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isActive) {
      exit();
    } else {
      enter();
    }
  });

  // Initialize label
  updateToggleLabel();

  // Return API for external control if needed
  return {
    enter,
    exit,
    isActive: () => isActive
  };
}

