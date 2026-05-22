/* ── Strata — main app ──────────────────────────────────────────────────── */

// ---------------------------------------------------------------------------
// Audio engine
// ---------------------------------------------------------------------------

// Audio is routed through HTMLAudioElement directly (no Web Audio graph) so that
// iOS continues playback in background — createMediaElementSource ties audio to
// the AudioContext which iOS suspends when the browser is backgrounded.
let masterVolume = 1.0;

function effectiveVol(node) {
  return Math.min(1, node._targetVolume * (node.zone === "queue" ? queueMasterVolume : 1) * masterVolume);
}


function setupMediaSession() {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.setActionHandler("play",  () => { if ( globalPaused) toggleGlobalPlayback(); });
  navigator.mediaSession.setActionHandler("pause", () => { if (!globalPaused) toggleGlobalPlayback(); });
  navigator.mediaSession.setActionHandler("stop",  () => { if (!globalPaused) toggleGlobalPlayback(); });
}

function syncMediaSession() {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.playbackState = globalPaused ? "paused" : "playing";
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

// Tracks currently being repair-downloaded (from sanity check)
const _repairingTracks     = new Set();
// Tracks flagged by deep-check
const _corruptNoSource     = new Set();
const _qualityOutdated     = new Set();

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
let libSearch = "";

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
  if (name === "stats")     loadStats();
  if (name === "settings")  loadSettingsView();
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
  if (libSearch) filterLibrary(libSearch);
}

function makeGroupHeader(label) {
  const h = document.createElement("div");
  h.className = "group-header";
  h.textContent = label;
  return h;
}

function setCardSegOpen(card, open) {
  const subRow    = card.querySelector(".seg-sub-row");
  const toggleBtn = card.querySelector(".seg-toggle-btn");
  if (!subRow) return;
  const track = library.find(t => t.id === card.dataset.id);
  if (!track) return;
  subRow.style.display = open ? "flex" : "none";
  if (toggleBtn) toggleBtn.textContent = `${track.segments.length} segment${track.segments.length > 1 ? "s" : ""} ${open ? "▴" : "▾"}`;
}

