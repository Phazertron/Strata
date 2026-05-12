/* ── Strata — main app ──────────────────────────────────────────────────── */

// ---------------------------------------------------------------------------
// Audio engine
// ---------------------------------------------------------------------------

const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
const masterGain = audioCtx.createGain();
masterGain.connect(audioCtx.destination);

function resumeCtx() {
  if (audioCtx.state === "suspended") audioCtx.resume();
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

// activeTracks: Map<slotId, TrackNode>
// slotId = trackId  OR  trackId-seg-SafeName  (when a segment is loaded)
const activeTracks = new Map();

// Ordered slot IDs for sequential playback
let sequenceOrder = [];

// Download jobs  {jobId → {status, url, track_id, track?, error?}}
let activeJobs = {};
let pollTimer = null;

const CROSSFADE_S = 1.5;   // crossfade duration in seconds

let library  = [];
let presets  = [];
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

function esc(s) {
  if (s == null) return "";
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

// Safe HTML id/CSS selector from arbitrary string
function safeId(str) { return String(str).replace(/[^a-zA-Z0-9_-]/g, "_"); }

function slotIdFor(trackId, segName) {
  return segName ? `${trackId}-seg-${safeId(segName)}` : trackId;
}

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
// Library load & render
// ---------------------------------------------------------------------------

async function loadLibrary() {
  library = await api("GET", "/tracks");
  renderLibrary();
}

function sortedTracks(tracks) {
  return [...tracks].sort((a, b) => {
    if (libSort === "title") return a.title.localeCompare(b.title);
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
  const hasSegs = track.segments?.length > 0;

  card.innerHTML = `
    ${thumbUrl
      ? `<img class="card-thumb" src="${thumbUrl}" alt="" loading="lazy">`
      : `<div class="card-thumb-placeholder">♫</div>`}
    <div class="card-body">
      <div class="card-title">${esc(track.title)}</div>
      ${track.source_channel ? `<div class="card-channel">${esc(track.source_channel)}</div>` : ""}
      <div class="card-moods">
        ${(track.mood_tags || []).map(m => `<span class="mood-chip">${esc(m)}</span>`).join("")}
      </div>
      <div class="card-meta">
        <span>${fmt(track.duration_seconds)}</span>
        ${hasSegs ? `<button class="seg-toggle-btn" title="Show segments">${track.segments.length} segment${track.segments.length > 1 ? "s" : ""} ▾</button>` : ""}
        ${track.source_url ? `<a href="${esc(track.source_url)}" target="_blank" rel="noopener" style="color:var(--text-dim);font-size:10px" onclick="event.stopPropagation()">↗</a>` : ""}
      </div>
      ${hasSegs ? `<div class="seg-sub-row" style="display:none">${track.segments.map(s => `
        <div class="seg-extract-item">
          <span class="seg-extract-name">${esc(s.name)}</span>
          <span class="seg-extract-times">${fmt(s.start)} – ${fmt(s.end)}</span>
          <button class="seg-extract-mix" data-seg-name="${esc(s.name)}">+ Mix</button>
        </div>`).join("")}</div>` : ""}
    </div>
    <div class="card-actions">
      <button data-action="play" title="Add whole track to mixer">▶ Mix</button>
      <button data-action="edit" title="Edit metadata">✎ Edit</button>
      <button data-action="delete" class="danger" title="Delete">✕</button>
    </div>
  `;

  // Segment toggle
  const toggleBtn = card.querySelector(".seg-toggle-btn");
  const subRow = card.querySelector(".seg-sub-row");
  if (toggleBtn && subRow) {
    toggleBtn.addEventListener("click", e => {
      e.stopPropagation();
      const open = subRow.style.display !== "none";
      subRow.style.display = open ? "none" : "flex";
      toggleBtn.textContent = `${track.segments.length} segment${track.segments.length > 1 ? "s" : ""} ${open ? "▾" : "▴"}`;
    });
  }

  // Add segment to mixer
  card.querySelectorAll(".seg-extract-mix").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const seg = track.segments.find(s => s.name === btn.dataset.segName);
      if (seg) { addToMixer(track, seg); switchView("mixer"); }
    });
  });

  // Add whole track to mixer
  card.querySelector("[data-action=play]").addEventListener("click", e => {
    e.stopPropagation();
    addToMixer(track);
    switchView("mixer");
  });

  card.querySelector("[data-action=edit]").addEventListener("click", e => {
    e.stopPropagation();
    openTrackModal(track);
  });

  card.querySelector("[data-action=delete]").addEventListener("click", async e => {
    e.stopPropagation();
    if (!confirm(`Delete "${track.title}"?`)) return;
    try {
      await api("DELETE", `/tracks/${track.id}`);
      // Remove any mixer slots for this track
      for (const [sid, node] of activeTracks) {
        if (node.meta.id === track.id) removeFromMixer(sid);
      }
      await loadLibrary();
      toast("Track deleted");
    } catch (err) { toast(err.message, true); }
  });

  return card;
}

