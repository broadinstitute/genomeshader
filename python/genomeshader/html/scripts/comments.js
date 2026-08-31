// Comments tab: shared, persistent annotations anchored to a genomic region,
// variant, or allele (optionally for a specific sample). Storage lives in
// Python (one JSON per comment under {gcs_session_dir}/comments/); this file is
// the UI + on-track pins. Data rides the widget comm (comments_list /
// comments_create / comments_update / comments_delete).
(function setupComments() {
  if (typeof state === "undefined") return;
  state.comments = state.comments || [];
  let currentAuthor = "";
  let loading = false;
  let loaded = false;
  let composing = false;       // create form open?
  let editingId = null;        // comment being edited
  let draftAnchor = null;      // anchor captured when the create form opened
  let flashId = null;          // comment to briefly highlight (after pin click)
  let _composeCtl = null;      // controller for the open compose form (live updates)

  // The viewer calls this when the allele selection changes; keep the open
  // compose form's allele choice in sync with a fresh track click.
  window.__GS_onSelectionChange = function () {
    if (composing && _composeCtl && typeof _composeCtl.onSelectionChange === "function") {
      try { _composeCtl.onSelectionChange(); } catch (e) {}
    }
  };

  function host() {
    return (typeof byIdDynamic === "function" ? byIdDynamic("commentsContent") : null)
      || document.getElementById("commentsContent");
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  // Minimal, safe markdown → HTML. Escapes first, then applies a small subset
  // (headings, bold, italic, inline code, links, bullet lists, line breaks).
  // No external lib (CSP blocks CDNs) and no raw HTML passthrough.
  function md(src) {
    const lines = String(src || "").split(/\r?\n/);
    let html = "", inList = false;
    const inline = (t) => esc(t)
      .replace(/`([^`]+)`/g, (m, c) => "<code>" + c + "</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener">$1</a>');
    for (let raw of lines) {
      const line = raw.replace(/\s+$/, "");
      const h = line.match(/^(#{1,3})\s+(.*)$/);
      const li = line.match(/^\s*[-*]\s+(.*)$/);
      if (li) {
        if (!inList) { html += "<ul>"; inList = true; }
        html += "<li>" + inline(li[1]) + "</li>";
        continue;
      }
      if (inList) { html += "</ul>"; inList = false; }
      if (h) { const n = h[1].length; html += "<h" + n + ">" + inline(h[2]) + "</h" + n + ">"; }
      else if (line === "") html += "<br>";
      else html += "<div>" + inline(line) + "</div>";
    }
    if (inList) html += "</ul>";
    return html;
  }

  function fmtTime(iso) {
    if (!iso) return "";
    // "2026-08-28T18:41:48+00:00" -> "2026-08-28 18:41" (keep it simple/stable)
    const m = String(iso).match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
    return m ? m[1] + " " + m[2] : String(iso);
  }

  const ANCHOR_ICON = { region: "▦", variant: "◆", allele: "◇", gene: "⌬", sample: "◉", read: "≡" };
  function anchorIcon(a) { return (a && ANCHOR_ICON[a.type]) || "◆"; }

  function pinPos(a) {
    // Genomic bp a comment pins to (for on-track markers + navigation).
    if (!a || !a.locus) return null;
    const L = a.locus;
    if (L.pos != null) return Number(L.pos);
    if (L.start != null && L.end != null) return Math.round((Number(L.start) + Number(L.end)) / 2);
    return null;
  }
  function inView(a) {
    if (!a || !a.locus || a.locus.contig !== state.contig) return false;
    const p = pinPos(a);
    return p != null && p >= state.startBp && p <= state.endBp;
  }

  // ---- rendering -----------------------------------------------------------
  function render() {
    const h = host(); if (!h) return;
    h.innerHTML = "";

    // "New comment" button / compose form.
    const bar = document.createElement("div");
    bar.style.cssText = "padding:2px 2px 8px;";
    if (!composing) {
      const btn = document.createElement("button");
      btn.textContent = "+ New comment";
      btn.style.cssText = "width:100%;padding:7px 10px;border:1px solid var(--border2);border-radius:6px;"
        + "background:var(--panel);color:var(--text);font-size:12px;cursor:pointer;";
      btn.addEventListener("click", () => { openCompose(); });
      bar.appendChild(btn);
    } else {
      bar.appendChild(composeForm());
    }
    h.appendChild(bar);

    if (loading && !loaded) {
      const m = document.createElement("div");
      m.style.cssText = "font-size:11px;color:var(--muted);padding:6px 2px;";
      m.textContent = "Loading comments…";
      h.appendChild(m); return;
    }

    if (!state.comments.length) {
      const m = document.createElement("div");
      m.style.cssText = "font-size:11px;color:var(--muted);padding:6px 2px;line-height:1.5;";
      m.textContent = "No comments yet. Select a variant/allele (or just a region) and add one.";
      h.appendChild(m); return;
    }

    // Newest first for reading.
    const sorted = state.comments.slice().sort((a, b) =>
      String(b.created || "").localeCompare(String(a.created || "")));
    sorted.forEach(c => h.appendChild(commentCard(c)));
  }

  function anchorChip(a, sample) {
    const chip = document.createElement("div");
    chip.style.cssText = "display:flex;align-items:center;gap:6px;font-size:10.5px;color:var(--muted);"
      + "margin-bottom:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
    const t = (a && a.type) || "region";
    chip.innerHTML = '<span style="font-size:12px;">' + anchorIcon(a) + "</span>"
      + '<span style="text-transform:uppercase;letter-spacing:.03em;">' + esc(t) + "</span>"
      + '<span style="color:var(--text);overflow:hidden;text-overflow:ellipsis;">' + esc((a && a.ref) || "") + "</span>"
      + ((sample) ? '<span style="color:var(--blue);">· ' + esc(sample) + "</span>" : "");
    return chip;
  }

  function commentCard(c) {
    const card = document.createElement("div");
    card.setAttribute("data-cid", c.id);
    const flash = (c.id === flashId);
    card.style.cssText = "border:1px solid var(--border2);border-radius:8px;padding:9px 10px;margin:0 2px 8px;"
      + "background:var(--panel);" + (flash ? "outline:2px solid var(--blue);" : "");
    if (flash) setTimeout(() => { flashId = null; }, 1600);

    const a = c.anchor || {};
    const goable = pinPos(a) != null;
    const chipRow = document.createElement("div");
    chipRow.style.cssText = "display:flex;align-items:center;gap:6px;";
    const chip = anchorChip(a, a.sample);
    chip.style.flex = "1";
    chipRow.appendChild(chip);
    if (goable) {
      const go = iconBtn("⤖", "Go to locus");
      go.addEventListener("click", () => {
        if (window.__GS_gotoComment) window.__GS_gotoComment(a);
      });
      chipRow.appendChild(go);
    }
    card.appendChild(chipRow);

    if (editingId === c.id) {
      card.appendChild(editForm(c));
      return card;
    }

    const body = document.createElement("div");
    body.className = "comment-body";
    body.style.cssText = "font-size:12px;color:var(--text);line-height:1.5;word-break:break-word;";
    body.innerHTML = md(c.body);
    card.appendChild(body);

    const meta = document.createElement("div");
    meta.style.cssText = "font-size:10px;color:var(--muted);margin-top:6px;display:flex;justify-content:space-between;gap:8px;";
    const who = document.createElement("span");
    const edited = c.updated && c.updated !== c.created;
    who.textContent = (c.author || "unknown") + " · " + fmtTime(c.created)
      + (edited ? "  (edited " + fmtTime(c.updated) + (c.updatedBy && c.updatedBy !== c.author ? " by " + c.updatedBy : "") + ")" : "");
    who.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    const actions = document.createElement("span");
    actions.style.cssText = "display:flex;gap:8px;flex:0 0 auto;";
    const edit = linkBtn("Edit");
    edit.addEventListener("click", () => { editingId = c.id; composing = false; render(); });
    const del = linkBtn("Delete");
    del.style.color = "var(--danger, #e5534b)";
    del.addEventListener("click", () => deleteComment(c.id));
    actions.appendChild(edit); actions.appendChild(del);
    meta.appendChild(who); meta.appendChild(actions);
    card.appendChild(meta);
    return card;
  }

  function iconBtn(txt, title) {
    const b = document.createElement("button");
    b.textContent = txt; b.title = title || "";
    b.style.cssText = "flex:0 0 auto;border:1px solid var(--border2);border-radius:5px;background:transparent;"
      + "color:var(--text);font-size:12px;cursor:pointer;padding:1px 6px;line-height:1.4;";
    return b;
  }
  function linkBtn(txt) {
    const b = document.createElement("button");
    b.textContent = txt;
    b.style.cssText = "border:none;background:transparent;color:var(--muted);font-size:10.5px;cursor:pointer;padding:0;";
    return b;
  }

  function textarea(val) {
    const ta = document.createElement("textarea");
    ta.value = val || "";
    ta.placeholder = "Write a comment… (markdown: **bold**, *italic*, `code`, - lists)";
    ta.setAttribute("data-1p-ignore", "");
    ta.rows = 4;
    ta.style.cssText = "width:100%;box-sizing:border-box;padding:7px 8px;border:1px solid var(--border2);"
      + "border-radius:6px;background:var(--bg,var(--panel));color:var(--text);font-size:12px;resize:vertical;"
      + "font-family:inherit;margin:2px 0 6px;";
    return ta;
  }
  function sampleInput(val) {
    const inp = document.createElement("input");
    inp.type = "text"; inp.value = val || ""; inp.placeholder = "sample (optional)";
    inp.setAttribute("data-1p-ignore", "");
    inp.style.cssText = "width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid var(--border2);"
      + "border-radius:6px;background:var(--bg,var(--panel));color:var(--text);font-size:12px;margin:0 0 6px;";
    return inp;
  }
  function rowBtns(saveLabel, onSave, onCancel) {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:6px;justify-content:flex-end;";
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    cancel.style.cssText = "padding:5px 10px;border:1px solid var(--border2);border-radius:6px;background:transparent;color:var(--muted);font-size:11px;cursor:pointer;";
    cancel.addEventListener("click", onCancel);
    const save = document.createElement("button");
    save.textContent = saveLabel;
    save.style.cssText = "padding:5px 12px;border:1px solid var(--blue);border-radius:6px;background:var(--blue);color:#fff;font-size:11px;cursor:pointer;";
    save.addEventListener("click", onSave);
    row.appendChild(cancel); row.appendChild(save);
    return row;
  }

  function _fieldLabel(text) {
    const d = document.createElement("div");
    d.style.cssText = "font-size:10.5px;color:var(--muted);margin:6px 0 2px;";
    d.textContent = text;
    return d;
  }
  function _inputCss() {
    return "width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid var(--border2);"
      + "border-radius:6px;background:var(--bg,var(--panel));color:var(--text);font-size:12px;margin:0 0 2px;";
  }
  function _readonly(text) {
    const d = document.createElement("div");
    d.style.cssText = "font-size:12px;color:var(--text);padding:6px 8px;border:1px dashed var(--border2);"
      + "border-radius:6px;background:var(--panel);word-break:break-word;margin:0 0 2px;";
    d.textContent = text;
    return d;
  }
  // Sample picker with autocomplete over the known sample list (same source the
  // sample-search box uses). Calls onPick(value) as the text changes / on select.
  function sampleAutocomplete(samples, initial, onPick) {
    const box = document.createElement("div");
    box.style.position = "relative";
    const inp = document.createElement("input");
    inp.type = "text"; inp.value = initial || ""; inp.placeholder = "type a sample name…";
    inp.setAttribute("data-1p-ignore", ""); inp.style.cssText = _inputCss();
    const results = document.createElement("div");
    results.style.cssText = "display:none;max-height:160px;overflow-y:auto;border:1px solid var(--border2);"
      + "border-radius:6px;background:var(--panel);position:absolute;left:0;right:0;z-index:5;";
    const draw = () => {
      const q = inp.value.trim().toLowerCase();
      results.innerHTML = "";
      const matches = (samples || []).filter(s => !q || s.toLowerCase().includes(q)).slice(0, 50);
      if (!matches.length) { results.style.display = "none"; return; }
      matches.forEach(s => {
        const r = document.createElement("div");
        r.textContent = s;
        r.style.cssText = "padding:5px 8px;font-size:12px;cursor:pointer;color:var(--text);";
        r.addEventListener("mouseenter", () => r.style.background = "var(--panel2)");
        r.addEventListener("mouseleave", () => r.style.background = "");
        r.addEventListener("mousedown", (e) => { e.preventDefault(); inp.value = s; onPick(s); results.style.display = "none"; });
        results.appendChild(r);
      });
      results.style.display = "block";
    };
    inp.addEventListener("input", () => { onPick(inp.value.trim()); draw(); });
    inp.addEventListener("focus", draw);
    inp.addEventListener("blur", () => setTimeout(() => { results.style.display = "none"; }, 150));
    box.appendChild(inp); box.appendChild(results);
    return box;
  }

  function openCompose() {
    composing = true; editingId = null;
    render();
  }

  function _alleleKey(c) { return c ? ((c.trackId || "") + "|" + c.variantId + "|" + c.alleleIndex) : ""; }

  function composeForm() {
    const opts = (window.__GS_anchorOptions ? window.__GS_anchorOptions()
      : { contig: "", region: { start: 0, end: 0 }, genes: [], samples: [], reads: [], alleleChoices: [] });
    const contig = opts.contig || "";
    const wrap = document.createElement("div");
    wrap.style.cssText = "border:1px solid var(--border2);border-radius:8px;padding:9px 10px;background:var(--panel);";

    // Author — required (prefilled from Google/OS identity when known).
    wrap.appendChild(_fieldLabel("Your name / email (required)"));
    const auth = document.createElement("input");
    auth.type = "text"; auth.setAttribute("data-1p-ignore", ""); auth.placeholder = "required";
    auth.value = (currentAuthor && currentAuthor !== "unknown") ? currentAuthor : "";
    auth.style.cssText = _inputCss();
    wrap.appendChild(auth);

    // What to comment on.
    wrap.appendChild(_fieldLabel("Comment on"));
    const typeSel = document.createElement("select");
    typeSel.style.cssText = _inputCss();
    const hasAllele = !!(opts.allele || (opts.alleleChoices && opts.alleleChoices.length));
    const typeDefs = [];
    if (hasAllele) typeDefs.push(["allele", "Allele / variant"]);
    typeDefs.push(["region", "Current region"]);
    if (opts.genes && opts.genes.length) typeDefs.push(["gene", "Gene in view"]);
    if (opts.samples && opts.samples.length) typeDefs.push(["sample", "Sample"]);
    if (opts.reads && opts.reads.length) typeDefs.push(["read", "Loaded read track"]);
    typeDefs.forEach(([v, lbl]) => { const o = document.createElement("option"); o.value = v; o.textContent = lbl; typeSel.appendChild(o); });
    typeSel.value = hasAllele ? "allele" : "region";
    wrap.appendChild(typeSel);

    const detail = document.createElement("div");
    wrap.appendChild(detail);
    const picked = {
      allele: null,
      gene: (opts.genes && opts.genes[0]) || null,
      sample: (opts.samples && opts.samples[0]) || "",
      read: (opts.reads && opts.reads[0]) || null,
    };

    function renderDetail() {
      detail.innerHTML = "";
      const t = typeSel.value;
      if (t === "allele") {
        const choices = (opts.alleleChoices && opts.alleleChoices.length)
          ? opts.alleleChoices : (opts.allele ? [opts.allele] : []);
        if (!choices.length) {
          detail.appendChild(_readonly("No alleles in view — pan to a variant, or pick another type."));
          picked.allele = null;
        } else {
          const sel = document.createElement("select"); sel.style.cssText = _inputCss();
          choices.forEach((c, i) => { const o = document.createElement("option"); o.value = String(i); o.textContent = c.ref; sel.appendChild(o); });
          let defIdx = 0;
          if (opts.allele) { const k = _alleleKey(opts.allele); const j = choices.findIndex(c => _alleleKey(c) === k); if (j >= 0) defIdx = j; }
          sel.value = String(defIdx);
          picked.allele = choices[defIdx] || null;
          sel.addEventListener("change", () => { picked.allele = choices[+sel.value] || null; validate(); });
          detail.appendChild(sel);
        }
      } else if (t === "region") {
        detail.appendChild(_readonly(`${contig}:${opts.region.start.toLocaleString()}-${opts.region.end.toLocaleString()}`));
      } else if (t === "gene") {
        const gs = document.createElement("select"); gs.style.cssText = _inputCss();
        opts.genes.forEach(g => { const o = document.createElement("option"); o.value = g.name; o.textContent = g.name; gs.appendChild(o); });
        if (picked.gene) gs.value = picked.gene.name;
        gs.addEventListener("change", () => { picked.gene = opts.genes.find(g => g.name === gs.value) || null; validate(); });
        detail.appendChild(gs);
      } else if (t === "sample") {
        detail.appendChild(sampleAutocomplete(opts.samples, picked.sample, (v) => { picked.sample = v; validate(); }));
      } else if (t === "read") {
        const rs = document.createElement("select"); rs.style.cssText = _inputCss();
        opts.reads.forEach((r, i) => { const o = document.createElement("option"); o.value = String(i); o.textContent = "reads · " + (r.label || r.sample); rs.appendChild(o); });
        rs.addEventListener("change", () => { picked.read = opts.reads[+rs.value] || null; validate(); });
        detail.appendChild(rs);
      }
    }

    wrap.appendChild(_fieldLabel("Comment"));
    const ta = textarea("");
    wrap.appendChild(ta);

    // Buttons — Save stays disabled until every required field is valid.
    const btnRow = document.createElement("div");
    btnRow.style.cssText = "display:flex;gap:6px;justify-content:flex-end;";
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    cancel.style.cssText = "padding:5px 10px;border:1px solid var(--border2);border-radius:6px;background:transparent;color:var(--muted);font-size:11px;cursor:pointer;";
    cancel.addEventListener("click", () => { composing = false; render(); });
    const save = document.createElement("button");
    save.textContent = "Save";
    save.addEventListener("click", () => {
      if (save.disabled) return;
      const anchor = _buildAnchor(typeSel.value, opts, contig, picked);
      if (!anchor) { validate(); return; }
      createComment(anchor, ta.value.trim(), auth.value.trim());
    });
    btnRow.appendChild(cancel); btnRow.appendChild(save);
    wrap.appendChild(btnRow);

    function anchorValid() {
      const t = typeSel.value;
      if (t === "allele") return !!picked.allele;
      if (t === "gene") return !!picked.gene;
      if (t === "sample") return !!(picked.sample && picked.sample.trim());
      if (t === "read") return !!picked.read;
      return true; // region is always valid
    }
    function validate() {
      const ok = !!auth.value.trim() && !!ta.value.trim() && anchorValid();
      save.disabled = !ok;
      save.style.cssText = "padding:5px 12px;border:1px solid var(--blue);border-radius:6px;font-size:11px;"
        + (ok ? "background:var(--blue);color:#fff;cursor:pointer;opacity:1;"
              : "background:var(--blue);color:#fff;cursor:not-allowed;opacity:0.45;");
    }

    auth.addEventListener("input", validate);
    ta.addEventListener("input", validate);
    typeSel.addEventListener("change", () => { renderDetail(); validate(); });
    renderDetail();
    validate();

    // Live-update the allele choice when the user clicks a new allele in the
    // track while this form is open.
    _composeCtl = {
      onSelectionChange() {
        if (typeSel.value !== "allele") return;
        const fresh = window.__GS_anchorOptions ? window.__GS_anchorOptions() : null;
        if (!fresh || !fresh.allele) return;
        opts.alleleChoices = fresh.alleleChoices || opts.alleleChoices;
        opts.allele = fresh.allele;
        renderDetail();   // defaults the dropdown to the newly selected allele
        validate();
      },
    };

    setTimeout(() => { (auth.value ? ta : auth).focus(); }, 0);
    return wrap;
  }

  function _buildAnchor(type, opts, contig, picked) {
    const region = opts.region || { start: 0, end: 0 };
    const mid = Math.round((region.start + region.end) / 2);
    const regionLocus = { contig: contig, start: region.start, end: region.end, pos: mid };
    if (type === "allele" && opts.allele) {
      const a = opts.allele;
      return {
        type: a.isAllele ? "allele" : "variant", ref: a.ref,
        locus: { contig: contig, pos: a.pos }, variantId: a.variantId,
        alleleIndex: a.alleleIndex, alleleLabel: a.label, trackId: a.trackId, sample: null,
      };
    }
    if (type === "gene" && picked.gene) {
      const g = picked.gene;
      return {
        type: "gene", ref: g.name, gene: g.name,
        locus: { contig: contig, start: g.start, end: g.end, pos: Math.round((g.start + g.end) / 2) }, sample: null,
      };
    }
    if (type === "sample") {
      const s = (picked.sample || "").trim();
      if (!s) return null;
      return { type: "sample", ref: s, sample: s, locus: regionLocus };
    }
    if (type === "read" && picked.read) {
      const r = picked.read;
      return { type: "read", ref: "reads · " + (r.label || r.sample), sample: r.sample, locus: regionLocus };
    }
    return {
      type: "region",
      ref: `${contig}:${region.start.toLocaleString()}-${region.end.toLocaleString()}`,
      locus: regionLocus, sample: null,
    };
  }

  function editForm(c) {
    const wrap = document.createElement("div");
    wrap.style.cssText = "margin-top:6px;";
    const ta = textarea(c.body);
    wrap.appendChild(ta);
    wrap.appendChild(rowBtns("Save", () => {
      const body = ta.value.trim();
      if (!body) { ta.focus(); return; }
      updateComment(c.id, body);
    }, () => { editingId = null; render(); }));
    setTimeout(() => ta.focus(), 0);
    return wrap;
  }

  // ---- comm ---------------------------------------------------------------
  function load(force) {
    if (loading) return;
    if (loaded && !force) { render(); return; }
    if (typeof sendCommMessage !== "function") {
      const h = host(); if (h) h.innerHTML = '<div style="font-size:11px;color:var(--muted);padding:6px 2px;">Comments channel unavailable.</div>';
      return;
    }
    loading = true; render();
    sendCommMessage("comments_list", {}).then(resp => {
      loading = false; loaded = true;
      currentAuthor = resp.author || currentAuthor;
      state.comments = Array.isArray(resp.comments) ? resp.comments : [];
      render();
      if (typeof renderAll === "function") renderAll(); // refresh on-track pins
    }).catch(() => {
      loading = false; loaded = true;
      render();
    });
  }

  function createComment(anchor, body, author) {
    if (typeof sendCommMessage !== "function") return;
    if (author) currentAuthor = author;   // remember for the next comment
    sendCommMessage("comments_create", { anchor: anchor, body: body, author: author || null }).then(resp => {
      if (resp && resp.comment) state.comments.push(resp.comment);
      composing = false; draftAnchor = null;
      render();
      if (typeof renderAll === "function") renderAll();
    }).catch(() => { composing = false; render(); });
  }

  function updateComment(id, body) {
    if (typeof sendCommMessage !== "function") return;
    sendCommMessage("comments_update", { id: id, body: body }).then(resp => {
      if (resp && resp.comment) {
        const i = state.comments.findIndex(c => c.id === id);
        if (i >= 0) state.comments[i] = resp.comment;
      }
      editingId = null; render();
      if (typeof renderAll === "function") renderAll();
    }).catch(() => { editingId = null; render(); });
  }

  function deleteComment(id) {
    if (typeof sendCommMessage !== "function") return;
    sendCommMessage("comments_delete", { id: id }).then(() => {
      state.comments = state.comments.filter(c => c.id !== id);
      render();
      if (typeof renderAll === "function") renderAll();
    }).catch(() => {});
  }

  // ---- on-track pins (locus/ruler track) ----------------------------------
  // Called from tracks.js while rendering the locus ruler. Draws one small
  // marker per in-view comment; clicking it opens the Comments tab scrolled to
  // that comment.
  window.__GS_renderCommentPins = function (ctx) {
    if (!ctx || !ctx.svg || !ctx.el || typeof ctx.genomePos !== "function") return;
    if (!state.comments || !state.comments.length) return;
    const el = ctx.el, svg = ctx.svg, isVertical = ctx.isVertical;
    // Group in-view comments by bp so stacked comments share one pin.
    const byPos = new Map();
    for (const c of state.comments) {
      const a = c.anchor || {};
      if (!inView(a)) continue;
      const p = pinPos(a);
      const key = String(p);
      if (!byPos.has(key)) byPos.set(key, { bp: p, items: [] });
      byPos.get(key).items.push(c);
    }
    byPos.forEach(group => {
      const pos = ctx.genomePos(group.bp);
      const n = group.items.length;
      let g;
      if (isVertical) {
        const cx = ctx.baseX + 24;
        g = el("g", { style: "cursor:pointer;" });
        g.appendChild(el("line", { x1: ctx.baseX, x2: cx, y1: pos, y2: pos, stroke: "var(--blue)", "stroke-width": 1 }));
        g.appendChild(el("circle", { cx: cx, cy: pos, r: 5.5, fill: "var(--blue)", stroke: "var(--panel)", "stroke-width": 1 }));
      } else {
        const cy = ctx.baseY - 24;
        g = el("g", { style: "cursor:pointer;" });
        g.appendChild(el("line", { x1: pos, x2: pos, y1: ctx.baseY, y2: cy, stroke: "var(--blue)", "stroke-width": 1 }));
        // speech-bubble-ish marker: a small rounded square
        g.appendChild(el("rect", { x: pos - 5.5, y: cy - 5.5, width: 11, height: 11, rx: 2.5, fill: "var(--blue)", stroke: "var(--panel)", "stroke-width": 1 }));
      }
      if (n > 1) {
        const tx = isVertical ? ctx.baseX + 24 : pos;
        const ty = isVertical ? pos + 3 : ctx.baseY - 24 + 3;
        g.appendChild(el("text", { x: tx, y: ty, "text-anchor": "middle", "font-size": "8px", fill: "#fff", style: "pointer-events:none;" }, String(n)));
      }
      const title = el("title", {}, n === 1 ? (group.items[0].author + ": " + (group.items[0].body || "").slice(0, 80)) : (n + " comments"));
      g.appendChild(title);
      g.addEventListener("click", (e) => {
        e.stopPropagation();
        openToComment(group.items[0].id);
      });
      svg.appendChild(g);
    });
  };

  function openToComment(id) {
    // Switch to the Comments tab (right panel) and flash the target.
    if (typeof setActiveTab === "function") setActiveTab("comments");
    else {
      const icon = document.querySelector('.command-strip-icon[data-tab="comments"]');
      if (icon) icon.click();
    }
    flashId = id;
    load();
    setTimeout(() => {
      const h = host();
      if (h) { const card = h.querySelector('[data-cid="' + id + '"]'); if (card) card.scrollIntoView({ block: "center" }); }
    }, 60);
  }

  // ---- wiring -------------------------------------------------------------
  const icon = document.querySelector('.command-strip-icon[data-tab="comments"]');
  if (icon) icon.addEventListener("click", () => load());
  if (typeof getActiveTab === "function" && getActiveTab() === "comments") load();
  // Prime once so on-track pins appear even before the tab is first opened.
  else setTimeout(() => { if (!loaded) load(); }, 800);
})();
