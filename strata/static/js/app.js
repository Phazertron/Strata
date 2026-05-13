/* ── Strata — main app ──────────────────────────────────────────────────── */

// ---------------------------------------------------------------------------
// Audio engine
// ---------------------------------------------------------------------------

const audioCtx  = new (window.AudioContext || window.webkitAudioContext)();
const masterGain = audioCtx.createGain();
masterGain.connect(audioCtx.destination);

function resumeCtx() {
  if (audioCtx.state === "suspended") audioCtx.resume();
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Icons (inline SVG)
// ---------------------------------------------------------------------------

// Sine-wave path — visually matches brain delta/theta waves (beds = ambient loops)
const ICON_BED = `<svg width="18" height="10" viewBox="0 0 18 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M0 5 C1.8 5 2.2 1 4.5 1 C6.8 1 7.2 9 9 9 C10.8 9 11.2 1 13.5 1 C15.8 1 16.2 5 18 5"/></svg>`;

// Three-line list + crosshair plus — classic "add to queue" (Spotify/YouTube style)
const ICON_QUEUE = `<svg width="18" height="12" viewBox="0 0 18 12" fill="currentColor" aria-hidden="true"><rect x="0" y="0.5" width="11" height="1.5" rx="0.75"/><rect x="0" y="4.5" width="11" height="1.5" rx="0.75"/><rect x="0" y="8.5" width="11" height="1.5" rx="0.75"/><rect x="13.25" y="3.5" width="1.5" height="5" rx="0.75"/><rect x="11" y="5.25" width="6" height="1.5" rx="0.75"/></svg>`;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

// activeTracks: Map<slotId, TrackNode>
// Bed slotId = trackId OR trackId-seg-SafeName  (deduplicated)
// Queue slotId = trackId-qN                     (allows repeats)
const activeTracks = new Map();

// Queue: ordered slotIds that play in sequence
let sequenceOrder    = [];
let currentQueueIdx  = -1;
let queueLooping     = true;
let _queueSlotSeq    = 0;       // counter for unique queue slot IDs
let queueMasterVolume = 1.0;    // multiplier applied on top of each queue track's individual vol

// Download jobs
let activeJobs = {};
let pollTimer  = null;

const CROSSFADE_S = 1.5;

let globalPaused = true;
let library  = [];
let presets  = [];
let currentPresetName = null;   // name of the last loaded preset
let currentView = "mixer";
let libTab = "all";
let libSort = "date";

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function fmt(secs) {
  if (secs == null || isNaN(secs)) return "—";
  secs = Math.max(0, Math.floor(secs));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`
    : `${m}:${String(s).padStart(2,"0")}`;
}

function fmtMins(mins) {
  if (!mins) return "0m";
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function isoNow() { return new Date().toISOString(); }

// Parse "M:SS", "MM:SS", "H:MM:SS" → seconds.  Clamps seconds/minutes to 0-59.
function parseTimeInput(str) {
  if (!str) return 0;
  const parts = str.trim().split(":").map(p => parseInt(p, 10));
  if (parts.some(isNaN)) return 0;
  const [a = 0, b = 0, c = 0] = parts;
  if (parts.length === 1) return a;
  if (parts.length === 2) return a * 60 + Math.min(59, b);
  return a * 3600 + Math.min(59, b) * 60 + Math.min(59, c);
}

// Format raw digit string (up to 6 digits) as "M:SS" / "MM:SS" / "H:MM:SS".
function formatTimeDigits(digits) {
  digits = digits.replace(/\D/g, "").slice(0, 6);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return digits.slice(0, -2) + ":" + digits.slice(-2);
  return digits.slice(0, -4) + ":" + digits.slice(-4, -2) + ":" + digits.slice(-2);
}

// Attach MM:SS live-formatting to a text input.
// Returns { getSeconds(), setSeconds(n) }.
function attachTimeInput(el) {
  el.addEventListener("keydown", e => {
    if (e.ctrlKey || e.metaKey) return;
    if (["Backspace","Delete","ArrowLeft","ArrowRight","Home","End","Tab"].includes(e.key)) return;
    if (!/^\d$/.test(e.key)) e.preventDefault();
  });
  el.addEventListener("input", () => {
    const pos = el.selectionStart;
    const raw = el.value.replace(/\D/g, "").slice(0, 6);
    el.value = formatTimeDigits(raw);
    // keep cursor roughly in place (colon insertion can shift it by 1)
    try { el.setSelectionRange(pos, pos); } catch(_) {}
  });
  return {
    getSeconds() { return parseTimeInput(el.value); },
    setSeconds(secs) { el.value = secs > 0 ? fmt(secs) : "0:00"; },
  };
}

function esc(s) {
  if (s == null) return "";
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function safeId(str)    { return String(str).replace(/[^a-zA-Z0-9_-]/g, "_"); }
function slotIdFor(tid, segName) { return segName ? `${tid}-seg-${safeId(segName)}` : tid; }
function displayName(t) { return t.custom_label || t.title || "Untitled"; }

function toast(msg, isError = false) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = "show" + (isError ? " error" : "");
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.className = ""; }, 3200);
}

async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const r = await fetch("/api" + path, opts);
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(err.error || r.statusText);
  }
  return r.json();
}

// ---------------------------------------------------------------------------
// View switching
// ---------------------------------------------------------------------------

function switchView(name) {
  currentView = name;
  document.querySelectorAll("nav button[data-view]").forEach(b =>
    b.classList.toggle("active", b.dataset.view === name));
  document.querySelectorAll(".view").forEach(v =>
    v.classList.toggle("active", v.id === name + "-view"));
  if (name === "stats") loadStats();
}

document.querySelectorAll("nav button[data-view]").forEach(btn =>
  btn.addEventListener("click", () => switchView(btn.dataset.view)));

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

async function loadLibrary() {
  library = await api("GET", "/tracks");
  renderLibrary();
}

function sortedTracks(tracks) {
  return [...tracks].sort((a, b) => {
    if (libSort === "title") return displayName(a).localeCompare(displayName(b));
    if (libSort === "plays") return (b._play_count || 0) - (a._play_count || 0);
    return new Date(b.date_added) - new Date(a.date_added);
  });
}

function renderLibrary() {
  const grid = document.getElementById("library-grid");
  grid.innerHTML = "";
  const sorted = sortedTracks(library);

  if (libTab === "all") {
    sorted.forEach(t => grid.appendChild(makeCard(t)));
  } else if (libTab === "channel") {
    const groups = {};
    for (const t of sorted) {
      const ch = t.source_channel || "Unknown";
      (groups[ch] = groups[ch] || []).push(t);
    }
    for (const [ch, tracks] of Object.entries(groups).sort()) {
      grid.appendChild(makeGroupHeader(ch));
      tracks.forEach(t => grid.appendChild(makeCard(t)));
    }
  } else if (libTab === "mood") {
    const moodMap = {};
    for (const t of sorted) {
      const moods = t.mood_tags?.length ? t.mood_tags : ["Untagged"];
      for (const m of moods) (moodMap[m] = moodMap[m] || []).push(t);
    }
    for (const [mood, tracks] of Object.entries(moodMap).sort()) {
      grid.appendChild(makeGroupHeader(mood));
      tracks.forEach(t => grid.appendChild(makeCard(t)));
    }
  }
}

function makeGroupHeader(label) {
  const h = document.createElement("div");
  h.className = "group-header";
  h.textContent = label;
  return h;
}

function makeCard(track) {
  const card = document.createElement("div");
  card.className = "track-card";
  card.dataset.id = track.id;

  const thumbUrl = track.thumbnail ? `/api/tracks/${track.id}/thumbnail` : null;
  const hasSegs  = track.segments?.length > 0;

  card.innerHTML = `
    ${thumbUrl
      ? `<img class="card-thumb" src="${thumbUrl}" alt="" loading="lazy">`
      : `<div class="card-thumb-placeholder">♫</div>`}
    <div class="card-body">
      <div class="card-title">${esc(displayName(track))}</div>
      ${track.custom_label
        ? `<div class="card-channel" style="font-style:italic">${esc(track.title)}</div>`
        : (track.source_channel ? `<div class="card-channel">${esc(track.source_channel)}</div>` : "")}
      <div class="card-moods">
        ${(track.mood_tags || []).map(m => `<span class="mood-chip">${esc(m)}</span>`).join("")}
      </div>
      <div class="card-meta">
        <span>${fmt(track.duration_seconds)}</span>
        ${hasSegs ? `<button class="seg-toggle-btn">${track.segments.length} segment${track.segments.length > 1 ? "s" : ""} ▾</button>` : ""}
        ${track.source_url ? `<a href="${esc(track.source_url)}" target="_blank" rel="noopener" style="color:var(--text-dim);font-size:10px" onclick="event.stopPropagation()">↗</a>` : ""}
      </div>
      ${hasSegs ? `<div class="seg-sub-row" style="display:none">${track.segments.map(s => `
        <div class="seg-extract-item">
          <span class="seg-extract-name">${esc(s.name)}</span>
          <span class="seg-extract-times">${fmt(s.start)}–${fmt(s.end)}</span>
          <button class="seg-extract-add" data-zone="bed"   data-seg-name="${esc(s.name)}" title="Add to Beds">${ICON_BED}</button>
          <button class="seg-extract-add" data-zone="queue" data-seg-name="${esc(s.name)}" title="Add to Queue">${ICON_QUEUE}</button>
        </div>`).join("")}</div>` : ""}
    </div>
    <div class="card-actions">
      <button data-action="bed"   title="Add to Beds — loops continuously">${ICON_BED} Bed</button>
      <button data-action="queue" title="Add to Queue — plays in sequence">${ICON_QUEUE} Queue</button>
      <button data-action="edit"  title="Edit metadata">✎</button>
      <button data-action="delete" class="danger card-delete" title="Delete track">🗑</button>
    </div>
  `;

  // Segment sub-row toggle
  const toggleBtn = card.querySelector(".seg-toggle-btn");
  const subRow    = card.querySelector(".seg-sub-row");
  if (toggleBtn && subRow) {
    toggleBtn.addEventListener("click", e => {
      e.stopPropagation();
      const open = subRow.style.display !== "none";
      subRow.style.display = open ? "none" : "flex";
      toggleBtn.textContent = `${track.segments.length} segment${track.segments.length > 1 ? "s" : ""} ${open ? "▾" : "▴"}`;
    });
  }

  // Segment → Bed / Queue
  card.querySelectorAll(".seg-extract-add").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const seg = track.segments.find(s => s.name === btn.dataset.segName);
      if (seg) { addToMixer(track, seg, btn.dataset.zone); switchView("mixer"); }
    });
  });

  card.querySelector("[data-action=bed]").addEventListener("click", e => {
    e.stopPropagation(); addToMixer(track, null, "bed"); switchView("mixer");
  });
  card.querySelector("[data-action=queue]").addEventListener("click", e => {
    e.stopPropagation(); addToMixer(track, null, "queue"); switchView("mixer");
  });
  card.querySelector("[data-action=edit]").addEventListener("click", e => {
    e.stopPropagation(); openTrackModal(track);
  });
  card.querySelector("[data-action=delete]").addEventListener("click", async e => {
    e.stopPropagation();
    if (!confirm(`Delete "${displayName(track)}"?`)) return;
    try {
      await api("DELETE", `/tracks/${track.id}`);
      for (const [sid, node] of activeTracks) {
        if (node.meta.id === track.id) removeFromMixer(sid);
      }
      await loadLibrary();
      toast("Track deleted");
    } catch (err) { toast(err.message, true); }
  });

  return card;
}

document.querySelectorAll(".lib-tab").forEach(btn =>
  btn.addEventListener("click", () => {
    libTab = btn.dataset.tab;
    document.querySelectorAll(".lib-tab").forEach(b => b.classList.toggle("active", b === btn));
    renderLibrary();
  }));

document.getElementById("lib-sort").addEventListener("change", e => {
  libSort = e.target.value; renderLibrary();
});

// ---------------------------------------------------------------------------
// Mixer — add / remove
// ---------------------------------------------------------------------------

function addToMixer(track, segment = null, zone = "bed") {
  resumeCtx();
  // Beds deduplicate (same track can't loop twice); queue allows repeats
  const baseSlotId = slotIdFor(track.id, segment?.name);
  const slotId     = zone === "queue" ? `${baseSlotId}-q${++_queueSlotSeq}` : baseSlotId;
  if (zone === "bed" && activeTracks.has(slotId)) { toast("Already in beds"); return; }

  const audioEl    = new Audio(`/api/tracks/${track.id}/audio`);
  audioEl.crossOrigin = "anonymous";
  const sourceNode = audioCtx.createMediaElementSource(audioEl);
  const gainNode   = audioCtx.createGain();
  const initVol    = zone === "queue" ? 0.8 * queueMasterVolume : 0.8;
  gainNode.gain.value = initVol;
  sourceNode.connect(gainNode);
  gainNode.connect(masterGain);

  const node = {
    meta: track, segment, zone,
    audioEl, sourceNode, gainNode,
    _targetVolume: 0.8,
    sessionStart: isoNow(),
    _timeUpdateHandler: null,
  };

  if (zone === "bed") {
    audioEl.loop = !segment;
    audioEl.currentTime = segment?.start || 0;
    if (!globalPaused) audioEl.play().catch(() => {});
    globalPaused = false;
  } else {
    // Queue: play immediately only if first item; otherwise queue it
    audioEl.loop = false;
    audioEl.currentTime = segment?.start || 0;
    const isFirst = sequenceOrder.length === 0;
    sequenceOrder.push(slotId);
    if (isFirst && !globalPaused || isFirst && activeTracks.size === 0) {
      currentQueueIdx = 0;
      globalPaused = false;
      audioEl.play().catch(() => {});
    }
  }

  activeTracks.set(slotId, node);
  attachHandlers(slotId, node);
  renderMixerTrack(slotId);
  updateZoneEmpty();
  updateTransportLabel();
  if (zone === "queue") updateQueueHighlight();
}

function removeFromMixer(slotId) {
  const node = activeTracks.get(slotId);
  if (!node) return;

  api("POST", "/telemetry/event", {
    track_id: node.meta.id,
    started_at: node.sessionStart,
    ended_at: isoNow(),
    segment_name: node.segment?.name || null,
    source: "mixer",
  }).catch(() => {});

  node.audioEl.pause();
  if (node._timeUpdateHandler) {
    node.audioEl.removeEventListener("timeupdate", node._timeUpdateHandler);
  }
  node.gainNode.disconnect();
  activeTracks.delete(slotId);

  if (node.zone === "queue") {
    const idx = sequenceOrder.indexOf(slotId);
    sequenceOrder = sequenceOrder.filter(id => id !== slotId);
    if (idx === currentQueueIdx) {
      // Was the active item — advance to next if possible
      if (sequenceOrder.length > 0) {
        currentQueueIdx = Math.min(idx, sequenceOrder.length - 1);
        if (!globalPaused) playQueueItem(currentQueueIdx);
      } else {
        currentQueueIdx = -1;
      }
    } else if (idx < currentQueueIdx) {
      currentQueueIdx--;
    }
  }

  const el = document.getElementById("mtrack-" + slotId);
  if (el) el.remove();
  updateZoneEmpty();
  updateTransportLabel();
  updateQueueHighlight();
}

// ---------------------------------------------------------------------------
// Mixer — handlers per node
// ---------------------------------------------------------------------------

function attachHandlers(slotId, node) {
  const handler = () => {
    updateSeekDisplay(slotId, node);

    const seg = node.segment;
    if (seg && node.audioEl.currentTime >= seg.end) {
      if (node.zone === "bed") {
        node.audioEl.currentTime = seg.start;    // loop segment in bed
      } else {
        node.audioEl.pause();
        advanceQueue(slotId);
      }
    }
  };
  node.audioEl.addEventListener("timeupdate", handler);
  node._timeUpdateHandler = handler;

  // Non-segmented queue tracks advance on natural end
  node.audioEl.addEventListener("ended", () => {
    if (node.zone === "queue" && !node.segment) advanceQueue(slotId);
  });
}

function updateSeekDisplay(slotId, node) {
  const el = document.getElementById("mtrack-" + slotId);
  if (!el || !node.audioEl.duration) return;
  const slider = el.querySelector(".seek-slider");
  const timeEl = el.querySelector(".time-display");
  if (!slider || slider.dataset.seeking === "1") return;

  slider.value = (node.audioEl.currentTime / node.audioEl.duration) * 1000;
  if (timeEl) {
    const seg   = node.segment;
    const cur   = seg ? Math.max(0, node.audioEl.currentTime - seg.start) : node.audioEl.currentTime;
    const total = seg ? seg.end - seg.start : node.audioEl.duration;
    timeEl.textContent = `${fmt(cur)} / ${fmt(total)}`;
  }
}

// ---------------------------------------------------------------------------
// Mixer — render
// ---------------------------------------------------------------------------

function renderMixerTrack(slotId) {
  const node = activeTracks.get(slotId);
  if (!node) return;
  const { meta, segment, zone } = node;

  const container = document.getElementById(zone === "bed" ? "beds-tracks" : "queue-tracks");
  const div = document.createElement("div");
  div.className = "mixer-track";
  div.id = "mtrack-" + slotId;
  if (zone === "queue") div.setAttribute("draggable", "true");

  const thumbUrl = meta.thumbnail ? `/api/tracks/${meta.id}/thumbnail` : null;

  div.innerHTML = `
    ${zone === "queue" ? `<div class="drag-handle" title="Drag to reorder">⠿</div>` : ""}
    ${thumbUrl
      ? `<img class="thumb" src="${thumbUrl}" alt="">`
      : `<div class="thumb-placeholder">♫</div>`}
    <div class="mixer-track-info">
      <div class="slot-name" contenteditable="true" spellcheck="false"
           data-placeholder="${esc(segment ? segment.name : displayName(meta))}"
           title="Click to rename this slot"></div>
      <div class="slot-origin">
        ${esc(displayName(meta))}${meta.source_channel && !meta.custom_label ? ` · ${esc(meta.source_channel)}` : ""}
        ${segment ? ` <span class="seg-label">◈ ${esc(segment.name)}</span>` : ""}
      </div>
      <div class="mixer-seek-row">
        <span class="time-display">0:00 / ${fmt(segment ? segment.end - segment.start : meta.duration_seconds)}</span>
        <input type="range" class="seek-slider" min="0" max="1000" value="0">
      </div>
      <div class="mixer-track-row">
        <button class="play-btn" data-playing="true" title="Play / Pause">⏸</button>
        <input type="range" class="vol-slider" min="0" max="1" step="0.01" value="0.8" title="Volume">
        ${zone === "bed"
          ? `<button class="toggle-btn on" data-loop="true" title="Loop">🔁</button>`
          : `<span class="queue-num"></span>`}
        <button class="toggle-btn" data-action="edit-segs" title="Edit segments">✎</button>
        <button class="toggle-btn" data-action="remove" style="margin-left:auto" title="Remove">✕</button>
      </div>
    </div>
  `;

  // Segment bar (whole-track beds only)
  if (zone === "bed" && !segment && meta.segments?.length && meta.duration_seconds) {
    const bar = document.createElement("div");
    bar.className = "segment-bar";
    bar.style.marginTop = "6px";
    meta.segments.forEach(s => {
      const left  = (s.start / meta.duration_seconds * 100).toFixed(2);
      const width = ((s.end - s.start) / meta.duration_seconds * 100).toFixed(2);
      const chip  = document.createElement("div");
      chip.className = "seg-chip";
      chip.style.cssText = `left:${left}%;width:${width}%`;
      chip.title = s.name; chip.textContent = s.name; chip.dataset.segName = s.name;
      chip.addEventListener("click", () => jumpToSegment(slotId, s, chip));
      bar.appendChild(chip);
    });
    div.querySelector(".mixer-track-info").appendChild(bar);
  }

  // — Slot name (contenteditable)
  const slotNameEl   = div.querySelector(".slot-name");
  const slotOriginEl = div.querySelector(".slot-origin");
  const syncSlotName = () => {
    const val = slotNameEl.textContent.trim();
    node.displayName = val || null;
    slotOriginEl.classList.toggle("origin-dimmed", !!val);
    slotNameEl.classList.toggle("empty", !val);
  };
  slotNameEl.addEventListener("input",   syncSlotName);
  slotNameEl.addEventListener("blur",    () => { if (!slotNameEl.textContent.trim()) slotNameEl.textContent = ""; syncSlotName(); });
  slotNameEl.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); slotNameEl.blur(); } });
  syncSlotName();

  // — Play / Pause
  const playBtn = div.querySelector(".play-btn");
  playBtn.addEventListener("click", () => {
    if (zone === "queue") {
      const myIdx = sequenceOrder.indexOf(slotId);
      if (myIdx !== currentQueueIdx) {
        // Jump to this queue item
        jumpToQueueItem(myIdx);
        return;
      }
    }
    const playing = playBtn.dataset.playing === "true";
    if (playing) {
      node.audioEl.pause();
      playBtn.dataset.playing = "false"; playBtn.textContent = "▶"; playBtn.classList.add("paused");
    } else {
      resumeCtx(); node.audioEl.play().catch(() => {});
      playBtn.dataset.playing = "true"; playBtn.textContent = "⏸"; playBtn.classList.remove("paused");
    }
  });

  // — Seek (display while dragging, seek on release)
  const seekSlider = div.querySelector(".seek-slider");
  const timeEl     = div.querySelector(".time-display");
  seekSlider.addEventListener("input", () => {
    seekSlider.dataset.seeking = "1";
    const pct = parseFloat(seekSlider.value) / 1000;
    const seg = node.segment;
    const dur = seg ? seg.end - seg.start : (node.audioEl.duration || 0);
    if (timeEl) timeEl.textContent = `${fmt(pct * dur)} / ${fmt(dur)}`;
  });
  seekSlider.addEventListener("change", () => {
    seekSlider.dataset.seeking = "";
    if (!node.audioEl.duration) return;
    const target = (parseFloat(seekSlider.value) / 1000) * node.audioEl.duration;
    node.audioEl.currentTime = node.segment
      ? Math.min(Math.max(target, node.segment.start), node.segment.end - 0.5)
      : target;
  });

  // — Volume
  const volSlider = div.querySelector(".vol-slider");
  volSlider.addEventListener("input", () => {
    node._targetVolume = parseFloat(volSlider.value);
    node.gainNode.gain.value = node._targetVolume * (zone === "queue" ? queueMasterVolume : 1);
  });

  // — Loop (bed only)
  if (zone === "bed") {
    const loopBtn = div.querySelector("[data-loop]");
    loopBtn?.addEventListener("click", () => {
      const looping = loopBtn.dataset.loop === "true";
      const next = !looping;
      node.audioEl.loop = next && !node.segment;
      loopBtn.dataset.loop = String(next);
      loopBtn.classList.toggle("on", next);
    });
  }

  // — Segment chips (bed, whole track)
  div.querySelectorAll(".seg-chip").forEach(chip => {
    const s = meta.segments?.find(x => x.name === chip.dataset.segName);
    if (s) chip.addEventListener("click", () => jumpToSegment(slotId, s, chip));
  });

  // — Edit segments
  div.querySelector("[data-action=edit-segs]").addEventListener("click", () => openTrackModal(meta));

  // — Remove
  div.querySelector("[data-action=remove]").addEventListener("click", () => removeFromMixer(slotId));

  container.appendChild(div);
}

function jumpToSegment(slotId, seg, chip) {
  const node = activeTracks.get(slotId);
  if (!node) return;
  document.querySelectorAll(`#mtrack-${slotId} .seg-chip`).forEach(c => c.classList.remove("active"));
  chip.classList.add("active");
  node.audioEl.currentTime = seg.start;
}

function updateZoneEmpty() {
  const hasBeds  = [...activeTracks.values()].some(n => n.zone === "bed");
  const hasQueue = [...activeTracks.values()].some(n => n.zone === "queue");
  document.getElementById("beds-empty").style.display  = hasBeds  ? "none" : "block";
  document.getElementById("queue-empty").style.display = hasQueue ? "none" : "block";
}

// ---------------------------------------------------------------------------
// Queue management
// ---------------------------------------------------------------------------

function playQueueItem(idx) {
  if (idx < 0 || idx >= sequenceOrder.length) return;
  currentQueueIdx = idx;
  const node = activeTracks.get(sequenceOrder[idx]);
  if (!node) return;
  node.audioEl.currentTime = node.segment?.start || 0;
  node.audioEl.play().catch(() => {});
  updateQueueHighlight();
}

function jumpToQueueItem(idx) {
  const from = activeTracks.get(sequenceOrder[currentQueueIdx]);
  const to   = activeTracks.get(sequenceOrder[idx]);
  if (!to) return;
  to.audioEl.currentTime = to.segment?.start || 0;
  to.audioEl.play().catch(() => {});
  if (from && from !== to) crossfadeNodes(from, to, CROSSFADE_S);
  currentQueueIdx = idx;
  updateQueueHighlight();
}

function advanceQueue(finishedSlotId) {
  const idx = sequenceOrder.indexOf(finishedSlotId);
  if (idx < 0 || idx !== currentQueueIdx) return;

  let nextIdx = idx + 1;
  if (nextIdx >= sequenceOrder.length) {
    if (!queueLooping) { currentQueueIdx = -1; updateQueueHighlight(); return; }
    nextIdx = 0;
  }

  const from     = activeTracks.get(finishedSlotId);
  const toSlotId = sequenceOrder[nextIdx];
  const to       = activeTracks.get(toSlotId);
  if (!to) return;

  to.audioEl.currentTime = to.segment?.start || 0;
  to.audioEl.play().catch(() => {});
  crossfadeNodes(from, to, CROSSFADE_S);
  currentQueueIdx = nextIdx;
  updateQueueHighlight();
}

function crossfadeNodes(from, to, dur) {
  const now = audioCtx.currentTime;
  if (from) {
    from.gainNode.gain.cancelScheduledValues(now);
    from.gainNode.gain.setValueAtTime(from.gainNode.gain.value, now);
    from.gainNode.gain.exponentialRampToValueAtTime(0.001, now + dur);
    from.gainNode.gain.setValueAtTime(0, now + dur);
  }
  const toVol = (to._targetVolume || 0.8) * (to.zone === "queue" ? queueMasterVolume : 1);
  to.gainNode.gain.cancelScheduledValues(now);
  to.gainNode.gain.setValueAtTime(0.001, now);
  to.gainNode.gain.exponentialRampToValueAtTime(toVol, now + dur);
}

function updateQueueHighlight() {
  document.querySelectorAll("#queue-tracks .mixer-track").forEach((el, i) => {
    const slotId   = el.id.replace("mtrack-", "");
    const isActive = sequenceOrder.indexOf(slotId) === currentQueueIdx && currentQueueIdx >= 0;
    el.classList.toggle("queue-active", isActive);

    const pb = el.querySelector(".play-btn");
    if (pb) {
      const playing = isActive && !globalPaused;
      pb.textContent = playing ? "⏸" : "▶";
      pb.dataset.playing = String(playing);
      pb.classList.toggle("paused", !playing);
      pb.title = isActive ? "Play / Pause" : "Jump to this track";
    }

    const badge = el.querySelector(".queue-num");
    if (badge) badge.textContent = `#${i + 1}`;
  });
}

// Drag-to-reorder queue
function initQueueDrag() {
  const container = document.getElementById("queue-tracks");

  container.addEventListener("dragstart", e => {
    const item = e.target.closest(".mixer-track");
    if (!item) return;
    item.classList.add("dragging");
    e.dataTransfer.setData("text/plain", item.id);
    e.dataTransfer.effectAllowed = "move";
  });

  container.addEventListener("dragend", () => {
    document.querySelectorAll(".mixer-track.dragging").forEach(el => el.classList.remove("dragging"));
    // Rebuild sequenceOrder from DOM
    const newOrder = [...container.querySelectorAll(".mixer-track")]
      .map(el => el.id.replace("mtrack-", ""));
    // Keep currentQueueIdx pointing at the same track
    const activeSlotId = sequenceOrder[currentQueueIdx];
    sequenceOrder = newOrder;
    currentQueueIdx = activeSlotId ? sequenceOrder.indexOf(activeSlotId) : -1;
    updateQueueHighlight();
  });

  container.addEventListener("dragover", e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const dragging = container.querySelector(".dragging");
    if (!dragging) return;
    const target = e.target.closest(".mixer-track:not(.dragging)");
    if (!target) return;
    const rect = target.getBoundingClientRect();
    if (e.clientY < rect.top + rect.height / 2) {
      container.insertBefore(dragging, target);
    } else {
      target.insertAdjacentElement("afterend", dragging);
    }
  });

  container.addEventListener("drop", e => e.preventDefault());
}

