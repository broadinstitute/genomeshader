# New-window (#12) + Standalone native app (#59) — design

Both features reduce to **one shared piece of infra**, then a thin launcher on
top. This doc captures what it would take.

## The seam that makes this cheap

The frontend talks to the backend through a single chokepoint:

    window.__GS_SEND(type, data, timeoutMs) -> Promise<response>

Every request rides it — `fetch_variants`, `fetch_reads`, `fetch_carriers`,
`navigate`, `comments_*`, `clear_cache`, `debug_log`, `ucsc_*`. In the notebook
it's wired to the anywidget model (`model.send` / `msg:custom`). The backend
handlers (`fetch_variants_payload`, `navigate_payload`, `_fetch_reads_payload`,
`fetch_carriers`, `comments_*`, `clear_local_cache`) are **plain session
methods** — `widget.py`'s `_on_custom_msg` is just a `switch` that calls them.

So the whole app is host-agnostic except for two wires:
1. who launches the process + serves the HTML, and
2. what `__GS_SEND` points at.

## Shared foundation (build once): a local request API

Add a **local HTTP + WebSocket API** that dispatches the existing comm message
types to the existing session methods — i.e. lift `_on_custom_msg`'s switch into
a transport-neutral `dispatch(type, data) -> response` and expose it over:

- **WebSocket** at `ws://127.0.0.1:<port>/api` — request/response by `request_id`
  (mirrors the comm), plus server-push for `comments_changed`. Preferred.
- (or **POST** `/api {type,data}` for a simpler first cut; no push.)

The existing `_start_localhost_server` (static file server + CORS, daemon
thread) is the seed — add the `/api` route (and serve the full viewer HTML at
`/view/<run_id>`). Frontend: a ~30-line bootstrap sets `window.__GS_SEND` to a
WS/HTTP client instead of the anywidget model. **Nothing else in the frontend
changes.** Payload size is already handled by viewport windowing (no giant
messages), so no chunking needed.

Effort: **M.** The dispatch switch already exists; the work is a robust WS
handler + the client shim + keeping the server/session alive for the kernel's
life.

## Feature 1 — open in a new window (#12, regressed)

On top of the shared API:
- Re-add `new_window: bool` to `render()`/`show()`.
- Serve the full HTML at `http://127.0.0.1:<port>/view/<run_id>` (config inlined
  or fetched via `/api`).
- `new_window=True` -> `webbrowser.open(url)` for a **local** kernel; otherwise
  **print a clickable URL** (see remote caveat).

Effort on top of the API: **S.**

Caveats:
- **Remote kernels (Terra / cloud Jupyter).** The localhost server runs on the
  *kernel* host, not the user's laptop, so `webbrowser.open` is useless there.
  Options: (a) print a `jupyter-server-proxy` URL
  (`/proxy/<port>/view/<run_id>`) so it tunnels through the notebook server;
  (b) document a manual `ssh -L` / VS Code port-forward. `new_window` should
  detect remote and fall back to printing the proxied URL, never silently open a
  headless browser. This is the main design decision — our data is cloud-based,
  so remote is the common case.
- **Lifetime.** Server thread + session must outlive the cell (they already do —
  daemon thread on the session).
- **Auth.** Same process/session -> same GCS creds. No change.

## Feature 2 — standalone native app (#59)

Same API + HTML, launched **without a notebook**. Three levels, increasing cost:

### Level A — `genomeshader serve` (system browser). Recommended first.
A CLI entrypoint that:
1. builds a session from a config file / flags (`--vcf`, `--bam`, `--ref`,
   `--region`), reusing `attach_variants` / `attach_reads` / staging,
2. starts the HTTP+WS API server,
3. `webbrowser.open("http://127.0.0.1:<port>/view")`.

Reuses 100% of the frontend + session. ~90% of the "native app" value.
Effort on top of the API: **S–M** (CLI + session-from-config).

### Level B — native window via pywebview. The lazy "desktop app".
Wrap Level A's localhost server in a **pywebview** OS window (pure-Python,
pip-installable, uses the platform webview). Gives an app window + icon/menus,
no browser chrome. Not a self-contained binary (still needs a Python env).
Effort on top of A: **S.**

### Level B' — self-contained binary via Tauri. The "real" distributable.
A signed native binary (Tauri = Rust shell + system webview; matches our Rust
core). The cost is **removing the Python runtime dependency**: either bundle a
Python interpreter, or port the Python glue (payload builders in `view.py`, the
dispatch switch) **down into Rust** so the binary is Rust-only. Plus bundle
htslib and handle code-signing/notarization per-OS.
Effort: **L.** Defer until there's real demand for a downloadable app.

Auth for standalone: reuse `gcloud` ADC — `env.rs` already shells to
`gcloud auth` / refreshes tokens. On an arbitrary machine the prereq is
`gcloud auth login` (device flow); document it. "Shares authentication with the
server" = same gcloud creds on the box.

## Recommendation / sequence

1. **Build the shared local API** (WS dispatch + `__GS_SEND` client shim). One
   M-sized piece; unblocks both features and is the only non-trivial part.
2. **#12 new-window** = API + `new_window` flag + open-or-print-URL, with the
   remote-kernel fallback to a `jupyter-server-proxy` URL. **S.**
3. **#59 standalone Level A** (`genomeshader serve` + system browser). **S–M.**
4. **Level B (pywebview)** when a windowed app is wanted. **S.**
5. **Level B' (Tauri single binary)** only on demand. **L** (Python-removal is
   the real cost).

Biggest risk to design around up front: **remote kernels** — localhost is on the
wrong host, so both #12 and any browser-open path need a proxy/forward story,
not `webbrowser.open`.
