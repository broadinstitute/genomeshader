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