// Queue loop toggle
document.getElementById("queue-loop-btn").addEventListener("click", () => {
  queueLooping = !queueLooping;
  document.getElementById("queue-loop-btn").classList.toggle("on", queueLooping);
});

document.getElementById("queue-master-vol").addEventListener("input", e => {
  queueMasterVolume = parseFloat(e.target.value);
  for (const [, node] of activeTracks) {
    if (node.zone === "queue") {
      node.gainNode.gain.cancelScheduledValues(audioCtx.currentTime);
      node.gainNode.gain.value = node._targetVolume * queueMasterVolume;
    }
  }
});

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

function updateTransportLabel() {
  const beds  = [...activeTracks.values()].filter(n => n.zone === "bed").length;
  const queue = sequenceOrder.length;
  const parts = [];
  if (beds)  parts.push(`${beds} bed${beds > 1 ? "s" : ""}`);
  if (queue) parts.push(`${queue} queued`);
  const el = document.getElementById("transport-label");
  if (el) el.textContent = parts.length ? parts.join(", ") : "No tracks";
  const btn = document.getElementById("transport-play");
  if (btn) btn.textContent = globalPaused ? "▶" : "⏸";
}

function toggleGlobalPlayback() {
  if (activeTracks.size === 0) return;
  resumeCtx();
  globalPaused = !globalPaused;

  for (const [slotId, node] of activeTracks) {
    if (node.zone === "bed") {
      globalPaused ? node.audioEl.pause() : node.audioEl.play().catch(() => {});
      const el = document.getElementById("mtrack-" + slotId);
      const pb = el?.querySelector(".play-btn");
      if (pb) {
        pb.dataset.playing = String(!globalPaused);
        pb.textContent = globalPaused ? "▶" : "⏸";
        pb.classList.toggle("paused", globalPaused);
      }
    }
  }

  // Queue: only the active item
  if (currentQueueIdx >= 0 && currentQueueIdx < sequenceOrder.length) {
    const activeNode = activeTracks.get(sequenceOrder[currentQueueIdx]);
    if (activeNode) {
      globalPaused ? activeNode.audioEl.pause() : activeNode.audioEl.play().catch(() => {});
    }
  }

  updateQueueHighlight();
  updateTransportLabel();
}

