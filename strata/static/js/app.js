/* ── Strata — main app ──────────────────────────────────────────────────── */

// ---------------------------------------------------------------------------
// Audio engine
// ---------------------------------------------------------------------------

const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
const masterGain = audioCtx.createGain();
masterGain.connect(audioCtx.destination);

// activeTracks: Map<trackId, TrackNode>
// TrackNode = { meta, audioEl, sourceNode, gainNode, loop, segmentName, sessionStart }
const activeTracks = new Map();

function resumeCtx() {
  if (audioCtx.state === "suspended") audioCtx.resume();
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let library = [];       // full track list from API
let presets = [];       // preset list from API
let currentView = "mixer";
let libTab = "all";
let libSort = "date";

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function fmt(secs) {
  if (!secs) return "—";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
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

function toast(msg, isError = false) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = "show" + (isError ? " error" : "");
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.className = ""; }, 3000);
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

document.querySelectorAll("nav button[data-view]").forEach(btn => {
  btn.addEventListener("click", () => {
    currentView = btn.dataset.view;
    document.querySelectorAll("nav button[data-view]").forEach(b => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".view").forEach(v => v.classList.toggle("active", v.id === currentView + "-view"));
    if (currentView === "stats") loadStats();
  });
});

// ---------------------------------------------------------------------------
// Library load & render
// ---------------------------------------------------------------------------

async function loadLibrary() {
  library = await api("GET", "/tracks");
  renderLibrary();
  renderMixerSidebar();
}

function sortedTracks(tracks) {
  return [...tracks].sort((a, b) => {
    if (libSort === "title") return a.title.localeCompare(b.title);
    if (libSort === "plays") return (b._play_count || 0) - (a._play_count || 0);
    return new Date(b.date_added) - new Date(a.date_added);
  });
}

function filteredTracks() {
  if (libTab === "all") return library;
  if (libTab === "channel") {
    const groups = {};
    for (const t of library) {
      const ch = t.source_channel || "Unknown";
      (groups[ch] = groups[ch] || []).push(t);
    }
    return library; // channels rendered separately
  }
  // mood — return unique moods; actual filtering done in renderLibrary
  return library;
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
      const header = document.createElement("div");
      header.style.cssText = "grid-column:1/-1;font-weight:700;font-size:12px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.06em;padding:4px 0;";
      header.textContent = ch;
      grid.appendChild(header);
      tracks.forEach(t => grid.appendChild(makeCard(t)));
    }
  } else if (libTab === "mood") {
    const moodMap = {};
    for (const t of sorted) {
      const moods = t.mood_tags?.length ? t.mood_tags : ["Untagged"];
      for (const m of moods) {
        (moodMap[m] = moodMap[m] || []).push(t);
      }
    }
    for (const [mood, tracks] of Object.entries(moodMap).sort()) {
      const header = document.createElement("div");
      header.style.cssText = "grid-column:1/-1;font-weight:700;font-size:12px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.06em;padding:4px 0;";
      header.textContent = mood;
      grid.appendChild(header);
      tracks.forEach(t => grid.appendChild(makeCard(t)));
    }
  }
}