document.querySelectorAll(".lib-tab").forEach(btn => {
  btn.addEventListener("click", () => {
    libTab = btn.dataset.tab;
    document.querySelectorAll(".lib-tab").forEach(b => b.classList.toggle("active", b === btn));
    renderLibrary();
  });
});

document.getElementById("lib-sort").addEventListener("change", e => {
  libSort = e.target.value;
  renderLibrary();
});

// ---------------------------------------------------------------------------
// Mixer — core
// ---------------------------------------------------------------------------

function addToMixer(track, segment = null) {
  resumeCtx();
  const slotId = slotIdFor(track.id, segment?.name);

  if (activeTracks.has(slotId)) { toast("Already in mixer"); return; }

  const audioEl = new Audio(`/api/tracks/${track.id}/audio`);
  audioEl.crossOrigin = "anonymous";
  const sourceNode = audioCtx.createMediaElementSource(audioEl);
  const gainNode = audioCtx.createGain();
  gainNode.gain.value = 0.8;
  sourceNode.connect(gainNode);
  gainNode.connect(masterGain);

  const node = {
    meta: track,
    segment,             // {name, start, end} or null
    audioEl,
    sourceNode,
    gainNode,
    playMode: "loop",
    _targetVolume: 0.8,
    sessionStart: isoNow(),
  };

  if (segment) {
    audioEl.currentTime = segment.start;
    audioEl.loop = false;
  } else {
    audioEl.loop = true;
  }

  activeTracks.set(slotId, node);
  attachHandlers(slotId, node);
  audioEl.play().catch(() => {});
  renderMixerTrack(slotId);
  renderMixerEmpty();
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
  sequenceOrder = sequenceOrder.filter(id => id !== slotId);
  updateSequenceBadges();

  const el = document.getElementById("mtrack-" + slotId);
  if (el) el.remove();
  renderMixerEmpty();
}

// ---------------------------------------------------------------------------
// Mixer — event handlers per node
// ---------------------------------------------------------------------------

function attachHandlers(slotId, node) {
  const handler = () => {
    updateSeekDisplay(slotId, node);

    // Enforce segment bounds
    const seg = node.segment;
    if (seg && node.audioEl.currentTime >= seg.end) {
      if (node.playMode === "loop") {
        node.audioEl.currentTime = seg.start;
      } else {
        node.audioEl.pause();
        advanceSequence(slotId);
      }
    }
  };
  node.audioEl.addEventListener("timeupdate", handler);
  node._timeUpdateHandler = handler;

  // Non-segmented sequence tracks advance on natural end
  node.audioEl.addEventListener("ended", () => {
    if (node.playMode === "sequence" && !node.segment) {
      advanceSequence(slotId);
    }
  });
}

function updateSeekDisplay(slotId, node) {
  const el = document.getElementById("mtrack-" + slotId);
  if (!el || !node.audioEl.duration) return;
  const slider  = el.querySelector(".seek-slider");
  const timeEl  = el.querySelector(".time-display");
  if (!slider) return;

  const cur = node.audioEl.currentTime;
  slider.value = (cur / node.audioEl.duration) * 1000;

  if (timeEl) {
    const seg = node.segment;
    const display  = seg ? Math.max(0, cur - seg.start) : cur;
    const total    = seg ? (seg.end - seg.start) : node.audioEl.duration;
    timeEl.textContent = `${fmt(display)} / ${fmt(total)}`;
  }
}

// ---------------------------------------------------------------------------
// Mixer — render
// ---------------------------------------------------------------------------