document.getElementById("transport-play").addEventListener("click", toggleGlobalPlayback);

document.getElementById("master-vol").addEventListener("input", e => {
  masterGain.gain.value = parseFloat(e.target.value);
});

document.addEventListener("keydown", e => {
  const mediaKeys = ["MediaPlayPause", "MediaPlay", "MediaPause", "MediaStop"];
  if (mediaKeys.includes(e.code)) {
    e.preventDefault();
    if (e.code === "MediaStop") { if (!globalPaused) toggleGlobalPlayback(); }
    else toggleGlobalPlayback();
    return;
  }
  if (e.code === "Space") {
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" ||
        document.activeElement?.isContentEditable) return;
    e.preventDefault();
    toggleGlobalPlayback();
  }
});

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

async function loadPresets() {
  presets = await api("GET", "/presets");
  const sel = document.getElementById("preset-select");
  sel.innerHTML = `<option value="">Load preset…</option>` +
    presets.map(p => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join("");
}

function setCurrentPreset(name) {
  currentPresetName = name;
  const lbl = document.getElementById("current-preset-label");
  if (lbl) lbl.textContent = name || "No preset";
  const def = document.getElementById("set-default-btn");
  if (def) def.classList.toggle("on", name && localStorage.getItem("strata_default_preset") === name);
}

async function applyPreset(preset) {
  [...activeTracks.keys()].forEach(removeFromMixer);
  for (const entry of preset.tracks) {
    const track = library.find(t => t.id === entry.track_id);
    if (!track) continue;
    let segment = entry.segment || null;
    if (!segment && entry.active_segment) {
      segment = track.segments?.find(s => s.name === entry.active_segment) || null;
    }
    const zone = entry.zone || (entry.play_mode === "sequence" ? "queue" : "bed");
    const keysBefore = new Set(activeTracks.keys());
    addToMixer(track, segment, zone);
    // The new slot is whichever key appeared after the call
    const newSlotId = [...activeTracks.keys()].find(k => !keysBefore.has(k));
    if (!newSlotId) continue;
    const node = activeTracks.get(newSlotId);
    node._targetVolume = entry.volume ?? 0.8;
    node.gainNode.gain.value = node._targetVolume * (node.zone === "queue" ? queueMasterVolume : 1);
    const vs = document.querySelector(`#mtrack-${CSS.escape(newSlotId)} .vol-slider`);
    if (vs) vs.value = entry.volume ?? 0.8;
  }
  setCurrentPreset(preset.name);
  toast(`Loaded: ${preset.name}`);
}

document.getElementById("preset-select").addEventListener("change", async e => {
  const name = e.target.value;
  if (!name) return;
  const preset = presets.find(p => p.name === name);
  if (preset) await applyPreset(preset);
  e.target.value = "";
});

document.getElementById("set-default-btn").addEventListener("click", () => {
  if (!currentPresetName) { toast("Load a preset first", true); return; }
  const current = localStorage.getItem("strata_default_preset");
  if (current === currentPresetName) {
    localStorage.removeItem("strata_default_preset");
    document.getElementById("set-default-btn").classList.remove("on");
    toast("Default preset cleared");
  } else {
    localStorage.setItem("strata_default_preset", currentPresetName);
    document.getElementById("set-default-btn").classList.add("on");
    toast(`"${currentPresetName}" set as default`);
  }
});

document.getElementById("save-preset-btn").addEventListener("click", async () => {
  if (activeTracks.size === 0) { toast("Nothing in mixer", true); return; }
  const name = prompt("Preset name:");
  if (!name?.trim()) return;
  const tracks = [];
  for (const [slotId, node] of activeTracks) {
    tracks.push({
      track_id: node.meta.id,
      segment:  node.segment || null,
      volume:   node._targetVolume || node.gainNode.gain.value,
      zone:     node.zone || "bed",
    });
  }
  try {
    await api("POST", "/presets", { name: name.trim(), tracks });
    await loadPresets();
    toast(`Preset "${name.trim()}" saved`);
  } catch (err) { toast(err.message, true); }
});

document.getElementById("delete-preset-btn").addEventListener("click", async () => {
  const sel = document.getElementById("preset-select");
  const name = sel.value;
  if (!name) { toast("Select a preset first", true); return; }
  if (!confirm(`Delete preset "${name}"?`)) return;
  try {
    await api("DELETE", `/presets/${encodeURIComponent(name)}`);
    await loadPresets();
    toast(`Deleted: ${name}`);
  } catch (err) { toast(err.message, true); }
});

// ---------------------------------------------------------------------------
// Download queue
// ---------------------------------------------------------------------------

function renderJobQueue() {
  const container = document.getElementById("job-queue");
  const entries   = Object.entries(activeJobs);
  container.innerHTML = "";
  if (!entries.length) { container.style.display = "none"; return; }
  container.style.display = "flex";
  for (const [id, job] of entries) {
    const item = document.createElement("div");
    item.className = `job-item job-${job.status}`;
    const icon  = { queued:"⏳", running:"⬇", done:"✓", error:"✗" }[job.status] || "?";
    const label = job.track?.title || job.url;
    item.innerHTML = `
      <span class="job-icon">${icon}</span>
      ${job.status === "running" ? `<span class="spinner"></span>` : ""}
      <span class="job-label">${esc(label.length > 48 ? label.slice(0,45)+"…" : label)}</span>
      ${(job.status === "done" || job.status === "error")
        ? `<button class="job-dismiss" data-jid="${id}">✕</button>` : ""}
    `;
    if (job.status === "running") item.querySelector(".job-icon").remove();
    container.appendChild(item);
  }
  container.querySelectorAll(".job-dismiss").forEach(btn =>
    btn.addEventListener("click", () => { delete activeJobs[btn.dataset.jid]; renderJobQueue(); }));
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    const pending = Object.values(activeJobs).filter(j => j.status === "queued" || j.status === "running");
    if (!pending.length) { clearInterval(pollTimer); pollTimer = null; return; }
    try {
      const jobs = await api("GET", "/jobs");
      for (const [id, job] of Object.entries(jobs)) {
        if (!activeJobs[id]) continue;
        const prev = activeJobs[id].status;
        activeJobs[id] = job;
        if (job.status === "done" && prev !== "done") {
          library.push(job.track); renderLibrary(); toast(`Downloaded: ${job.track.title}`);
        } else if (job.status === "error" && prev !== "error") {
          toast(`Download failed`, true);
        }
      }
      renderJobQueue();
    } catch { /* network blip */ }
  }, 3000);
}

