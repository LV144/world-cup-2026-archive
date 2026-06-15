// app.js — renders the static archive from data/items.json + data/matches.json.
// No framework, no backend. Degrades gracefully when metadata is missing.

const STAGE_ORDER = [
  "Group stage", "Round of 32", "Round of 16",
  "Quarter-finals", "Semi-finals", "Third-place play-off", "Final",
];
const IMPORTANCE_ORDER = ["must-save", "good", "maybe"];

const state = { items: [], matchesById: new Map(), flagByTeam: new Map(), filtered: [] };

/** "🇲🇽 Mexico" when we know the team's flag (from matches.json), else just the name. */
const teamWithFlag = (name) => {
  const fl = state.flagByTeam.get(name);
  return fl ? `${fl} ${name}` : name;
};

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDate = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
};

async function loadJson(path) {
  const res = await fetch(path, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

function kickoffOf(item) {
  const m = item.matchId ? state.matchesById.get(item.matchId) : null;
  return m?.kickoffUtc || null;
}

/* ---------- Filter population ---------- */

function uniqueSorted(values, customOrder) {
  const set = [...new Set(values.filter((v) => v != null && v !== ""))];
  if (customOrder) {
    set.sort((a, b) => {
      const ia = customOrder.indexOf(a), ib = customOrder.indexOf(b);
      if (ia === -1 && ib === -1) return String(a).localeCompare(String(b));
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });
  } else {
    set.sort((a, b) => String(a).localeCompare(String(b)));
  }
  return set;
}

function fillSelect(id, values, allLabel) {
  const sel = $(id);
  const current = sel.value;
  sel.innerHTML =
    `<option value="">${allLabel}</option>` +
    values.map((v) => `<option value="${esc(v.value ?? v)}">${esc(v.label ?? v)}</option>`).join("");
  if ([...sel.options].some((o) => o.value === current)) sel.value = current;
}

function buildFilters() {
  const items = state.items;
  fillSelect("#f-source", uniqueSorted(items.map((i) => i.source)), "All sources");
  fillSelect("#f-stage", uniqueSorted(items.map((i) => i.stage), STAGE_ORDER), "All stages");
  fillSelect("#f-group", uniqueSorted(items.map((i) => i.group)).map((g) => ({ value: g, label: `Group ${g}` })), "All groups");

  const matchMap = new Map();
  for (const i of items) if (i.matchId && i.matchLabel) matchMap.set(i.matchId, i.matchLabel);
  fillSelect("#f-match", [...matchMap.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([value, label]) => ({ value, label })), "All matches");

  fillSelect("#f-team", uniqueSorted(items.flatMap((i) => i.teams || [])).map((t) => ({ value: t, label: teamWithFlag(t) })), "All teams");
  fillSelect("#f-type", uniqueSorted(items.flatMap((i) => [...(i.type || []), ...(i.tags || [])])), "All types / tags");
  fillSelect("#f-importance", uniqueSorted(items.map((i) => i.importance), IMPORTANCE_ORDER), "All importance");
}

/* ---------- Filtering + sorting ---------- */

function applyFilters() {
  const q = $("#f-search").value.trim().toLowerCase();
  const fSource = $("#f-source").value;
  const fStage = $("#f-stage").value;
  const fGroup = $("#f-group").value;
  const fMatch = $("#f-match").value;
  const fTeam = $("#f-team").value;
  const fType = $("#f-type").value;
  const fImp = $("#f-importance").value;
  const fReview = $("#f-review").value;

  let rows = state.items.filter((it) => {
    if (fSource && it.source !== fSource) return false;
    if (fStage && it.stage !== fStage) return false;
    if (fGroup && it.group !== fGroup) return false;
    if (fMatch && it.matchId !== fMatch) return false;
    if (fTeam && !(it.teams || []).includes(fTeam)) return false;
    if (fType && !([...(it.type || []), ...(it.tags || [])].includes(fType))) return false;
    if (fImp && it.importance !== fImp) return false;
    if (fReview === "yes" && !it.needsReview) return false;
    if (fReview === "no" && it.needsReview) return false;
    if (q) {
      const hay = [
        it.title, it.description, it.source, it.sourceDetail, it.matchLabel, it.note,
        ...(it.teams || []), ...(it.teamCodes || []), ...(it.tags || []), ...(it.type || []),
      ].filter(Boolean).join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const [key, dir] = $("#f-sort").value.split("-");
  const sign = dir === "asc" ? 1 : -1;
  const cmp = {
    dateSaved: (a, b) => String(a.dateSaved).localeCompare(String(b.dateSaved)) * sign,
    postDate: (a, b) => String(a.postDate || "0").localeCompare(String(b.postDate || "0")) * sign,
    kickoff: (a, b) => String(kickoffOf(a) || "9999").localeCompare(String(kickoffOf(b) || "9999")) * sign,
    stage: (a, b) => (STAGE_ORDER.indexOf(a.stage) + 1 || 99) - (STAGE_ORDER.indexOf(b.stage) + 1 || 99),
    source: (a, b) => String(a.source || "~").localeCompare(String(b.source || "~")),
    importance: (a, b) => (IMPORTANCE_ORDER.indexOf(a.importance) + 1 || 99) - (IMPORTANCE_ORDER.indexOf(b.importance) + 1 || 99),
    title: (a, b) => String(a.title || "").localeCompare(String(b.title || "")),
  }[key];
  rows.sort(cmp);

  state.filtered = rows;
  render();
}

/* ---------- Rendering ---------- */

function thumbHtml(item) {
  const src = item.thumbnailLocalPath || item.thumbnailRemoteUrl;
  const chip = item.source ? `<span class="source-chip">${esc(item.source)}</span>` : "";
  if (src) {
    return `<div class="thumb">${chip}<img src="${esc(src)}" alt="" loading="lazy"
      onerror="this.parentNode.innerHTML='<div class=&quot;placeholder&quot;>⚽</div>${chip.replace(/"/g, "&quot;")}'" /></div>`;
  }
  return `<div class="thumb">${chip}<div class="placeholder">⚽</div></div>`;
}

function cardHtml(item) {
  const url = item.url || "#";
  const chips = [];
  if (item.stage) chips.push(`<span class="chip chip-stage">${esc(item.stage)}</span>`);
  if (item.group) chips.push(`<span class="chip chip-group">Group ${esc(item.group)}</span>`);
  for (const t of item.teams || []) chips.push(`<span class="chip chip-team">${esc(teamWithFlag(t))}</span>`);
  for (const t of [...(item.type || []), ...(item.tags || [])]) chips.push(`<span class="chip chip-type">${esc(t)}</span>`);

  let matchLine = "";
  if (item.scoreLabel) matchLine = `<div class="match-line"><span class="score">${esc(item.scoreLabel)}</span></div>`;
  else if (item.matchLabel) matchLine = `<div class="match-line">${esc(item.matchLabel)}</div>`;
  else if ((item.candidateMatches || []).length) matchLine = `<div class="match-line">Possible: ${esc(item.candidateMatches.map((c) => c.matchLabel).join(" / "))}</div>`;

  const badges = [];
  if (item.importance) badges.push(`<span class="badge badge-importance">${esc(item.importance)}</span>`);
  if (item.needsReview) badges.push(`<span class="badge badge-review">Needs review</span>`);

  const savedDate = fmtDate(item.dateSaved);
  const postDate = fmtDate(item.postDate);

  return `<article class="card">
    ${thumbHtml(item)}
    <div class="card-body">
      <h2 class="card-title"><a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(item.title || url)}</a></h2>
      ${matchLine}
      ${chips.length ? `<div class="meta-row">${chips.join("")}</div>` : ""}
      ${item.note ? `<p class="note">${esc(item.note)}</p>` : ""}
      ${!item.note && item.description ? `<p class="desc">${esc(item.description.slice(0, 160))}${item.description.length > 160 ? "…" : ""}</p>` : ""}
      ${badges.length ? `<div class="meta-row">${badges.join("")}</div>` : ""}
      ${postDate ? `<div class="post-date">Posted ${esc(postDate)}</div>` : ""}
      <div class="card-footer">
        <span class="date-saved" title="Date saved to the archive">Saved ${esc(savedDate)}</span>
        <span class="footer-links">
          ${item.archivedUrl ? `<a class="archived-link" href="${esc(item.archivedUrl)}" target="_blank" rel="noopener noreferrer" title="Archived snapshot (Wayback Machine)">Archived</a>` : ""}
          <a class="open-btn" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open ↗</a>
        </span>
      </div>
    </div>
  </article>`;
}

function render() {
  const container = $("#cards");
  container.innerHTML = state.filtered.map(cardHtml).join("");
  $("#result-count").textContent =
    `${state.filtered.length} of ${state.items.length} item${state.items.length === 1 ? "" : "s"}`;
  $("#empty-state").hidden = state.items.length !== 0;
}

/* ---------- Init ---------- */

function wireControls() {
  const ids = ["#f-search", "#f-source", "#f-stage", "#f-group", "#f-match", "#f-team", "#f-type", "#f-importance", "#f-review", "#f-sort"];
  for (const id of ids) {
    const el = $(id);
    el.addEventListener(id === "#f-search" ? "input" : "change", applyFilters);
  }
  $("#f-reset").addEventListener("click", () => {
    for (const id of ids) $(id).value = "";
    $("#f-sort").value = "dateSaved-desc";
    applyFilters();
  });
}

async function init() {
  wireControls();
  try {
    const [items, matches] = await Promise.all([
      loadJson("data/items.json"),
      loadJson("data/matches.json").catch(() => []),
    ]);
    state.items = Array.isArray(items) ? items : [];
    state.matchesById = new Map((matches || []).map((m) => [m.matchId, m]));
    state.flagByTeam = new Map();
    for (const m of matches || []) {
      for (const t of [m.homeTeam, m.awayTeam]) {
        if (t?.name && t.flag) state.flagByTeam.set(t.name, t.flag);
      }
    }
    buildFilters();
    applyFilters();
  } catch (err) {
    $("#cards").innerHTML = `<p class="error-state">Could not load archive data (${esc(err.message)}).<br />
      If you opened this file directly, run <code>npm run serve</code> and open the served URL instead.</p>`;
  }
}

init();