function renderMixerTrack(slotId) {
  const node = activeTracks.get(slotId);
  if (!node) return;
  const { meta, segment } = node;

  const container = document.getElementById("mixer-tracks");
  const div = document.createElement("div");
  div.className = "mixer-track";
  div.id = "mtrack-" + slotId;

  const thumbUrl = meta.thumbnail ? `/api/tracks/${meta.id}/thumbnail` : null;

  div.innerHTML = `
    ${thumbUrl
      ? `<img class="thumb" src="${thumbUrl}" alt="">`
      : `<div class="thumb-placeholder">♫</div>`}
    <div class="mixer-track-info">
      <div class="title">${esc(meta.title)}</div>
      ${segment ? `<div class="seg-label">◈ ${esc(segment.name)}</div>` : ""}
      ${meta.source_channel ? `<div class="channel">${esc(meta.source_channel)}</div>` : ""}
      <div class="mixer-seek-row">
        <span class="time-display">0:00 / ${fmt(segment ? segment.end - segment.start : meta.duration_seconds)}</span>
        <input type="range" class="seek-slider" min="0" max="1000" value="0">
      </div>
      <div class="mixer-track-row">
        <button class="play-btn" data-playing="true" title="Pause">⏸</button>
        <input type="range" class="vol-slider" min="0" max="1" step="0.01" value="0.8" title="Volume">
        <button class="toggle-btn on" data-loop="true" title="Loop">🔁</button>
        <button class="mode-btn toggle-btn" title="Play mode: Loop">Loop</button>
        <button class="toggle-btn" data-action="edit-segs" title="Edit segments">Segs</button>
        <button class="toggle-btn" data-action="remove" style="margin-left:auto">✕</button>
      </div>
    </div>
  `;

  // Render segment bar if whole track with segments
  if (!segment && meta.segments?.length && meta.duration_seconds) {
    const segBar = document.createElement("div");
    segBar.className = "segment-bar";
    segBar.style.marginTop = "6px";
    meta.segments.forEach(s => {
      const left  = (s.start / meta.duration_seconds * 100).toFixed(2);
      const width = ((s.end - s.start) / meta.duration_seconds * 100).toFixed(2);
      const chip  = document.createElement("div");
      chip.className = "seg-chip";
      chip.style.cssText = `left:${left}%;width:${width}%`;
      chip.title = s.name;
      chip.textContent = s.name;
      chip.dataset.segName = s.name;
      chip.addEventListener("click", () => jumpToSegment(slotId, s, chip));
      segBar.appendChild(chip);
    });
    div.querySelector(".mixer-track-info").appendChild(segBar);
  }

  // — Play / Pause
  const playBtn = div.querySelector(".play-btn");
  playBtn.addEventListener("click", () => {
    const playing = playBtn.dataset.playing === "true";
    if (playing) {
      node.audioEl.pause();
      playBtn.dataset.playing = "false";
      playBtn.textContent = "▶";
      playBtn.classList.add("paused");
    } else {
      resumeCtx();
      node.audioEl.play().catch(() => {});
      playBtn.dataset.playing = "true";
      playBtn.textContent = "⏸";
      playBtn.classList.remove("paused");
    }
  });

  // — Seek
  const seekSlider = div.querySelector(".seek-slider");
  seekSlider.addEventListener("input", () => {
    if (!node.audioEl.duration) return;
    const target = (seekSlider.value / 1000) * node.audioEl.duration;
    // Clamp to segment bounds if applicable
    if (node.segment) {
      node.audioEl.currentTime = Math.min(Math.max(target, node.segment.start), node.segment.end - 0.5);
    } else {
      node.audioEl.currentTime = target;
    }
  });

  // — Volume
  const volSlider = div.querySelector(".vol-slider");
  volSlider.addEventListener("input", () => {
    node.gainNode.gain.value = parseFloat(volSlider.value);
    node._targetVolume = parseFloat(volSlider.value);
  });

  // — Loop (for whole-track non-segment mode)
  const loopBtn = div.querySelector("[data-loop]");
  loopBtn.addEventListener("click", () => {
    if (node.playMode !== "loop") return; // loop toggle only relevant in loop mode
    const looping = loopBtn.dataset.loop === "true";
    const nextLoop = !looping;
    node.audioEl.loop = nextLoop && !node.segment;
    loopBtn.dataset.loop = String(nextLoop);
    loopBtn.classList.toggle("on", nextLoop);
  });

  // — Play mode (Loop ↔ Sequence)
  const modeBtn = div.querySelector(".mode-btn");
  modeBtn.addEventListener("click", () => {
    const next = node.playMode === "loop" ? "sequence" : "loop";
    setPlayMode(slotId, next);
    modeBtn.textContent = next === "loop" ? "Loop" : "Seq";
    modeBtn.classList.toggle("on", next === "sequence");
    // sync loop button visibility
    loopBtn.style.display = next === "loop" ? "" : "none";
  });

  // — Segment jump chips (whole-track)
  div.querySelectorAll(".seg-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      const s = meta.segments?.find(x => x.name === chip.dataset.segName);
      if (s) jumpToSegment(slotId, s, chip);
    });
  });

  // — Edit segments
  div.querySelector("[data-action=edit-segs]").addEventListener("click", () => {
    openTrackModal(meta);
  });

  // — Remove
  div.querySelector("[data-action=remove]").addEventListener("click", () => removeFromMixer(slotId));

  container.appendChild(div);
}