async function submitDownload(url) {
  try {
    const res = await api("POST", "/download", { url });
    activeJobs[res.job_id] = { status: "queued", url };
    renderJobQueue(); startPolling();
    return true;
  } catch (err) { toast(err.message, true); return false; }
}

// ---------------------------------------------------------------------------
// Add track modal
// ---------------------------------------------------------------------------

const addModal = document.getElementById("add-modal");
document.getElementById("add-track-btn").addEventListener("click",       () => addModal.classList.remove("hidden"));
document.getElementById("add-modal-close").addEventListener("click",     () => addModal.classList.add("hidden"));
addModal.addEventListener("click", e => { if (e.target === addModal) addModal.classList.add("hidden"); });

document.querySelectorAll(".modal-tab").forEach(btn =>
  btn.addEventListener("click", () => {
    const panel = btn.dataset.panel;
    document.querySelectorAll(".modal-tab").forEach(b => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".modal-panel").forEach(p => p.classList.toggle("active", p.id === panel));
    document.getElementById("download-btn").style.display =
      panel === "download-panel" ? "inline-flex" : "none";
  }));

const dropZone = document.getElementById("drop-zone");
const fileInput = document.getElementById("file-input");
dropZone.addEventListener("click",     () => fileInput.click());
dropZone.addEventListener("dragover",  e => { e.preventDefault(); dropZone.classList.add("over"); });
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("over"));
dropZone.addEventListener("drop", e => {
  e.preventDefault(); dropZone.classList.remove("over");
  if (e.dataTransfer.files.length) uploadFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener("change", () => { if (fileInput.files.length) uploadFile(fileInput.files[0]); });

async function uploadFile(file) {
  const status = document.getElementById("upload-status");
  status.innerHTML = `<span class="spinner"></span> Uploading…`;
  const form = new FormData();
  form.append("file", file);
  try {
    const r = await fetch("/api/upload", { method: "POST", body: form });
    if (!r.ok) throw new Error((await r.json()).error);
    const track = await r.json();
    library.push(track); renderLibrary();
    status.textContent = `✓ ${track.title}`; toast("Track uploaded"); fileInput.value = "";
  } catch (err) { status.textContent = "✗ " + err.message; toast(err.message, true); }
}

document.getElementById("download-btn").addEventListener("click", async () => {
  const input = document.getElementById("yt-url");
  const url = input.value.trim();
  if (!url) return;
  const ok = await submitDownload(url);
  if (ok) { input.value = ""; document.getElementById("download-status").textContent = "Queued — track will appear in library when done."; }
});

// ---------------------------------------------------------------------------
// Track detail / edit modal
// ---------------------------------------------------------------------------

let editingTrack = null;

function openTrackModal(track) {
  editingTrack = { ...track, segments: [...(track.segments || [])] };
  document.getElementById("edit-custom-label").value = track.custom_label || "";
  document.getElementById("edit-title").value         = track.title || "";
  document.getElementById("edit-channel").value       = track.source_channel || "";
  document.getElementById("edit-moods").value         = (track.mood_tags || []).map(t => t.toLowerCase()).join(", ");
  syncOriginalsDim();
  const lbl = document.getElementById("edit-custom-label");
  lbl.oninput = syncOriginalsDim;
  // Reset parse-tracklist section
  document.getElementById("tracklist-paste").value = "";
  document.getElementById("parse-tracklist-status").textContent = "";
  document.getElementById("parse-tracklist-details").removeAttribute("open");
  renderSegList(editingTrack.segments, track.duration_seconds);
  initDualRange(track.duration_seconds);
  document.getElementById("track-modal").classList.remove("hidden");
}

function syncOriginalsDim() {
  const has = !!document.getElementById("edit-custom-label").value.trim();
  document.getElementById("edit-originals").style.opacity = has ? "0.45" : "1";
}

// ---------------------------------------------------------------------------
// Tag autocomplete
// ---------------------------------------------------------------------------

const moodsInput   = document.getElementById("edit-moods");
const tagSuggestEl = document.getElementById("tag-suggestions");

function allLibraryTags() {
  return [...new Set(library.flatMap(t => (t.mood_tags || []).map(s => s.toLowerCase())))].sort();
}

function currentPartialTag() {
  const val   = moodsInput.value;
  const parts = val.split(",");
  return parts[parts.length - 1].trim().toLowerCase();
}

function showTagSuggestions() {
  const partial = currentPartialTag();
  if (!partial) { tagSuggestEl.style.display = "none"; return; }
  const matches = allLibraryTags().filter(t => t.startsWith(partial) && t !== partial);
  if (!matches.length) { tagSuggestEl.style.display = "none"; return; }
  tagSuggestEl.innerHTML = matches.map(t =>
    `<div class="tag-suggestion" data-tag="${esc(t)}">${esc(t)}</div>`
  ).join("");
  tagSuggestEl.style.display = "block";
}

function acceptTagSuggestion(tag) {
  const parts  = moodsInput.value.split(",");
  parts[parts.length - 1] = " " + tag;
  moodsInput.value = parts.join(",") + ", ";
  moodsInput.focus();
  tagSuggestEl.style.display = "none";
}

moodsInput.addEventListener("input", () => {
  moodsInput.value = moodsInput.value.toLowerCase();
  showTagSuggestions();
});
moodsInput.addEventListener("blur", () => {
  setTimeout(() => { tagSuggestEl.style.display = "none"; }, 150);
});
moodsInput.addEventListener("focus", showTagSuggestions);
tagSuggestEl.addEventListener("mousedown", e => {
  const item = e.target.closest(".tag-suggestion");
  if (item) { e.preventDefault(); acceptTagSuggestion(item.dataset.tag); }
});

// ---------------------------------------------------------------------------
// Tracklist parser (client-side — same logic as server description parser)
// ---------------------------------------------------------------------------

function parseTracklistText(text, totalDuration) {
  const tsRe  = /\b(\d{1,2}:\d{2}(?::\d{2})?)\b/;
  const urlRe = /https?:\/\/\S+/g;
  const numRe = /^\d+[.)]\s*/;
  const candidates = [];

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = tsRe.exec(line);
    if (!m) continue;

    const parts = m[1].split(":").map(Number);
    const secs  = parts.length === 3
      ? parts[0] * 3600 + parts[1] * 60 + parts[2]
      : parts[0] * 60 + parts[1];

    let before = line.slice(0, m.index).trim().replace(urlRe, "").trim();
    let after  = line.slice(m.index + m[0].length).trim().replace(urlRe, "").trim();
    before = before.replace(numRe, "").trim().replace(/[-–·•\s]+$/, "").trim();
    after  = after.replace(/^[-–·•\s]+/, "").trim();

    const title = before || after || `Part ${candidates.length + 1}`;
    candidates.push({ start: secs, title });
  }

  if (candidates.length < 2) return [];
  candidates.sort((a, b) => a.start - b.start);

  return candidates.map((ch, i) => ({
    name:  ch.title,
    start: round2(ch.start),
    end:   round2(candidates[i + 1]?.start ?? (totalDuration || ch.start + 600)),
  })).filter(s => s.end > s.start);
}

