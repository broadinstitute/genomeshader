// -----------------------------
// Safe storage shim. The widget output can run in a sandboxed iframe or an
// opaque origin (VS Code webview, Colab usercontent, some proxied/Terra envs,
// nbconvert), where touching window.localStorage throws a SecurityError. An
// unguarded access there aborts the whole viewer, so every settings read/write
// goes through this: it probes localStorage once and, if unavailable, falls
// back to an in-memory map so the viewer still renders and settings work for
// the session (just not persisted across reloads).
// -----------------------------
const gsLocalStorage = (function () {
  let ls = null;
  try {
    ls = window.localStorage;
    const probe = "__gs_probe__";
    ls.setItem(probe, "1");
    ls.removeItem(probe);
  } catch (e) {
    ls = null;
  }
  const mem = new Map();
  return {
    getItem(k) {
      if (ls) { try { return ls.getItem(k); } catch (e) {} }
      return mem.has(k) ? mem.get(k) : null;
    },
    setItem(k, v) {
      if (ls) { try { ls.setItem(k, String(v)); return; } catch (e) {} }
      mem.set(k, String(v));
    },
    removeItem(k) {
      if (ls) { try { ls.removeItem(k); return; } catch (e) {} }
      mem.delete(k);
    },
  };
})();

// -----------------------------
// Clean up any stale overlays from previous sessions
// -----------------------------
(function cleanupStaleOverlays() {
  const staleOverlays = document.querySelectorAll('[id^="genomeshader-overlay-"]');
  staleOverlays.forEach(overlay => {
    console.log(`Cleaning up stale overlay: ${overlay.id}`);
    overlay.remove();
  });
})();