function renderMixerEmpty() {
  const empty = document.getElementById("mixer-empty");
  if (empty) empty.style.display = activeTracks.size === 0 ? "flex" : "none";
}

function jumpToSegment(slotId, seg, chip) {
  const node = activeTracks.get(slotId);
  if (!node) return;
  document.querySelectorAll(`#mtrack-${slotId} .seg-chip`).forEach(c => c.classList.remove("active"));
  chip.classList.add("active");
  node.audioEl.currentTime = seg.start;
  node._activeSegStart = seg.start;
  node._activeSegEnd   = seg.end;
}

// Master volume
document.getElementById("master-vol").addEventListener("input", e => {
  masterGain.gain.value = parseFloat(e.target.value);
});

// ---------------------------------------------------------------------------
// Sequential playback
// ---------------------------------------------------------------------------

function setPlayMode(slotId, mode) {
  const node = activeTracks.get(slotId);
  if (!node) return;
  node.playMode = mode;

  if (mode === "loop") {
    if (!node.segment) node.audioEl.loop = true;
    sequenceOrder = sequenceOrder.filter(id => id !== slotId);
  } else {
    node.audioEl.loop = false;
    if (!sequenceOrder.includes(slotId)) sequenceOrder.push(slotId);
  }
  updateSequenceBadges();
}

function advanceSequence(finishedSlotId) {
  const idx = sequenceOrder.indexOf(finishedSlotId);
  if (idx < 0) return;

  // Next in order, wrapping to start
  const nextId = sequenceOrder[(idx + 1) % sequenceOrder.length];
  if (!nextId || nextId === finishedSlotId) return;

  const from = activeTracks.get(finishedSlotId);
  const to   = activeTracks.get(nextId);
  if (!to) return;

  // Rewind the incoming track to its start
  to.audioEl.currentTime = to.segment ? to.segment.start : 0;
  to.audioEl.play().catch(() => {});

  crossfadeNodes(from, to, CROSSFADE_S);

  // Update play button state on incoming track
  const toEl = document.getElementById("mtrack-" + nextId);
  if (toEl) {
    const btn = toEl.querySelector(".play-btn");
    if (btn) { btn.dataset.playing = "true"; btn.textContent = "⏸"; btn.classList.remove("paused"); }
  }
}

// Exponential-out fade (sounds more natural than linear)
function crossfadeNodes(from, to, dur) {
  const now = audioCtx.currentTime;

  if (from) {
    const fromVol = from.gainNode.gain.value;
    from.gainNode.gain.cancelScheduledValues(now);
    from.gainNode.gain.setValueAtTime(fromVol, now);
    from.gainNode.gain.exponentialRampToValueAtTime(0.001, now + dur);
    // Silence after fade to avoid floating point click
    from.gainNode.gain.setValueAtTime(0, now + dur);
  }

  const toVol = to._targetVolume || 0.8;
  to.gainNode.gain.cancelScheduledValues(now);
  to.gainNode.gain.setValueAtTime(0.001, now);
  to.gainNode.gain.exponentialRampToValueAtTime(toVol, now + dur);
}