function round2(n) { return Math.round(n * 100) / 100; }

document.getElementById("parse-tracklist-btn").addEventListener("click", () => {
  const text   = document.getElementById("tracklist-paste").value.trim();
  const status = document.getElementById("parse-tracklist-status");
  if (!text) { status.textContent = "Paste some text first."; return; }
  const segs = parseTracklistText(text, editingTrack?.duration_seconds);
  if (!segs.length) {
    status.textContent = "No timestamps found — make sure lines contain MM:SS markers.";
    return;
  }
  // Merge with existing segments (deduplicate by start time)
  const existing = new Set((editingTrack.segments || []).map(s => s.start));
  let added = 0;
  for (const s of segs) {
    if (!existing.has(s.start)) { editingTrack.segments.push(s); added++; }
  }
  editingTrack.segments.sort((a, b) => a.start - b.start);
  renderSegList(editingTrack.segments, editingTrack.duration_seconds);
  status.textContent = `Added ${added} segment${added !== 1 ? "s" : ""}.`;
});

function initDualRange(duration) {
  const wrap     = document.getElementById("seg-timeline-wrap");
  const startR   = document.getElementById("dr-start");
  const endR     = document.getElementById("dr-end");
  const fill     = document.getElementById("dr-fill");
  const startLbl = document.getElementById("dr-start-label");
  const endLbl   = document.getElementById("dr-end-label");
  const startNum = document.getElementById("seg-start");
  const endNum   = document.getElementById("seg-end");

  if (!duration) { wrap.style.display = "none"; return; }
  wrap.style.display = "block";

  const toSecs   = v => (v / 1000) * duration;
  const toSlider = s => Math.round((s / duration) * 1000);

  // Attach live-format behaviour (only once — clone to strip old listeners)
  const freshStart = startNum.cloneNode(true);
  const freshEnd   = endNum.cloneNode(true);
  startNum.parentNode.replaceChild(freshStart, startNum);
  endNum.parentNode.replaceChild(freshEnd, endNum);
  const ctrlStart = attachTimeInput(freshStart);
  const ctrlEnd   = attachTimeInput(freshEnd);

  function updateFill(s, e) {
    fill.style.left  = (s / 10) + "%";
    fill.style.width = ((e - s) / 10) + "%";
  }

  // Slider → text
  function syncSliderToText() {
    let s = parseInt(startR.value), e = parseInt(endR.value);
    if (s >= e - 10) {
      if (document.activeElement === startR) { s = e - 10; startR.value = s; }
      else { e = s + 10; endR.value = e; }
    }
    updateFill(s, e);
    const ss = toSecs(s), es = toSecs(e);
    startLbl.textContent = fmt(ss); endLbl.textContent = fmt(es);
    ctrlStart.setSeconds(ss);
    ctrlEnd.setSeconds(es);
  }

  // Text → slider (called on blur so correction only fires when user is done)
  function syncTextToSlider() {
    let s = Math.max(0, Math.min(ctrlStart.getSeconds(), duration));
    let e = Math.max(0, Math.min(ctrlEnd.getSeconds(),   duration));
    if (s >= e) e = Math.min(s + 1, duration);
    // Write corrected values back
    ctrlStart.setSeconds(s);
    ctrlEnd.setSeconds(e);
    startR.value = toSlider(s); endR.value = toSlider(e);
    updateFill(toSlider(s), toSlider(e));
    startLbl.textContent = fmt(s); endLbl.textContent = fmt(e);
  }

  startR.oninput = endR.oninput = syncSliderToText;
  freshStart.addEventListener("blur", syncTextToSlider);
  freshEnd.addEventListener("blur",   syncTextToSlider);

  // Initialise
  startR.value = 0; endR.value = 1000;
  ctrlStart.setSeconds(0);
  ctrlEnd.setSeconds(Math.round(duration));
  syncSliderToText();
}

