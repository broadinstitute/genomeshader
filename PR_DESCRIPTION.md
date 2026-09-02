# Multispecies support, anywidget viewer, and a full interactive-UI overhaul

Fixes #56. Addresses #7, #11, #12.

Turns genomeshader into a reference-agnostic, cross-environment viewer and
rebuilds the front-end into a full interactive genome browser. 81 commits;
the highlights, grouped by area.

## Issues
- **Fixes #56 (non-human data)** — reference-agnostic staging: `stage_reference`
  with a scheme-aware fetch layer (local / `gs://` / `s3://` / `http(s)://`)
  stages any reference without pre-downloading; hardened PlasmoDB FASTA/GFF
  staging.
- **Addresses #7 (zoom experience)** — zoom is now cursor-anchored: the point
  under the pointer stays put while the range expands/shrinks around it
  (`zoomByFactor(factor, anchorBp)` + `anchorBpFromClientX/Y`, plus pinch-zoom
  anchoring).
- **Addresses #11 (hash-based caching)** — hash-keyed caching for fetched reads
  (keyed by locus + bam set) and for UCSC/reference artifacts (three-tier
  in-memory → local disk → GCS, content-hashed filenames), so repeat runs reuse
  prior work instead of recomputing. (Partial: caches artifacts, not a single
  per-input session parquet.)
- **Addresses #12 (new-window control in render)** — moot after the anywidget
  rewrite: the viewer renders inline over the ipywidgets comm and `show()`
  delegates to `show_widget()`, so there's no forced browser window / localhost
  path to gate anymore.

## Multispecies / reference-agnostic support
- `stage_reference` with a scheme-aware fetch layer (local / `gs://` / `s3://` /
  `http(s)://`) so any non-human reference can be staged without pre-downloading.
- Hardened PlasmoDB GFF/FASTA staging on real-data layouts; annotation-staging
  tests.
- Indexed region-seek for variant files + optional explicit index path.

## Cross-environment rendering (anywidget)
- Viewer renders as an anywidget: config is inlined and on-demand reads + UCSC
  data ride the ipywidgets comm — one code path for classic Notebook, Lab,
  Notebook 7, VS Code, Colab, and the Terra/AoU proxy (no localhost assumptions).
- Container-scoped CSS so clicks register regardless of host page.

## UI overhaul
- Left and right panels as VS Code-style icon rails + tabs. Left: Samples /
  Settings; right: Smart Tracks / UCSC / Genes / Variants / Comments / Settings /
  Help. Static icon rails when collapsed; resizable right panel.
- Settings as an aligned two-column table (theme, orientation, variant layout,
  low-frequency aggregation, **lock allele positions**, fullscreen).
- Variants tab: prev/next variant + allele navigation, center-on-variant, ref
  selection by node.
- Genes tab/panel: per-gene transcripts and exons as styled tables.
- Populated Help tab; graphical progress bar during staging; bottom status bar
  for background work; fullscreen correctness fixes; snappier hint tooltips.

## Rendering & performance
- WebGPU with SVG fallback for interval boxes (genes/repeats/UCSC), read-strand
  arrows, and IGV-style reference base blocks (contrast-picked letters).
- Live pan: translate rendered layers during the drag and rebuild on a throttle
  (edges fill instead of going blank) instead of rebuilding every frame.
- rAF-coalesced pan/zoom renders.

## UCSC integration
- UCSC Tracks tab with an assembly picker defaulting to the best match for the
  build; boxed, warning-colored "no assembly auto-matched" notice below the
  title; background pre-warm of the assembly/track lookup at widget load.
- Three-tier cache for reference/annotation artifacts (in-memory → local disk →
  GCS JSON).

## Comments
- Shared, persistent, markdown comments anchored to a region / variant / allele
  (optionally per-sample), one JSON per comment under
  `{gcs_session_dir}/comments/`. Author + created/edited tracking, Comments tab
  UI, and on-track pins on the locus (ruler) track with click-to-navigate.

## Repeat-startup caching
- Local-disk cache for fetched reads keyed by (locus, bam set) so repeat runs
  skip the remote BAM re-parse (`GENOMESHADER_NO_READS_CACHE=1` bypasses).
- `GENOMESHADER_TIMING=1` prints render wall-time + a cache-source breakdown
  (mem/disk/gcs/api) and per-sample reads timing.

## Fixes
- Variant-strip drag pans / click selects; border clicks register; no duplicate
  tooltips; allele tooltips keep small alleles fully visible and large ones
  partly visible.
- Escape / `f` exit fullscreen; double-click a variant opens the left panel on
  the Samples tab.
- List GCS folders via the `gcloud` CLI (ADC) instead of the cloud-storage crate.

## Tests
Full suite green (69 passed), including anywidget transport, comments CRUD +
comm round-trip, reads disk cache, and PlasmoDB staging.