function makeCard(track) {
  const isRepairing  = _repairingTracks.has(track.id);
  const isMissing    = track.has_audio === false && !isRepairing;
  const isCorrupt    = _corruptNoSource.has(track.id);
  const isOutdated   = _qualityOutdated.has(track.id) || track.quality_outdated;
  const card = document.createElement("div");
  let cardClass = "track-card";
  if (isMissing || isCorrupt) cardClass += " track-missing";
  else if (isRepairing)       cardClass += " track-repairing";
  else if (isOutdated)        cardClass += " track-outdated";
  card.className = cardClass;
  card.dataset.id = track.id;

  const thumbUrl = (track.thumbnail || track.has_custom_thumbnail)
    ? `/api/tracks/${track.id}/thumbnail${track._thumbV ? `?v=${track._thumbV}` : ""}` : null;
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
    ${isRepairing ? `<div class="missing-badge repairing-badge">⬇ Redownloading…</div>`
      : isCorrupt  ? `<div class="missing-badge">✗ Corrupt</div>`
      : isMissing  ? `<div class="missing-badge">⚠ Audio missing</div>`
      : isOutdated ? `<div class="missing-badge outdated-badge">↑ Quality outdated</div>`
      : ""}
    <div class="card-actions">
      <button data-action="bed"   title="Add to Beds — loops continuously" ${(isMissing || isRepairing || isCorrupt) ? "disabled" : ""}>${ICON_BED} Bed</button>
      <button data-action="queue" title="Add to Queue — plays in sequence" ${(isMissing || isRepairing || isCorrupt) ? "disabled" : ""}>${ICON_QUEUE} Queue</button>
      <button data-action="edit"  title="Edit metadata">✎</button>
      <button data-action="delete" class="danger card-delete" title="Delete track">🗑</button>
    </div>
  `;

  // Segment sub-row toggle — expands all cards in the same visual grid row
  const toggleBtn = card.querySelector(".seg-toggle-btn");
  const subRow    = card.querySelector(".seg-sub-row");
  if (toggleBtn && subRow) {
    toggleBtn.addEventListener("click", e => {
      e.stopPropagation();
      const newOpen = subRow.style.display === "none";
      const thisTop = card.getBoundingClientRect().top;
      document.querySelectorAll("#library-grid .track-card").forEach(c => {
        if (Math.abs(c.getBoundingClientRect().top - thisTop) < 5) {
          setCardSegOpen(c, newOpen);
        }
      });
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
// Library search
// ---------------------------------------------------------------------------

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightText(el, re) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let n;
  while ((n = walker.nextNode())) nodes.push(n);
  for (const textNode of nodes) {
    re.lastIndex = 0;
    if (!re.test(textNode.nodeValue)) continue;
    re.lastIndex = 0;
    const text = textNode.nodeValue;
    const frag = document.createDocumentFragment();
    let last = 0, m;
    while ((m = re.exec(text)) !== null) {
      frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const mark = document.createElement("span");
      mark.className = "search-hl";
      mark.textContent = m[0];
      frag.appendChild(mark);
      last = m.index + m[0].length;
    }
    frag.appendChild(document.createTextNode(text.slice(last)));
    textNode.parentNode.replaceChild(frag, textNode);
  }
}

function clearHighlights(grid) {
  grid.querySelectorAll(".search-hl").forEach(mark => {
    mark.parentNode.replaceChild(document.createTextNode(mark.textContent), mark);
  });
  grid.querySelectorAll(".card-title, .card-channel, .seg-extract-name").forEach(el => el.normalize());
}

function filterLibrary(keyword) {
  const grid = document.getElementById("library-grid");
  clearHighlights(grid);

  const kw = keyword.trim().toLowerCase();
  if (!kw) {
    grid.querySelectorAll(".track-card[data-search-expanded]").forEach(card => {
      setCardSegOpen(card, false);
      delete card.dataset.searchExpanded;
    });
    grid.querySelectorAll(".track-card, .group-header").forEach(el => el.style.display = "");
    return;
  }

  const re = new RegExp(escapeRegex(kw), "gi");

  grid.querySelectorAll(".track-card").forEach(card => {
    const track = library.find(t => t.id === card.dataset.id);
    if (!track) { card.style.display = "none"; return; }

    const titleMatch = displayName(track).toLowerCase().includes(kw);
    const segMatches = (track.segments || []).filter(s => s.name.toLowerCase().includes(kw));

    if (!titleMatch && segMatches.length === 0) {
      card.style.display = "none";
      return;
    }

    card.style.display = "";

    // Highlight title and channel
    const titleEl = card.querySelector(".card-title");
    if (titleEl) highlightText(titleEl, re);
    const channelEl = card.querySelector(".card-channel");
    if (channelEl) highlightText(channelEl, re);

    // Segment handling
    if (segMatches.length > 0) {
      const subRow   = card.querySelector(".seg-sub-row");
      const toggleBtn = card.querySelector(".seg-toggle-btn");
      // Auto-expand
      if (subRow && subRow.style.display === "none") {
        setCardSegOpen(card, true);
        card.dataset.searchExpanded = "1";
      }
      // Highlight matching segment names and scroll sub-row to first match
      let firstMatchItem = null;
      card.querySelectorAll(".seg-extract-item").forEach(item => {
        const nameEl = item.querySelector(".seg-extract-name");
        if (!nameEl) return;
        if (nameEl.textContent.toLowerCase().includes(kw)) {
          highlightText(nameEl, re);
          if (!firstMatchItem) firstMatchItem = item;
        }
      });
      if (firstMatchItem && subRow) {
        requestAnimationFrame(() => {
          const rowTop  = subRow.getBoundingClientRect().top;
          const itemTop = firstMatchItem.getBoundingClientRect().top;
          subRow.scrollBy({ top: itemTop - rowTop, behavior: "smooth" });
        });
      }
    }
  });

  // Hide group headers whose cards are all hidden
  grid.querySelectorAll(".group-header").forEach(header => {
    let next = header.nextElementSibling;
    let hasVisible = false;
    while (next && !next.classList.contains("group-header")) {
      if (next.style.display !== "none") { hasVisible = true; break; }
      next = next.nextElementSibling;
    }
    header.style.display = hasVisible ? "" : "none";
  });

}

let _searchDebounce = null;
document.getElementById("lib-search").addEventListener("input", e => {
  clearTimeout(_searchDebounce);
  libSearch = e.target.value;
  _searchDebounce = setTimeout(() => filterLibrary(libSearch), 150);
});

// ---------------------------------------------------------------------------
// Mixer — add / remove
// ---------------------------------------------------------------------------

function addToMixer(track, segment = null, zone = "bed") {
  // Beds deduplicate (same track can't loop twice); queue allows repeats
  const baseSlotId = slotIdFor(track.id, segment?.name);
  const slotId     = zone === "queue" ? `${baseSlotId}-q${++_queueSlotSeq}` : baseSlotId;
  if (zone === "bed" && activeTracks.has(slotId)) { toast("Already in beds"); return; }

  const audioEl = new Audio(`/api/tracks/${track.id}/audio`);
  audioEl.volume = Math.min(1, (zone === "queue" ? 0.8 * queueMasterVolume : 0.8) * masterVolume);

  const node = {
    meta: track, segment, zone,
    audioEl,
    _targetVolume: 0.8,
    sessionStart: isoNow(),
    _timeUpdateHandler: null,
  };

  // Helper: seek to a position reliably (waits for metadata + seeked event)
  const seekTo = (time, cb) => {
    const go = () => {
      if (time > 0) {
        audioEl.currentTime = time;
        audioEl.addEventListener("seeked", () => {
          // Wait until data at the target position is actually buffered
          if (audioEl.readyState >= 3) { cb(); return; }
          audioEl.addEventListener("canplay", cb, { once: true });
        }, { once: true });
      } else {
        audioEl.currentTime = 0;
        cb();
      }
    };
    if (audioEl.readyState >= 1) go();
    else audioEl.addEventListener("loadedmetadata", go, { once: true });
  };

  if (zone === "bed") {
    audioEl.loop = !segment;
    const wasEmpty = activeTracks.size === 0 && sequenceOrder.length === 0;
    const startBed = () => {
      if (!globalPaused || wasEmpty) {
        audioEl.play().then(() => {
          globalPaused = false;
          syncMediaSession();
          updateTransportLabel();
          const pb = document.querySelector(`#mtrack-${CSS.escape(slotId)} .play-btn`);
          if (pb) { pb.textContent = "⏸"; pb.dataset.playing = "true"; pb.classList.remove("paused"); }
        }).catch(() => {});
      }
    };
    seekTo(segment?.start || 0, startBed);
  } else {
    // Queue: play immediately only if first item; otherwise just position it
    audioEl.loop = false;
    const isFirst = sequenceOrder.length === 0;
    sequenceOrder.push(slotId);
    if (isFirst && (!globalPaused || activeTracks.size === 0)) {
      currentQueueIdx = 0;
      const startQueue = () => {
        audioEl.play().then(() => {
          globalPaused = false;
          syncMediaSession();
          updateTransportLabel();
        }).catch(() => {});
      };
      seekTo(segment?.start || 0, startQueue);
    } else {
      seekTo(segment?.start || 0, () => {});
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

  const seg = node.segment;
  if (seg) {
    const elapsed = node.audioEl.currentTime - seg.start;
    const segDur  = seg.end - seg.start;
    slider.value  = Math.max(0, Math.min(1000, (elapsed / segDur) * 1000));
  } else {
    slider.value = (node.audioEl.currentTime / node.audioEl.duration) * 1000;
  }
  if (timeEl) {
    const cur   = seg ? Math.max(0, node.audioEl.currentTime - seg.start) : node.audioEl.currentTime;
    const total = seg ? seg.end - seg.start : node.audioEl.duration;
    timeEl.textContent = `${fmt(cur)} / ${fmt(total)}`;
  }

  // Live segment chip highlight + current-segment label for whole-track beds
  if (node.zone === "bed" && !node.segment && node.meta.segments?.length) {
    const t = node.audioEl.currentTime;
    const activeSeg = node.meta.segments.find(s => t >= s.start && t < s.end);
    document.querySelectorAll(`#mtrack-${slotId} .seg-chip`).forEach(chip =>
      chip.classList.toggle("active", chip.dataset.segName === (activeSeg?.name ?? "")));
    const curLabel = el.querySelector(".seg-current-label");
    if (curLabel) curLabel.textContent = activeSeg ? `(${activeSeg.name})` : "";
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

  const thumbUrl = (meta.thumbnail || meta.has_custom_thumbnail)
    ? `/api/tracks/${meta.id}/thumbnail${meta._thumbV ? `?v=${meta._thumbV}` : ""}` : null;

  div.innerHTML = `
    ${zone === "queue" ? `<div class="drag-handle" title="Drag to reorder">⠿</div>` : ""}
    ${thumbUrl
      ? `<img class="thumb" src="${thumbUrl}" alt="">`
      : `<div class="thumb-placeholder">♫</div>`}
    <div class="mixer-track-info">
      <div class="slot-origin">
        ${segment ? `<span class="seg-label">◈ ${esc(segment.name)} – </span>` : ""}${esc(displayName(meta))}${!segment && meta.segments?.length ? ` <span class="seg-label seg-current-label"></span>` : ""}
      </div>
      ${meta.source_channel ? `<div class="slot-channel">${esc(meta.source_channel)}</div>` : ""}
      <div class="mixer-seek-row">
        <span class="time-display">0:00 / ${fmt(segment ? segment.end - segment.start : meta.duration_seconds)}</span>
        <input type="range" class="seek-slider" min="0" max="1000" value="0">
      </div>
      <div class="mixer-track-row">
        <button class="play-btn${globalPaused ? " paused" : ""}" data-playing="${!globalPaused}" title="Play / Pause">${globalPaused ? "▶" : "⏸"}</button>
        <input type="range" class="vol-slider" min="0" max="1" step="0.01" value="0.8" title="Volume">
        ${zone === "bed"
          ? `<button class="toggle-btn on" data-loop="true" title="Loop">🔁</button>
             ${meta.segments?.length > 1
               ? `<button class="toggle-btn" data-action="seg-prev" title="Previous segment">‹</button>
                  <button class="toggle-btn" data-action="seg-next" title="Next segment">›</button>`
               : ''}`
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

    const preview = document.createElement("div");
    preview.className = "seg-preview";
    preview.setAttribute("aria-hidden", "true");
    const previewName = document.createElement("span");
    previewName.className = "seg-preview-name";
    const previewTime = document.createElement("span");
    previewTime.className = "seg-preview-time";
    preview.append(previewName, previewTime);
    bar.appendChild(preview);

    meta.segments.forEach(s => {
      const left  = (s.start / meta.duration_seconds * 100).toFixed(2);
      const width = ((s.end - s.start) / meta.duration_seconds * 100).toFixed(2);
      const chip  = document.createElement("div");
      chip.className = "seg-chip";
      chip.style.cssText = `left:${left}%;width:${width}%`;
      chip.title = s.name;
      chip.dataset.segName = s.name;
      chip.addEventListener("click", () => jumpToSegment(slotId, s, chip));
      chip.addEventListener("mouseenter", () => {
        previewName.textContent = s.name;
        previewTime.textContent = `${fmt(s.start)} – ${fmt(s.end)}`;
        preview.classList.add("visible");
      });
      chip.addEventListener("mouseleave", () => preview.classList.remove("visible"));
      bar.appendChild(chip);
    });
    div.querySelector(".mixer-track-info").appendChild(bar);
  }

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
      node.audioEl.play().catch(() => {});
      playBtn.dataset.playing = "true"; playBtn.textContent = "⏸"; playBtn.classList.remove("paused");
      if (globalPaused) { globalPaused = false; syncMediaSession(); updateTransportLabel(); }
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
    const pct = parseFloat(seekSlider.value) / 1000;
    const seg = node.segment;
    node.audioEl.currentTime = seg
      ? seg.start + pct * (seg.end - seg.start)
      : pct * node.audioEl.duration;
  });

  // — Volume
  const volSlider = div.querySelector(".vol-slider");
  volSlider.addEventListener("input", () => {
    node._targetVolume = parseFloat(volSlider.value);
    node.audioEl.volume = effectiveVol(node);
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

  // — Segment prev/next (bed with multiple segments)
  if (zone === "bed" && meta.segments?.length > 1) {
    const segs = meta.segments;
    const findSegIdx = () => {
      const t = node.audioEl.currentTime;
      let idx = segs.findIndex(s => t >= s.start && t < s.end);
      if (idx < 0) idx = t >= segs[segs.length - 1].end ? segs.length - 1 : 0;
      return idx;
    };
    const activateChip = seg => {
      document.querySelectorAll(`#mtrack-${slotId} .seg-chip`).forEach(c =>
        c.classList.toggle("active", c.dataset.segName === seg.name));
    };
    div.querySelector("[data-action=seg-prev]")?.addEventListener("click", () => {
      const idx = findSegIdx();
      const seg = segs[idx > 0 ? idx - 1 : segs.length - 1];
      node.audioEl.currentTime = seg.start;
      activateChip(seg);
    });
    div.querySelector("[data-action=seg-next]")?.addEventListener("click", () => {
      const idx = findSegIdx();
      const seg = segs[idx < segs.length - 1 ? idx + 1 : 0];
      node.audioEl.currentTime = seg.start;
      activateChip(seg);
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
  const target = node.segment?.start || 0;
  const doPlay = () => node.audioEl.play().catch(() => {});
  if (target > 0 && node.audioEl.readyState >= 1) {
    node.audioEl.currentTime = target;
    node.audioEl.addEventListener("seeked", doPlay, { once: true });
  } else {
    node.audioEl.currentTime = target;
    doPlay();
  }
  updateQueueHighlight();
}

function jumpToQueueItem(idx) {
  const from   = activeTracks.get(sequenceOrder[currentQueueIdx]);
  const to     = activeTracks.get(sequenceOrder[idx]);
  if (!to) return;
  const target = to.segment?.start || 0;
  const doJump = () => {
    to.audioEl.play().catch(() => {});
    if (from && from !== to) crossfadeNodes(from, to, CROSSFADE_S);
    currentQueueIdx = idx;
    updateQueueHighlight();
  };
  if (target > 0 && to.audioEl.readyState >= 1) {
    to.audioEl.currentTime = target;
    to.audioEl.addEventListener("seeked", doJump, { once: true });
  } else {
    to.audioEl.currentTime = target;
    doJump();
  }
}

const PREV_RESTART_THRESHOLD = 3; // seconds — restart current track instead of going back

function skipQueuePrev() {
  if (currentQueueIdx < 0 || sequenceOrder.length === 0) return;
  const node = activeTracks.get(sequenceOrder[currentQueueIdx]);
  const startTime = node?.segment?.start || 0;
  if (node && node.audioEl.currentTime - startTime > PREV_RESTART_THRESHOLD) {
    node.audioEl.currentTime = startTime;
    return;
  }
  let prevIdx = currentQueueIdx - 1;
  if (prevIdx < 0) {
    if (!queueLooping) return;
    prevIdx = sequenceOrder.length - 1;
  }
  jumpToQueueItem(prevIdx);
}

function skipQueueNext() {
  if (currentQueueIdx < 0 || sequenceOrder.length === 0) return;
  let nextIdx = currentQueueIdx + 1;
  if (nextIdx >= sequenceOrder.length) {
    if (!queueLooping) return;
    nextIdx = 0;
  }
  jumpToQueueItem(nextIdx);
}

function updateTransportNav() {
  const prevBtn = document.getElementById("transport-prev");
  const nextBtn = document.getElementById("transport-next");
  if (!prevBtn || !nextBtn) return;
  const hasQueue = sequenceOrder.length > 0;
  prevBtn.disabled = !hasQueue || (currentQueueIdx <= 0 && !queueLooping);
  nextBtn.disabled = !hasQueue || (currentQueueIdx >= sequenceOrder.length - 1 && !queueLooping);
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

  const toTarget = to.segment?.start || 0;
  const doAdvance = () => {
    to.audioEl.play().catch(() => {});
    crossfadeNodes(from, to, CROSSFADE_S);
    currentQueueIdx = nextIdx;
    updateQueueHighlight();
  };
  if (toTarget > 0 && to.audioEl.readyState >= 1) {
    to.audioEl.currentTime = toTarget;
    to.audioEl.addEventListener("seeked", doAdvance, { once: true });
  } else {
    to.audioEl.currentTime = toTarget;
    doAdvance();
  }
}

function crossfadeNodes(from, to, dur) {
  const steps      = Math.max(10, Math.ceil(dur * 20));
  const stepMs     = (dur * 1000) / steps;
  const fromStart  = from ? from.audioEl.volume : 0;
  const toTarget   = effectiveVol(to);
  let step = 0;
  const timer = setInterval(() => {
    step++;
    const t = step / steps;
    if (from) from.audioEl.volume = Math.max(0, fromStart * (1 - t));
    to.audioEl.volume = Math.min(toTarget, toTarget * t);
    if (step >= steps) {
      clearInterval(timer);
      if (from) { from.audioEl.volume = 0; from.audioEl.pause(); }
      to.audioEl.volume = toTarget;
    }
  }, stepMs);
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
  updateTransportNav();
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
    if (node.zone === "queue") node.audioEl.volume = effectiveVol(node);
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
  if (btn) btn.textContent = (globalPaused || activeTracks.size === 0) ? "▶" : "⏸";
  updateTransportNav();
}

function toggleGlobalPlayback() {
  if (activeTracks.size === 0) return;
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
  syncMediaSession();
}

document.getElementById("transport-play").addEventListener("click", toggleGlobalPlayback);
document.getElementById("transport-prev").addEventListener("click", skipQueuePrev);
document.getElementById("transport-next").addEventListener("click", skipQueueNext);

document.getElementById("master-vol").addEventListener("input", e => {
  masterVolume = parseFloat(e.target.value);
  for (const [, node] of activeTracks) node.audioEl.volume = effectiveVol(node);
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
    node.audioEl.volume = effectiveVol(node);
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
      volume:   node._targetVolume,
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

let editingTrack   = null;
let editingSegIdx  = -1;

function openTrackModal(track) {
  editingTrack = { ...track, segments: [...(track.segments || [])] };
  document.getElementById("edit-custom-label").value = track.custom_label || "";
  document.getElementById("edit-title").value         = track.title || "";
  document.getElementById("edit-channel").value       = track.source_channel || "";
  document.getElementById("edit-moods").value         = (track.mood_tags || []).map(t => t.toLowerCase()).join(", ");
  syncOriginalsDim();
  const lbl = document.getElementById("edit-custom-label");
  lbl.oninput = syncOriginalsDim;
  editingSegIdx = -1;
  initThumbEdit(track);
  initAudioReupload(track);
  initRefetchBtn(track);
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
    before = before.replace(numRe, "").trim().replace(/[-–·•\s\[\]()]+$/, "").trim();
    after  = after.replace(/^[-–·•\s\[\]()]+/, "").replace(numRe, "").trim().replace(/[-–·•\s\[\]()]+$/, "").trim();

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
    item.className = "seg-item" + (i === editingSegIdx ? " seg-editing" : "");
    item.title = "Click to edit";
    item.innerHTML = `
      <span class="seg-name">${esc(seg.name)}</span>
      <span class="seg-times">${fmt(seg.start)} – ${fmt(seg.end)}</span>
      <button class="btn secondary" style="padding:3px 8px;font-size:11px" data-del="${i}" title="Delete">✕</button>
    `;
    item.addEventListener("click", e => {
      if (e.target.closest("[data-del]")) return;
      loadSegForEdit(seg, i);
    });
    item.querySelector("[data-del]").addEventListener("click", e => {
      e.stopPropagation();
      if (editingSegIdx === i) resetSegForm();
      else if (editingSegIdx > i) editingSegIdx--;
      editingTrack.segments.splice(i, 1);
      renderSegList(editingTrack.segments, duration);
    });
    list.appendChild(item);
  });
}

function loadSegForEdit(seg, idx) {
  if (editingSegIdx === idx) { resetSegForm(); return; }  // toggle off
  editingSegIdx = idx;
  document.getElementById("seg-name").value = seg.name;
  const startEl = document.getElementById("seg-start");
  const endEl   = document.getElementById("seg-end");
  startEl.value = seg.start > 0 ? fmt(seg.start) : "0:00";
  endEl.value   = fmt(seg.end);
  startEl.dispatchEvent(new Event("blur"));  // syncs dual-range slider
  endEl.dispatchEvent(new Event("blur"));
  document.getElementById("add-seg-btn").textContent = "✎ Update";
  document.getElementById("seg-name").focus();
  renderSegList(editingTrack.segments, editingTrack.duration_seconds);
}

function resetSegForm() {
  editingSegIdx = -1;
  document.getElementById("seg-name").value = "";
  const startEl = document.getElementById("seg-start");
  const endEl   = document.getElementById("seg-end");
  startEl.value = "0:00";
  endEl.value   = editingTrack?.duration_seconds ? fmt(Math.round(editingTrack.duration_seconds)) : "";
  startEl.dispatchEvent(new Event("blur"));
  endEl.dispatchEvent(new Event("blur"));
  document.getElementById("add-seg-btn").textContent = "＋ Add";
}

document.getElementById("add-seg-btn").addEventListener("click", () => {
  const name  = document.getElementById("seg-name").value.trim();
  const start = parseTimeInput(document.getElementById("seg-start").value);
  const end   = parseTimeInput(document.getElementById("seg-end").value);
  if (!name) { toast("Enter a segment name", true); return; }
  if (end <= start) { toast("End must be after start", true); return; }
  editingTrack.segments = editingTrack.segments || [];
  if (editingSegIdx >= 0) {
    editingTrack.segments[editingSegIdx] = { name, start, end };
  } else {
    editingTrack.segments.push({ name, start, end });
  }
  editingTrack.segments.sort((a, b) => a.start - b.start);
  editingSegIdx = -1;
  renderSegList(editingTrack.segments, editingTrack.duration_seconds);
  document.getElementById("seg-name").value = "";
  document.getElementById("add-seg-btn").textContent = "＋ Add";
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
// Settings view
// ---------------------------------------------------------------------------

let _settingsPollTimer = null;

async function loadSettingsView() {
  try {
    const s = await api("GET", "/settings");
    const radios = document.querySelectorAll('input[name="quality"]');
    radios.forEach(r => { r.checked = r.value === s.audio_quality; });
  } catch { /* non-fatal */ }
  await refreshBgTasks();
  await refreshLogs();
}

async function refreshBgTasks() {
  try {
    const [conv, jobs] = await Promise.all([
      api("GET", "/conversions"),
      api("GET", "/jobs"),
    ]);

    const convEl = document.getElementById("bg-conversions");
    const parts = [];
    if (conv.running || conv.queued > 0)
      parts.push(`${conv.converting_ids.length} converting`);
    if (conv.queued > 0)
      parts.push(`${conv.queued} queued`);
    if (parts.length) {
      convEl.innerHTML = `<span class="bg-task-label">MP3→M4A: ${parts.join(", ")}</span>`;
    } else {
      convEl.innerHTML = `<span class="bg-task-label dim">No active conversions</span>`;
    }
    if (conv.failed_ids?.length) {
      const names = conv.failed_ids.map(id => {
        const t = library.find(l => l.id === id);
        return t ? displayName(t) : id.slice(0, 8);
      });
      convEl.innerHTML += `<div class="bg-task-item" style="color:var(--danger);flex-wrap:wrap;gap:4px">
        ⚠ Failed (${conv.failed_ids.length}): ${esc(names.join(", "))}
        <button id="retry-conv-btn" class="btn secondary" style="font-size:11px;padding:3px 8px;margin-left:4px">Retry all</button>
      </div>`;
      document.getElementById("retry-conv-btn")?.addEventListener("click", async () => {
        try {
          const r = await api("POST", "/conversions/retry");
          toast(`Re-queued ${r.queued} conversion${r.queued !== 1 ? "s" : ""}`);
          await refreshBgTasks();
        } catch (err) { toast(err.message, true); }
      });
    }

    const dlEl  = document.getElementById("bg-downloads");
    const active = Object.values(jobs).filter(j => j.status === "queued" || j.status === "running");
    if (active.length) {
      dlEl.innerHTML = `<span class="bg-task-label">Downloads in progress: ${active.length}</span>` +
        active.map(j => `<div class="bg-task-item"><span class="spinner" style="width:12px;height:12px;border-width:1.5px"></span> ${esc((j.track?.title || j.url || "").slice(0, 60))}</div>`).join("");
    } else {
      dlEl.innerHTML = `<span class="bg-task-label dim">No active downloads</span>`;
    }
  } catch { /* non-fatal */ }
}

async function refreshLogs() {
  try {
    const logs = await api("GET", "/logs");
    const panel = document.getElementById("log-panel");
    if (!logs.length) {
      panel.textContent = "No log entries yet.";
      return;
    }
    panel.innerHTML = logs.slice().reverse().map(l => `<div class="log-line">${esc(l)}</div>`).join("");
  } catch { /* non-fatal */ }
}

document.getElementById("save-quality-btn").addEventListener("click", async () => {
  const val = document.querySelector('input[name="quality"]:checked')?.value;
  if (!val) return;
  try {
    await api("POST", "/settings", { audio_quality: val });
    const msg = document.getElementById("quality-saved-msg");
    msg.style.display = "inline";
    setTimeout(() => { msg.style.display = "none"; }, 2000);
  } catch (err) { toast(err.message, true); }
});

document.getElementById("refresh-bg-btn").addEventListener("click",   refreshBgTasks);
document.getElementById("refresh-logs-btn").addEventListener("click",  refreshLogs);

// ---------------------------------------------------------------------------
// Repair job polling — clears repairing badges when jobs finish
// ---------------------------------------------------------------------------

let _repairPollTimer = null;

function startRepairPoll() {
  if (_repairPollTimer || _repairingTracks.size === 0) return;
  _repairPollTimer = setInterval(async () => {
    if (_repairingTracks.size === 0) {
      clearInterval(_repairPollTimer);
      _repairPollTimer = null;
      return;
    }
    try {
      const jobs = await api("GET", "/jobs");
      let changed = false;
      for (const job of Object.values(jobs)) {
        if (!job.track_id || !_repairingTracks.has(job.track_id)) continue;
        if (job.status === "done") {
          _repairingTracks.delete(job.track_id);
          changed = true;
        } else if (job.status === "error") {
          _repairingTracks.delete(job.track_id);
          const t = library.find(l => l.id === job.track_id);
          toast(`Re-download failed: ${t ? displayName(t) : job.track_id.slice(0, 8)}`, true);
          changed = true;
        }
      }
      if (changed) await loadLibrary();
    } catch { /* network blip — retry next tick */ }
  }, 4000);
}

// ---------------------------------------------------------------------------
// Deep check + upgrade
// ---------------------------------------------------------------------------

async function runDeepCheck() {
  const btn        = document.getElementById("deep-check-btn");
  const spinner    = document.getElementById("deep-check-spinner");
  const results    = document.getElementById("deep-check-results");
  const upgradeAll = document.getElementById("upgrade-all-btn");

  btn.disabled             = true;
  spinner.style.display    = "inline";
  results.innerHTML        = "";
  upgradeAll.style.display = "none";

  try {
    const r = await api("POST", "/admin/deep-check");

    _corruptNoSource.clear();
    _qualityOutdated.clear();
    r.corrupt_no_source_ids?.forEach(id => _corruptNoSource.add(id));
    r.quality_outdated_ids?.forEach(id  => _qualityOutdated.add(id));
    r.corrupt_redownloading_ids?.forEach(id => _repairingTracks.add(id));
    startRepairPoll();
    renderLibrary();

    const lines = [];
    if (r.checked > 0)
      lines.push(`Checked ${r.checked} file${r.checked !== 1 ? "s" : ""}: ${r.ok} healthy.`);
    if (r.corrupt_redownloading > 0)
      lines.push(`↻ Auto-repairing ${r.corrupt_redownloading} corrupt track${r.corrupt_redownloading !== 1 ? "s" : ""} (redownloading…).`);
    if (r.corrupt_no_source_ids?.length) {
      const names = r.corrupt_no_source_ids.map(id => {
        const t = library.find(l => l.id === id); return t ? displayName(t) : id.slice(0, 8);
      });
      lines.push(`✗ ${r.corrupt_no_source_ids.length} corrupt, no source: ${names.join(", ")} — open track to re-upload.`);
    }
    if (r.quality_outdated_ids?.length) {
      lines.push(`↑ ${r.quality_outdated_ids.length} track${r.quality_outdated_ids.length !== 1 ? "s" : ""} below current quality setting.`);
      upgradeAll.style.display = "inline-flex";
    }
    if (r.checked === 0) lines.push("No audio files to check.");
    else if (!lines.length) lines.push("All files are healthy.");

    results.innerHTML = lines.map(l =>
      `<div style="font-size:12px;color:var(--text-dim);margin-top:4px">${esc(l)}</div>`
    ).join("");

    // Per-track upgrade buttons for outdated tracks with a YouTube source
    if (r.quality_outdated_ids?.length) {
      const list = document.createElement("div");
      list.style.cssText = "margin-top:8px;display:flex;flex-direction:column;gap:4px";
      for (const id of r.quality_outdated_ids) {
        const t = library.find(l => l.id === id);
        if (!t?.source_url) continue;
        const row = document.createElement("div");
        row.style.cssText = "display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-dim)";
        row.innerHTML = `<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(displayName(t))}</span>`;
        const upgradeBtn = document.createElement("button");
        upgradeBtn.className = "btn secondary";
        upgradeBtn.style.cssText = "font-size:11px;padding:3px 8px;flex-shrink:0";
        upgradeBtn.textContent = "↑ Upgrade";
        upgradeBtn.addEventListener("click", () => upgradeTrack(id, upgradeBtn));
        row.appendChild(upgradeBtn);
        list.appendChild(row);
      }
      if (list.children.length) results.appendChild(list);
    }
  } catch (err) {
    results.textContent = "Error: " + err.message;
  } finally {
    btn.disabled          = false;
    spinner.style.display = "none";
  }
}

async function upgradeTrack(trackId, btn) {
  if (btn) { btn.disabled = true; btn.textContent = "…"; }
  try {
    await api("POST", `/tracks/${trackId}/upgrade`);
    _qualityOutdated.delete(trackId);
    _repairingTracks.add(trackId);
    startRepairPoll();
    renderLibrary();
    if (btn) btn.closest("div")?.remove();
    toast("Upgrade queued — redownloading…");
    const remaining = [..._qualityOutdated].filter(id => library.find(l => l.id === id)?.source_url);
    if (!remaining.length) document.getElementById("upgrade-all-btn").style.display = "none";
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = "↑ Upgrade"; }
    toast(err.message, true);
  }
}

async function upgradeAllOutdated() {
  const btn = document.getElementById("upgrade-all-btn");
  btn.disabled = true;
  const ids = [..._qualityOutdated].filter(id => library.find(l => l.id === id)?.source_url);
  if (!ids.length) { btn.disabled = false; return; }
  let done = 0;
  for (const id of ids) {
    try {
      await api("POST", `/tracks/${id}/upgrade`);
      _qualityOutdated.delete(id);
      _repairingTracks.add(id);
      done++;
    } catch { /* individual failure — continue with others */ }
  }
  startRepairPoll();
  renderLibrary();
  toast(`Upgrade queued for ${done} track${done !== 1 ? "s" : ""}`);
  btn.style.display = "none";
  btn.disabled = false;
}

document.getElementById("deep-check-btn").addEventListener("click",   runDeepCheck);
document.getElementById("upgrade-all-btn").addEventListener("click",  upgradeAllOutdated);

// ---------------------------------------------------------------------------
// Custom thumbnail (edit modal)
// ---------------------------------------------------------------------------

function refreshMixerThumbnails(trackId) {
  for (const [slotId, node] of activeTracks) {
    if (node.meta.id !== trackId) continue;
    const el = document.getElementById("mtrack-" + slotId);
    if (!el) continue;
    const hasThumb = node.meta.thumbnail || node.meta.has_custom_thumbnail;
    const newSrc   = `/api/tracks/${trackId}/thumbnail?v=${node.meta._thumbV || Date.now()}`;
    const img         = el.querySelector("img.thumb");
    const placeholder = el.querySelector(".thumb-placeholder");
    if (hasThumb) {
      if (img) {
        img.src = newSrc;
      } else if (placeholder) {
        const newImg = document.createElement("img");
        newImg.className = "thumb";
        newImg.alt = "";
        newImg.src = newSrc;
        placeholder.replaceWith(newImg);
      }
    } else if (img) {
      const ph = document.createElement("div");
      ph.className = "thumb-placeholder";
      ph.textContent = "♫";
      img.replaceWith(ph);
    }
  }
}

function initThumbEdit(track) {
  const img         = document.getElementById("thumb-preview-img");
  const placeholder = document.getElementById("thumb-preview-placeholder");
  const uploadBtn   = document.getElementById("upload-thumb-btn");
  const removeBtn   = document.getElementById("remove-thumb-btn");
  const fileInput   = document.getElementById("thumb-file-input");

  const hasThumbnail = track.thumbnail || track.has_custom_thumbnail;
  if (hasThumbnail) {
    img.src = `/api/tracks/${track.id}/thumbnail?t=${Date.now()}`;
    img.style.display = "block";
    placeholder.style.display = "none";
  } else {
    img.style.display = "none";
    placeholder.style.display = "flex";
  }
  removeBtn.style.display = track.has_custom_thumbnail ? "inline-flex" : "none";

  // Clone to strip old listeners
  const freshUpload = uploadBtn.cloneNode(true);
  const freshRemove = removeBtn.cloneNode(true);
  const freshInput  = fileInput.cloneNode(true);
  uploadBtn.replaceWith(freshUpload);
  removeBtn.replaceWith(freshRemove);
  fileInput.replaceWith(freshInput);

  freshUpload.addEventListener("click", () => freshInput.click());
  freshInput.addEventListener("change", async () => {
    if (!freshInput.files.length) return;
    const form = new FormData();
    form.append("file", freshInput.files[0]);
    try {
      await fetch(`/api/tracks/${track.id}/thumbnail/custom`, { method: "POST", body: form });
      img.src = `/api/tracks/${track.id}/thumbnail?t=${Date.now()}`;
      img.style.display = "block";
      placeholder.style.display = "none";
      freshRemove.style.display = "inline-flex";
      const libTrack = library.find(t => t.id === track.id);
      if (libTrack) { libTrack.has_custom_thumbnail = true; libTrack._thumbV = Date.now(); }
      refreshMixerThumbnails(track.id);
      renderLibrary();
      toast("Custom thumbnail saved");
    } catch (err) { toast(err.message, true); }
  });
  freshRemove.addEventListener("click", async () => {
    try {
      await api("DELETE", `/tracks/${track.id}/thumbnail/custom`);
      freshRemove.style.display = "none";
      const libTrack = library.find(t => t.id === track.id);
      if (libTrack) { libTrack.has_custom_thumbnail = false; libTrack._thumbV = Date.now(); }
      if (track.thumbnail) {
        img.src = `/api/tracks/${track.id}/thumbnail?t=${Date.now()}`;
        img.style.display = "block";
        placeholder.style.display = "none";
      } else {
        img.style.display = "none";
        placeholder.style.display = "flex";
      }
      refreshMixerThumbnails(track.id);
      renderLibrary();
      toast("Custom thumbnail removed");
    } catch (err) { toast(err.message, true); }
  });
}

// ---------------------------------------------------------------------------
// Audio re-upload (edit modal)
// ---------------------------------------------------------------------------

function initAudioReupload(track) {
  const row     = document.getElementById("audio-reupload-row");
  const label   = document.getElementById("audio-reupload-label");
  const status  = document.getElementById("reupload-audio-status");
  let btn       = document.getElementById("reupload-audio-btn");
  let fileInput = document.getElementById("audio-reupload-input");

  const showRow = _corruptNoSource.has(track.id) ||
                  (track.has_audio === false && !track.source_url);

  row.style.display = showRow ? "block" : "none";
  if (!showRow) return;

  label.textContent = _corruptNoSource.has(track.id)
    ? "Audio file is corrupt — upload a replacement"
    : "Audio file is missing — upload a replacement";
  status.textContent = "";

  const freshBtn   = btn.cloneNode(true);
  const freshInput = fileInput.cloneNode(true);
  btn.replaceWith(freshBtn);
  fileInput.replaceWith(freshInput);

  freshBtn.addEventListener("click", () => freshInput.click());
  freshInput.addEventListener("change", async () => {
    if (!freshInput.files.length) return;
    status.innerHTML = `<span class="spinner" style="width:12px;height:12px;border-width:1.5px"></span> Uploading…`;
    freshBtn.disabled = true;
    const form = new FormData();
    form.append("file", freshInput.files[0]);
    try {
      const r = await fetch(`/api/tracks/${track.id}/audio`, { method: "POST", body: form });
      if (!r.ok) throw new Error((await r.json()).error);
      status.textContent = "✓ Uploaded — converting…";
      _corruptNoSource.delete(track.id);
      const libTrack = library.find(t => t.id === track.id);
      if (libTrack) libTrack.has_audio = true;
      row.style.display = "none";
      renderLibrary();
      toast("Audio file replaced");
    } catch (err) {
      status.textContent = "✗ " + err.message;
      freshBtn.disabled = false;
      toast(err.message, true);
    }
  });
}

// ---------------------------------------------------------------------------
// Re-fetch audio button (edit modal)
// ---------------------------------------------------------------------------

function initRefetchBtn(track) {
  const btn = document.getElementById("refetch-audio-btn");
  const isYT = !!(track.source_url &&
    (track.source_url.includes("youtube.com") || track.source_url.includes("youtu.be")));
  btn.style.display = isYT ? "inline-flex" : "none";

  // Clone to strip any previous listener
  const fresh = btn.cloneNode(true);
  btn.replaceWith(fresh);

  fresh.addEventListener("click", async () => {
    if (!confirm(`Re-download "${displayName(track)}" from YouTube?\nThe current audio file will be replaced.`)) return;
    fresh.disabled = true;
    try {
      await api("POST", `/tracks/${track.id}/upgrade`);
      _qualityOutdated.delete(track.id);
      _repairingTracks.add(track.id);
      startRepairPoll();
      renderLibrary();
      document.getElementById("track-modal").classList.add("hidden");
      toast("Re-fetch queued — redownloading…");
    } catch (err) {
      fresh.disabled = false;
      toast(err.message, true);
    }
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

(async () => {
  setupMediaSession();
  initQueueDrag();
  await loadLibrary();
  await loadPresets();
  // Sanity check: flag / repair tracks with missing audio
  try {
    const result = await api("POST", "/admin/sanity");
    if (result.redownloading_ids?.length) {
      result.redownloading_ids.forEach(id => _repairingTracks.add(id));
      startRepairPoll();
      renderLibrary();
      toast(`Redownloading ${result.redownloading} track${result.redownloading > 1 ? "s" : ""} with missing audio`);
    }
    if (result.converting > 0) {
      toast(`Converting ${result.converting} track${result.converting > 1 ? "s" : ""} to M4A`);
    }
    if (result.missing_no_source?.length) {
      toast(`${result.missing_no_source.length} track${result.missing_no_source.length > 1 ? "s" : ""} missing audio — check library`, true);
    }
  } catch { /* non-fatal */ }
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