function renderSegList(segs, duration) {
  const list = document.getElementById("seg-list");
  list.innerHTML = "";
  segs.forEach((seg, i) => {
    const item = document.createElement("div");
    item.className = "seg-item";
    item.innerHTML = `
      <span class="seg-name">${esc(seg.name)}</span>
      <span class="seg-times">${fmt(seg.start)} – ${fmt(seg.end)}</span>
      <button class="btn secondary" style="padding:3px 8px;font-size:11px" data-del="${i}">✕</button>
    `;
    item.querySelector("[data-del]").addEventListener("click", () => {
      editingTrack.segments.splice(i, 1);
      renderSegList(editingTrack.segments, duration);
    });
    list.appendChild(item);
  });
}

document.getElementById("add-seg-btn").addEventListener("click", () => {
  const name  = document.getElementById("seg-name").value.trim();
  const start = parseTimeInput(document.getElementById("seg-start").value);
  const end   = parseTimeInput(document.getElementById("seg-end").value);
  if (!name) { toast("Enter a segment name", true); return; }
  if (end <= start) { toast("End must be after start", true); return; }
  editingTrack.segments = editingTrack.segments || [];
  editingTrack.segments.push({ name, start, end });
  editingTrack.segments.sort((a, b) => a.start - b.start);
  renderSegList(editingTrack.segments, editingTrack.duration_seconds);
  document.getElementById("seg-name").value = "";
  initDualRange(editingTrack.duration_seconds);
});