function makeCard(track) {
  const card = document.createElement("div");
  card.className = "track-card";
  card.dataset.id = track.id;

  const thumbUrl = track.thumbnail ? `/api/tracks/${track.id}/thumbnail` : null;

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
        ${track.source_url ? `<a href="${esc(track.source_url)}" target="_blank" rel="noopener" style="color:var(--text-dim);font-size:10px" onclick="event.stopPropagation()">↗ source</a>` : ""}
      </div>
    </div>
    <div class="card-actions">
      <button data-action="play" title="Add to mixer">▶ Mix</button>
      <button data-action="edit" title="Edit metadata">✎ Edit</button>
      <button data-action="delete" class="danger" title="Delete">✕</button>
    </div>
  `;

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
      removeFromMixer(track.id);
      await loadLibrary();
      toast("Track deleted");
    } catch (err) { toast(err.message, true); }
  });

  return card;
}

function esc(s) {
  if (!s) return "";
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

// ── Library tab buttons ──────────────────────────────────────────────────

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
// Mixer
// ---------------------------------------------------------------------------

function switchView(name) {
  currentView = name;
  document.querySelectorAll("nav button[data-view]").forEach(b => b.classList.toggle("active", b.dataset.view === name));
  document.querySelectorAll(".view").forEach(v => v.classList.toggle("active", v.id === name + "-view"));
  if (name === "stats") loadStats();
}

function addToMixer(track) {
  resumeCtx();
  if (activeTracks.has(track.id)) {
    toast("Already in mixer");
    return;
  }

  const audioEl = new Audio(`/api/tracks/${track.id}/audio`);
  audioEl.crossOrigin = "anonymous";
  const sourceNode = audioCtx.createMediaElementSource(audioEl);
  const gainNode = audioCtx.createGain();
  gainNode.gain.value = 0.8;
  sourceNode.connect(gainNode);
  gainNode.connect(masterGain);

  const node = { meta: track, audioEl, sourceNode, gainNode, loop: true, segmentName: null, sessionStart: isoNow() };
  audioEl.loop = true;
  audioEl.play().catch(() => {});
  activeTracks.set(track.id, node);

  renderMixerTrack(track.id);
  renderMixerEmpty();
}

function removeFromMixer(trackId) {
  const node = activeTracks.get(trackId);
  if (!node) return;

  // Record telemetry
  api("POST", "/telemetry/event", {
    track_id: trackId,
    started_at: node.sessionStart,
    ended_at: isoNow(),
    segment_name: node.segmentName,
    source: "mixer",
  }).catch(() => {});

  node.audioEl.pause();
  node.gainNode.disconnect();
  activeTracks.delete(trackId);
  const el = document.getElementById("mtrack-" + trackId);
  if (el) el.remove();
  renderMixerEmpty();
}

function renderMixerTrack(trackId) {
  const node = activeTracks.get(trackId);
  if (!node) return;
  const { meta } = node;

  const container = document.getElementById("mixer-tracks");
  const div = document.createElement("div");
  div.className = "mixer-track";
  div.id = "mtrack-" + trackId;

  const thumbUrl = meta.thumbnail ? `/api/tracks/${trackId}/thumbnail` : null;

  div.innerHTML = `
    ${thumbUrl
      ? `<img class="thumb" src="${thumbUrl}" alt="">`
      : `<div class="thumb-placeholder">♫</div>`}
    <div class="mixer-track-info">
      <div class="title">${esc(meta.title)}</div>
      ${meta.source_channel ? `<div class="channel">${esc(meta.source_channel)}</div>` : ""}
      <div class="mixer-track-row">
        <button class="play-btn" data-playing="true" title="Pause">⏸</button>
        <input type="range" min="0" max="1" step="0.01" value="0.8" title="Volume">
        <button class="toggle-btn on" data-loop="true" title="Loop">Loop</button>
        <button class="toggle-btn" data-action="segments" title="Segments">Segs</button>
        <button class="toggle-btn danger" data-action="remove" title="Remove" style="margin-left:auto">✕</button>
      </div>
      ${renderSegBar(meta)}
    </div>
  `;

  // Play/pause
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

  // Volume
  div.querySelector("input[type=range]").addEventListener("input", e => {
    node.gainNode.gain.value = parseFloat(e.target.value);
  });

  // Loop toggle
  const loopBtn = div.querySelector("[data-loop]");
  loopBtn.addEventListener("click", () => {
    node.loop = !node.loop;
    node.audioEl.loop = node.loop;
    loopBtn.dataset.loop = String(node.loop);
    loopBtn.classList.toggle("on", node.loop);
  });

  // Remove
  div.querySelector("[data-action=remove]").addEventListener("click", () => {
    removeFromMixer(trackId);
  });

  // Segments button
  div.querySelector("[data-action=segments]").addEventListener("click", () => {
    openTrackModal(meta);
  });

  // Segment bar clicks
  div.querySelectorAll(".seg-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      const seg = meta.segments.find(s => s.name === chip.dataset.name);
      if (!seg) return;
      jumpToSegment(trackId, seg, chip);
    });
  });

  container.appendChild(div);
}

function renderSegBar(meta) {
  const segs = meta.segments || [];
  if (!segs.length || !meta.duration_seconds) return "";
  const dur = meta.duration_seconds;
  const chips = segs.map(s => {
    const left = (s.start / dur * 100).toFixed(2);
    const width = ((s.end - s.start) / dur * 100).toFixed(2);
    return `<div class="seg-chip" data-name="${esc(s.name)}" style="left:${left}%;width:${width}%" title="${esc(s.name)}">${esc(s.name)}</div>`;
  }).join("");
  return `<div class="segment-bar">${chips}</div>`;
}

function jumpToSegment(trackId, seg, chip) {
  const node = activeTracks.get(trackId);
  if (!node) return;

  // Deactivate all chips for this track
  document.querySelectorAll(`#mtrack-${trackId} .seg-chip`).forEach(c => c.classList.remove("active"));
  chip.classList.add("active");

  node.segmentName = seg.name;
  node.audioEl.currentTime = seg.start;

  // Loop only the segment
  node.audioEl.loop = false;
  const onTimeUpdate = () => {
    if (node.audioEl.currentTime >= seg.end) {
      node.audioEl.currentTime = seg.start;
    }
  };
  node.audioEl.removeEventListener("timeupdate", node._segListener);
  node.audioEl.addEventListener("timeupdate", onTimeUpdate);
  node._segListener = onTimeUpdate;
}