function updateSequenceBadges() {
  document.querySelectorAll(".seq-badge").forEach(el => el.remove());
  sequenceOrder.forEach((id, idx) => {
    const el = document.getElementById("mtrack-" + id);
    if (!el) return;
    const badge = document.createElement("span");
    badge.className = "seq-badge";
    badge.textContent = `#${idx + 1}`;
    el.querySelector(".title").insertAdjacentElement("afterend", badge);
  });
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

async function loadPresets() {
  presets = await api("GET", "/presets");
  const sel = document.getElementById("preset-select");
  sel.innerHTML = `<option value="">Load preset…</option>` +
    presets.map(p => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join("");
}

document.getElementById("preset-select").addEventListener("change", async e => {
  const name = e.target.value;
  if (!name) return;
  const preset = presets.find(p => p.name === name);
  if (!preset) return;

  // Clear current mixer
  [...activeTracks.keys()].forEach(removeFromMixer);

  for (const entry of preset.tracks) {
    const track = library.find(t => t.id === entry.track_id);
    if (!track) continue;

    // Restore segment if stored
    let segment = entry.segment || null;
    if (!segment && entry.active_segment) {
      segment = track.segments?.find(s => s.name === entry.active_segment) || null;
    }

    addToMixer(track, segment);
    const slotId = slotIdFor(track.id, segment?.name);
    const node = activeTracks.get(slotId);
    if (!node) continue;

    node.gainNode.gain.value = entry.volume ?? 0.8;
    node._targetVolume = entry.volume ?? 0.8;
    const volSlider = document.querySelector(`#mtrack-${slotId} .vol-slider`);
    if (volSlider) volSlider.value = entry.volume ?? 0.8;

    if (entry.play_mode === "sequence") {
      setPlayMode(slotId, "sequence");
      const modeBtn = document.querySelector(`#mtrack-${slotId} .mode-btn`);
      if (modeBtn) { modeBtn.textContent = "Seq"; modeBtn.classList.add("on"); }
    }
  }

  e.target.value = "";
  toast(`Loaded: ${name}`);
});

document.getElementById("save-preset-btn").addEventListener("click", async () => {
  if (activeTracks.size === 0) { toast("Nothing in mixer", true); return; }
  const name = prompt("Preset name:");
  if (!name?.trim()) return;
  const tracks = [];
  for (const [slotId, node] of activeTracks) {
    tracks.push({
      track_id: node.meta.id,
      segment: node.segment || null,
      volume: node._targetVolume || node.gainNode.gain.value,
      play_mode: node.playMode || "loop",
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
  const entries = Object.entries(activeJobs);
  container.innerHTML = "";

  if (!entries.length) { container.style.display = "none"; return; }
  container.style.display = "flex";

  for (const [id, job] of entries) {
    const item = document.createElement("div");
    item.className = `job-item job-${job.status}`;
    const icon = { queued: "⏳", running: "⬇", done: "✓", error: "✗" }[job.status] || "?";
    const label = job.track?.title || job.url;
    item.innerHTML = `
      <span class="job-icon">${icon}</span>
      <span class="job-label">${esc(label.length > 48 ? label.slice(0, 45) + "…" : label)}</span>
      ${(job.status === "done" || job.status === "error")
        ? `<button class="job-dismiss" data-jid="${id}">✕</button>` : ""}
    `;
    if (job.status === "running") {
      const spin = document.createElement("span");
      spin.className = "spinner";
      item.insertBefore(spin, item.querySelector(".job-label"));
      item.querySelector(".job-icon").remove();
    }
    container.appendChild(item);
  }

  container.querySelectorAll(".job-dismiss").forEach(btn => {
    btn.addEventListener("click", () => {
      delete activeJobs[btn.dataset.jid];
      renderJobQueue();
    });
  });
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    const pending = Object.values(activeJobs).filter(j => j.status === "queued" || j.status === "running");
    if (!pending.length) { clearInterval(pollTimer); pollTimer = null; return; }

    try {
      const jobs = await api("GET", "/jobs");
      let anyNew = false;
      for (const [id, job] of Object.entries(jobs)) {
        if (!activeJobs[id]) continue;
        const prev = activeJobs[id].status;
        activeJobs[id] = job;
        if (job.status === "done" && prev !== "done") {
          library.push(job.track);
          renderLibrary();
          toast(`Downloaded: ${job.track.title}`);
          anyNew = true;
        } else if (job.status === "error" && prev !== "error") {
          toast(`Download failed: ${job.url}`, true);
        }
      }
      renderJobQueue();
    } catch { /* network blip — try again next tick */ }
  }, 3000);
}

async function submitDownload(url) {
  try {
    const res = await api("POST", "/download", { url });
    activeJobs[res.job_id] = { status: "queued", url };
    renderJobQueue();
    startPolling();
    return true;
  } catch (err) {
    toast(err.message, true);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Add track modal
// ---------------------------------------------------------------------------

const addModal = document.getElementById("add-modal");

document.getElementById("add-track-btn").addEventListener("click", () => {
  addModal.classList.remove("hidden");
});
document.getElementById("add-modal-close").addEventListener("click", () => {
  addModal.classList.add("hidden");
});
addModal.addEventListener("click", e => {
  if (e.target === addModal) addModal.classList.add("hidden");
});

document.querySelectorAll(".modal-tab").forEach(btn => {
  btn.addEventListener("click", () => {
    const panel = btn.dataset.panel;
    document.querySelectorAll(".modal-tab").forEach(b => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".modal-panel").forEach(p => p.classList.toggle("active", p.id === panel));
    document.getElementById("download-btn").style.display =
      panel === "download-panel" ? "inline-flex" : "none";
  });
});

// Drop zone
const dropZone = document.getElementById("drop-zone");
const fileInput = document.getElementById("file-input");

dropZone.addEventListener("click", () => fileInput.click());
dropZone.addEventListener("dragover", e => { e.preventDefault(); dropZone.classList.add("over"); });
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("over"));
dropZone.addEventListener("drop", e => {
  e.preventDefault(); dropZone.classList.remove("over");
  if (e.dataTransfer.files.length) uploadFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener("change", () => {
  if (fileInput.files.length) uploadFile(fileInput.files[0]);
});

async function uploadFile(file) {
  const status = document.getElementById("upload-status");
  status.innerHTML = `<span class="spinner"></span> Uploading…`;
  const form = new FormData();
  form.append("file", file);
  try {
    const r = await fetch("/api/upload", { method: "POST", body: form });
    if (!r.ok) throw new Error((await r.json()).error);
    const track = await r.json();
    library.push(track);
    renderLibrary();
    status.textContent = `✓ ${track.title}`;
    toast("Track uploaded");
    fileInput.value = "";
  } catch (err) {
    status.textContent = "✗ " + err.message;
    toast(err.message, true);
  }
}

document.getElementById("download-btn").addEventListener("click", async () => {
  const input = document.getElementById("yt-url");
  const url = input.value.trim();
  if (!url) return;
  const ok = await submitDownload(url);
  if (ok) {
    input.value = "";
    document.getElementById("download-status").textContent = "Queued — track will appear in library when done.";
  }
});

// ---------------------------------------------------------------------------
// Track detail / edit modal
// ---------------------------------------------------------------------------

let editingTrack = null;

function openTrackModal(track) {
  editingTrack = { ...track, segments: [...(track.segments || [])] };
  document.getElementById("edit-title").value   = track.title || "";
  document.getElementById("edit-channel").value = track.source_channel || "";
  document.getElementById("edit-moods").value   = (track.mood_tags || []).join(", ");
  renderSegList(editingTrack.segments, track.duration_seconds);
  initDualRange(track.duration_seconds);
  document.getElementById("track-modal").classList.remove("hidden");
}

// Dual-range slider for segment selection
function initDualRange(duration) {
  const wrap     = document.getElementById("seg-timeline-wrap");
  const startR   = document.getElementById("dr-start");
  const endR     = document.getElementById("dr-end");
  const fill     = document.getElementById("dr-fill");
  const startLbl = document.getElementById("dr-start-label");
  const endLbl   = document.getElementById("dr-end-label");
  const startNum = document.getElementById("seg-start");
  const endNum   = document.getElementById("seg-end");
  const startFmt = document.getElementById("seg-start-fmt");
  const endFmt   = document.getElementById("seg-end-fmt");

  if (!duration) { wrap.style.display = "none"; return; }
  wrap.style.display = "block";

  startR.value = 0;
  endR.value   = 1000;
  startNum.value = 0;
  endNum.value   = Math.round(duration);
  startNum.max = endNum.max = Math.round(duration);

  function sliderToSecs(val) { return Math.round((val / 1000) * duration); }
  function secsToSlider(s)   { return Math.round((s / duration) * 1000); }

  function syncFromSlider() {
    let s = parseInt(startR.value);
    let e = parseInt(endR.value);
    // Enforce s < e with a minimum gap
    if (s >= e - 10) {
      if (document.activeElement === startR) { s = e - 10; startR.value = s; }
      else                                   { e = s + 10; endR.value = e; }
    }
    const sPct = s / 10; const ePct = e / 10;
    fill.style.left  = sPct + "%";
    fill.style.width = (ePct - sPct) + "%";
    const sSec = sliderToSecs(s); const eSec = sliderToSecs(e);
    startLbl.textContent = fmt(sSec); endLbl.textContent = fmt(eSec);
    startNum.value = sSec; endNum.value = eSec;
    startFmt.textContent = fmt(sSec); endFmt.textContent = fmt(eSec);
  }

  function syncFromNumbers() {
    let s = parseFloat(startNum.value) || 0;
    let e = parseFloat(endNum.value)   || duration;
    s = Math.max(0, Math.min(s, duration));
    e = Math.max(0, Math.min(e, duration));
    if (s >= e) e = Math.min(s + 1, duration);
    startR.value = secsToSlider(s); endR.value = secsToSlider(e);
    syncFromSlider();
  }

  startR.addEventListener("input", syncFromSlider);
  endR.addEventListener("input",   syncFromSlider);
  startNum.addEventListener("input", syncFromNumbers);
  endNum.addEventListener("input",   syncFromNumbers);
  syncFromSlider();
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
  const start = parseFloat(document.getElementById("seg-start").value);
  const end   = parseFloat(document.getElementById("seg-end").value);
  if (!name) { toast("Enter a segment name", true); return; }
  if (isNaN(start) || isNaN(end) || end <= start) { toast("Check start / end times", true); return; }
  editingTrack.segments = editingTrack.segments || [];
  editingTrack.segments.push({ name, start, end });
  renderSegList(editingTrack.segments, editingTrack.duration_seconds);
  document.getElementById("seg-name").value = "";
  document.getElementById("seg-start").value = "";
  document.getElementById("seg-end").value = "";
  // Reset slider
  const endR = document.getElementById("dr-end");
  document.getElementById("dr-start").value = 0;
  if (endR) endR.value = 1000;
  initDualRange(editingTrack.duration_seconds);
});

document.getElementById("track-modal-close").addEventListener("click", () => {
  document.getElementById("track-modal").classList.add("hidden");
});
document.getElementById("track-modal").addEventListener("click", e => {
  if (e.target === document.getElementById("track-modal"))
    document.getElementById("track-modal").classList.add("hidden");
});

document.getElementById("save-track-btn").addEventListener("click", async () => {
  if (!editingTrack) return;
  const payload = {
    title: document.getElementById("edit-title").value.trim(),
    source_channel: document.getElementById("edit-channel").value.trim(),
    mood_tags: document.getElementById("edit-moods").value
      .split(",").map(s => s.trim()).filter(Boolean),
    segments: editingTrack.segments || [],
  };
  try {
    const updated = await api("POST", `/tracks/${editingTrack.id}`, payload);
    const idx = library.findIndex(t => t.id === editingTrack.id);
    if (idx >= 0) library[idx] = updated;
    // Refresh mixer tracks for this track
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
    return [t?.title || row.track_id, row.play_count + " plays"];
  });
  renderStatsTable("top-mins-table", stats.top_by_minutes, row => {
    const t = library.find(l => l.id === row.track_id);
    return [t?.title || row.track_id, fmtMins(row.total_minutes)];
  });
  renderStatsTable("recent-table", stats.recently_played, row => {
    const t = library.find(l => l.id === row.track_id);
    return [t?.title || row.track_id, new Date(row.last_played).toLocaleDateString()];
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
  await loadLibrary();
  await loadPresets();
  renderMixerEmpty();
  switchView("mixer");
})();