document.getElementById("track-modal-close").addEventListener("click", () =>
  document.getElementById("track-modal").classList.add("hidden"));
document.getElementById("track-modal").addEventListener("click", e => {
  if (e.target === document.getElementById("track-modal"))
    document.getElementById("track-modal").classList.add("hidden");
});

document.getElementById("save-track-btn").addEventListener("click", async () => {
  if (!editingTrack) return;
  const payload = {
    custom_label:   document.getElementById("edit-custom-label").value.trim() || null,
    title:          document.getElementById("edit-title").value.trim(),
    source_channel: document.getElementById("edit-channel").value.trim(),
    mood_tags:      document.getElementById("edit-moods").value.split(",").map(s => s.trim().toLowerCase()).filter(Boolean),
    segments:       editingTrack.segments || [],
  };
  try {
    const updated = await api("POST", `/tracks/${editingTrack.id}`, payload);
    const idx = library.findIndex(t => t.id === editingTrack.id);
    if (idx >= 0) library[idx] = updated;
    for (const [sid, node] of activeTracks) {
      if (node.meta.id === updated.id) {
        node.meta = updated;
        const el = document.getElementById("mtrack-" + sid);
        if (el) { el.remove(); renderMixerTrack(sid); }
      }
    }
    renderLibrary();
    document.getElementById("track-modal").classList.add("hidden");
    toast("Track updated");
  } catch (err) { toast(err.message, true); }
});

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