function renderMixerEmpty() {
  const empty = document.getElementById("mixer-empty");
  if (empty) empty.style.display = activeTracks.size === 0 ? "flex" : "none";
}

function renderMixerSidebar() {
  // Nothing extra — tracks are rendered on demand
}

// Master volume
document.getElementById("master-vol").addEventListener("input", e => {
  masterGain.gain.value = parseFloat(e.target.value);
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

document.getElementById("preset-select").addEventListener("change", async e => {
  const name = e.target.value;
  if (!name) return;
  const preset = presets.find(p => p.name === name);
  if (!preset) return;

  // Clear current mixer
  [...activeTracks.keys()].forEach(id => removeFromMixer(id));

  for (const entry of preset.tracks) {
    const track = library.find(t => t.id === entry.track_id);
    if (!track) continue;
    addToMixer(track);
    const node = activeTracks.get(track.id);
    if (!node) continue;
    node.gainNode.gain.value = entry.volume ?? 0.8;
    node.audioEl.loop = entry.loop ?? true;
    // update vol slider
    const slider = document.querySelector(`#mtrack-${track.id} input[type=range]`);
    if (slider) slider.value = entry.volume ?? 0.8;
    // jump to segment
    if (entry.active_segment && track.segments) {
      const seg = track.segments.find(s => s.name === entry.active_segment);
      if (seg) {
        const chip = document.querySelector(`#mtrack-${track.id} .seg-chip[data-name="${entry.active_segment}"]`);
        if (chip) jumpToSegment(track.id, seg, chip);
      }
    }
  }

  e.target.value = "";
  toast(`Loaded preset: ${name}`);
});

document.getElementById("save-preset-btn").addEventListener("click", async () => {
  if (activeTracks.size === 0) { toast("Nothing in mixer", true); return; }
  const name = prompt("Preset name:");
  if (!name?.trim()) return;
  const tracks = [];
  for (const [id, node] of activeTracks) {
    tracks.push({
      track_id: id,
      volume: node.gainNode.gain.value,
      loop: node.loop,
      active_segment: node.segmentName || null,
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
    toast(`Preset "${name}" deleted`);
  } catch (err) { toast(err.message, true); }
});

// ---------------------------------------------------------------------------
// Add track modal
// ---------------------------------------------------------------------------

const addModal    = document.getElementById("add-modal");
const trackModal  = document.getElementById("track-modal");

document.getElementById("add-track-btn").addEventListener("click", () => {
  addModal.classList.remove("hidden");
});

document.getElementById("add-modal-close").addEventListener("click", () => {
  addModal.classList.add("hidden");
});
addModal.addEventListener("click", e => {
  if (e.target === addModal) addModal.classList.add("hidden");
});

// Modal tabs
document.querySelectorAll(".modal-tab").forEach(btn => {
  btn.addEventListener("click", () => {
    const panel = btn.dataset.panel;
    document.querySelectorAll(".modal-tab").forEach(b => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".modal-panel").forEach(p => p.classList.toggle("active", p.id === panel));
  });
});

// Drop zone
const dropZone = document.getElementById("drop-zone");
const fileInput = document.getElementById("file-input");

dropZone.addEventListener("click", () => fileInput.click());
dropZone.addEventListener("dragover", e => { e.preventDefault(); dropZone.classList.add("over"); });
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("over"));
dropZone.addEventListener("drop", e => {
  e.preventDefault();
  dropZone.classList.remove("over");
  const files = e.dataTransfer.files;
  if (files.length) uploadFile(files[0]);
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
    status.textContent = "✓ Uploaded: " + track.title;
    toast("Track uploaded");
    fileInput.value = "";
  } catch (err) {
    status.textContent = "✗ " + err.message;
    toast(err.message, true);
  }
}

// YouTube / URL download
document.getElementById("download-btn").addEventListener("click", async () => {
  const url = document.getElementById("yt-url").value.trim();
  if (!url) return;
  const status = document.getElementById("download-status");
  status.innerHTML = `<span class="spinner"></span> Downloading… (this may take a minute)`;
  try {
    const track = await api("POST", "/download", { url });
    library.push(track);
    renderLibrary();
    status.textContent = "✓ Downloaded: " + track.title;
    document.getElementById("yt-url").value = "";
    toast("Download complete");
  } catch (err) {
    status.textContent = "✗ " + err.message;
    toast(err.message, true);
  }
});

// ---------------------------------------------------------------------------
// Track detail / edit modal
// ---------------------------------------------------------------------------

let editingTrack = null;

function openTrackModal(track) {
  editingTrack = { ...track };
  const modal = document.getElementById("track-modal");
  document.getElementById("edit-title").value = track.title || "";
  document.getElementById("edit-channel").value = track.source_channel || "";
  document.getElementById("edit-moods").value = (track.mood_tags || []).join(", ");
  renderSegList(track.segments || [], track.duration_seconds || 0);
  modal.classList.remove("hidden");
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
  if (!name || isNaN(start) || isNaN(end) || end <= start) {
    toast("Check segment fields", true);
    return;
  }
  editingTrack.segments = editingTrack.segments || [];
  editingTrack.segments.push({ name, start, end });
  renderSegList(editingTrack.segments, editingTrack.duration_seconds || 0);
  document.getElementById("seg-name").value = "";
  document.getElementById("seg-start").value = "";
  document.getElementById("seg-end").value = "";
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
    mood_tags: document.getElementById("edit-moods").value.split(",").map(s => s.trim()).filter(Boolean),
    segments: editingTrack.segments || [],
  };
  try {
    const updated = await api("POST", `/tracks/${editingTrack.id}`, payload);
    const idx = library.findIndex(t => t.id === editingTrack.id);
    if (idx >= 0) library[idx] = updated;
    // Also update active mixer track meta
    if (activeTracks.has(updated.id)) {
      activeTracks.get(updated.id).meta = updated;
      const el = document.getElementById("mtrack-" + updated.id);
      if (el) { el.remove(); renderMixerTrack(updated.id); }
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
  // Total listening
  document.getElementById("stat-all").textContent  = fmtMins(stats.total_minutes.all_time);
  document.getElementById("stat-7d").textContent   = fmtMins(stats.total_minutes.last_7d);
  document.getElementById("stat-30d").textContent  = fmtMins(stats.total_minutes.last_30d);

  // Top by count
  renderStatsTable("top-count-table", stats.top_by_count, row => {
    const t = library.find(l => l.id === row.track_id);
    return [t?.title || row.track_id, row.play_count + " plays"];
  });

  // Top by minutes
  renderStatsTable("top-mins-table", stats.top_by_minutes, row => {
    const t = library.find(l => l.id === row.track_id);
    return [t?.title || row.track_id, fmtMins(row.total_minutes)];
  });

  // Recent
  renderStatsTable("recent-table", stats.recently_played, row => {
    const t = library.find(l => l.id === row.track_id);
    const d = new Date(row.last_played);
    return [t?.title || row.track_id, d.toLocaleDateString()];
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
    const [col1, col2] = mapper(row);
    const tr = document.createElement("tr");
    tr.innerHTML = `<td style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(col1)}</td><td>${esc(String(col2))}</td>`;
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