async function loadStats() {
  const stats = await api("GET", "/telemetry/stats");
  document.getElementById("stat-all").textContent  = fmtMins(stats.total_minutes.all_time);
  document.getElementById("stat-7d").textContent   = fmtMins(stats.total_minutes.last_7d);
  document.getElementById("stat-30d").textContent  = fmtMins(stats.total_minutes.last_30d);
  renderStatsTable("top-count-table", stats.top_by_count, row => {
    const t = library.find(l => l.id === row.track_id);
    return [t ? displayName(t) : row.track_id, row.play_count + " plays"];
  });
  renderStatsTable("top-mins-table", stats.top_by_minutes, row => {
    const t = library.find(l => l.id === row.track_id);
    return [t ? displayName(t) : row.track_id, fmtMins(row.total_minutes)];
  });
  renderStatsTable("recent-table", stats.recently_played, row => {
    const t = library.find(l => l.id === row.track_id);
    return [t ? displayName(t) : row.track_id, new Date(row.last_played).toLocaleDateString()];
  });
}

function renderStatsTable(id, rows, mapper) {
  const tbody = document.getElementById(id);
  tbody.innerHTML = "";
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="2" style="color:var(--text-dim);font-size:12px">No data yet</td></tr>`;
    return;
  }
  for (const row of rows) {
    const [c1, c2] = mapper(row);
    const tr = document.createElement("tr");
    tr.innerHTML = `<td style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c1)}</td><td>${esc(String(c2))}</td>`;
    tbody.appendChild(tr);
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

(async () => {
  initQueueDrag();
  await loadLibrary();
  await loadPresets();
  updateZoneEmpty();
  updateTransportLabel();
  switchView("mixer");
  // Auto-load default preset if set
  const defaultPreset = localStorage.getItem("strata_default_preset");
  if (defaultPreset) {
    const preset = presets.find(p => p.name === defaultPreset);
    if (preset) { await applyPreset(preset); toast(`Default preset loaded: ${defaultPreset}`); }
  }
})();
