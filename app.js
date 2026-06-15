// app.js — renders the static archive from data/items.json + data/matches.json.
// No framework, no backend. Degrades gracefully when metadata is missing.

const STAGE_ORDER = [
  "Group stage", "Round of 32", "Round of 16",
  "Quarter-finals", "Semi-finals", "Third-place play-off", "Final",
];
const IMPORTANCE_ORDER = ["must-save", "good", "maybe"];

const state = { items: [], matchesById: new Map(), flagByTeam: new Map(), filtered: [], view: "grouped" };

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

// Hosts whose external link is a video — labelled "Watch", everything else by domain.
const VIDEO_HOSTS = /(?:streamff|streamja|streamin|streamye|streamwo|streamable|dubz|v\.redd\.it|youtube\.com|youtu\.be|twitter\.com|x\.com|twitch\.tv|kick\.com|tiktok\.com)/i;

/** Link to the site a Reddit post points out to (usually a video), distinct from the post. */
function externalLinkHtml(item) {
  if (!item.externalUrl || item.externalUrl === item.url) return "";
  let host = "";
  try { host = new URL(item.externalUrl).hostname.replace(/^www\./, ""); } catch { /* ignore */ }
  const label = VIDEO_HOSTS.test(item.externalUrl) ? "Watch ↗" : `${host || "Link"} ↗`;
  return `<a class="external-link" href="${esc(item.externalUrl)}" target="_blank" rel="noopener noreferrer" title="Open the linked site${host ? " (" + esc(host) + ")" : ""}">${esc(label)}</a>`;
}

function cardHtml(item, opts = {}) {
  const url = item.url || "#";

  // In the grouped view, the match/score and stage/group are already in the group header,
  // so suppress them on each row to avoid repetition.
  let matchLine = "";
  if (!opts.hideMatch) {
    if (item.scoreLabel) matchLine = `<div class="match-line"><span class="score">${esc(item.scoreLabel)}</span></div>`;
    else if (item.matchLabel) matchLine = `<div class="match-line">${esc(item.matchLabel)}</div>`;
    else if ((item.candidateMatches || []).length) matchLine = `<div class="match-line">Possible: ${esc(item.candidateMatches.map((c) => c.matchLabel).join(" / "))}</div>`;
  }

  const chips = [];
  if (!opts.hideMatch && item.stage) chips.push(`<span class="chip chip-stage">${esc(item.stage)}</span>`);
  if (!opts.hideMatch && item.group) chips.push(`<span class="chip chip-group">Group ${esc(item.group)}</span>`);
  // Team chips are dropped in list view — teams already show (with flags) in the match line.
  for (const t of [...(item.type || []), ...(item.tags || [])]) chips.push(`<span class="chip chip-type">${esc(t)}</span>`);
  if (item.importance) chips.push(`<span class="badge badge-importance">${esc(item.importance)}</span>`);
  if (item.needsReview) chips.push(`<span class="badge badge-review">Needs review</span>`);

  const source = item.sourceDetail || item.source;
  const postDate = fmtDate(item.postDate);
  const savedDate = fmtDate(item.dateSaved);
  const metaBits = [];
  if (source) metaBits.push(`<span class="src">${esc(source)}</span>`);
  if (postDate) metaBits.push(`<span title="Date posted">Posted ${esc(postDate)}</span>`);
  if (savedDate) metaBits.push(`<span title="Date saved to the archive">Saved ${esc(savedDate)}</span>`);

  return `<article class="card">
    <div class="row-main">
      <h2 class="card-title"><a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(item.title || url)}</a></h2>
      ${matchLine}
      ${chips.length ? `<div class="meta-row">${chips.join("")}</div>` : ""}
      ${item.note ? `<p class="note">${esc(item.note)}</p>` : ""}
      ${!item.note && item.description ? `<p class="desc">${esc(item.description.slice(0, 160))}${item.description.length > 160 ? "…" : ""}</p>` : ""}
      <div class="row-meta">${metaBits.join('<span class="dot">·</span>')}</div>
    </div>
    <div class="row-links">
      ${item.archivedUrl ? `<a class="archived-link" href="${esc(item.archivedUrl)}" target="_blank" rel="noopener noreferrer" title="Archived snapshot (Wayback Machine)">Archived</a>` : ""}
      ${externalLinkHtml(item)}
      <a class="open-btn" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open ↗</a>
    </div>
  </article>`;
}

/* ---------- Grouped view: matchday (date posted) → match, with "Other" ---------- */

// Calendar day a post belongs to — date posted, falling back to date saved.
const dayKeyOf = (item) => {
  const d = item.postDate || item.dateSaved;
  return d ? String(d).slice(0, 10) : "";
};

function fmtDayLong(day) {
  if (!day) return "Undated";
  const d = new Date(day + "T12:00:00Z"); // noon UTC so the calendar day doesn't shift by zone
  return isNaN(d.getTime()) ? day : d.toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric" });
}

const teamObjLabel = (team) => (team?.flag ? `${team.flag} ${team.name || "?"}` : team?.name || "?");

/** Header for a match subgroup: "🇲🇽 Mexico 2–0 🇿🇦 South Africa" (score if completed) or "… vs …". */
function matchHeaderTitle(matchId, items) {
  const m = state.matchesById.get(matchId);
  if (m) {
    const h = teamObjLabel(m.homeTeam), a = teamObjLabel(m.awayTeam);
    if (m.status === "completed" && m.score && m.score.home != null && m.score.away != null) {
      return `<span class="score">${esc(h)} ${m.score.home}–${m.score.away} ${esc(a)}</span>`;
    }
    return `${esc(h)} vs ${esc(a)}`;
  }
  const it = items[0] || {}; // match not in matches.json — use what the item carries (already flagged)
  return esc(it.scoreLabel || it.matchLabel || matchId);
}

// Accent/case-insensitive normalization for fuzzy title matching.
const normText = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/**
 * Flag goals in a completed match that have no covering video post in the archive.
 * A goal is "covered" if some Goal-tagged item linked to the match mentions its minute (e.g. 67')
 * or the scorer's surname. Considers ALL archived items (not just the current day/filter), since
 * a goal clip may have been posted on another day. Returns a warning row, or "" if all covered.
 */
function goalCoverageHtml(matchId) {
  const m = state.matchesById.get(matchId);
  if (!m || m.status !== "completed" || !Array.isArray(m.goals) || !m.goals.length) return "";
  const titles = state.items
    .filter((it) => it.matchId === matchId && (it.tags || []).includes("Goal"))
    .map((it) => normText(it.title));

  const missing = m.goals.filter((g) => {
    const minHit = g.minute != null && titles.some((t) => new RegExp(`\\b${g.minute}'`).test(t));
    const nameTokens = normText(g.player).split(/\s+/).filter((w) => w.length >= 3);
    const nameHit = nameTokens.length > 0 && titles.some((t) => nameTokens.some((w) => t.includes(w)));
    return !(minHit || nameHit);
  });
  if (!missing.length) return "";

  const chips = missing
    .map((g) => `<span class="gm-chip">${g.minute != null ? esc(g.minute) + "' " : ""}${esc(g.player || "Goal")}</span>`)
    .join("");
  return `<div class="goal-missing"><span class="gm-label">⚠ No video:</span> ${chips}</div>`;
}

function groupedHtml(items) {
  if (!items.length) return "";
  // 1) group by matchday (date posted)
  const byDay = new Map();
  for (const it of items) {
    const k = dayKeyOf(it);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(it);
  }
  const days = [...byDay.keys()].sort((a, b) => (!a ? 1 : !b ? -1 : b.localeCompare(a))); // newest first, undated last

  const parts = [];
  for (const day of days) {
    const dayItems = byDay.get(day);
    // 2) group by match within the day; no matchId → "Other"
    const byMatch = new Map();
    for (const it of dayItems) {
      const k = it.matchId || "__other__";
      if (!byMatch.has(k)) byMatch.set(k, []);
      byMatch.get(k).push(it);
    }
    const keys = [...byMatch.keys()].sort((a, b) => {
      if (a === "__other__") return 1; // "Other" always last in the day
      if (b === "__other__") return -1;
      const ka = state.matchesById.get(a)?.kickoffUtc || "";
      const kb = state.matchesById.get(b)?.kickoffUtc || "";
      return String(ka).localeCompare(String(kb)) || a.localeCompare(b);
    });

    const groups = keys.map((k) => {
      const isOther = k === "__other__";
      const gItems = byMatch.get(k).slice().sort((a, b) => String(b.postDate || "0").localeCompare(String(a.postDate || "0")));
      const header = isOther ? `<span class="other">Other posts</span>` : matchHeaderTitle(k, gItems);
      return `<div class="match-group">
        <h3 class="match-header">${header} <span class="g-count">${gItems.length}</span></h3>
        ${isOther ? "" : goalCoverageHtml(k)}
        <div class="match-items">${gItems.map((it) => cardHtml(it, { hideMatch: !isOther })).join("")}</div>
      </div>`;
    });

    parts.push(`<section class="day-group">
      <h2 class="day-header">${esc(fmtDayLong(day))} <span class="day-count">${dayItems.length}</span></h2>
      ${groups.join("")}
    </section>`);
  }
  return parts.join("");
}

function render() {
  const container = $("#cards");
  if (state.view === "grouped") {
    container.classList.add("grouped");
    container.innerHTML = groupedHtml(state.filtered);
  } else {
    container.classList.remove("grouped");
    container.innerHTML = state.filtered.map((it) => cardHtml(it)).join("");
  }
  $("#result-count").textContent =
    `${state.filtered.length} of ${state.items.length} item${state.items.length === 1 ? "" : "s"}`;
  $("#empty-state").hidden = state.items.length !== 0;
}

/* ---------- Init ---------- */

function reflectViewButtons() {
  $("#view-list").classList.toggle("is-active", state.view === "list");
  $("#view-grouped").classList.toggle("is-active", state.view === "grouped");
  $("#view-list").setAttribute("aria-pressed", String(state.view === "list"));
  $("#view-grouped").setAttribute("aria-pressed", String(state.view === "grouped"));
}

function setView(v) {
  state.view = v === "grouped" ? "grouped" : "list";
  try { localStorage.setItem("wc-view", state.view); } catch { /* ignore */ }
  reflectViewButtons();
  render();
}

function wireControls() {
  const ids = ["#f-search", "#f-source", "#f-stage", "#f-group", "#f-match", "#f-team", "#f-type", "#f-importance", "#f-review", "#f-sort"];
  for (const id of ids) {
    const el = $(id);
    el.addEventListener(id === "#f-search" ? "input" : "change", applyFilters);
  }
  $("#f-reset").addEventListener("click", () => {
    for (const id of ids) $(id).value = "";
    $("#f-sort").value = "postDate-desc";
    applyFilters();
  });
  $("#view-list").addEventListener("click", () => setView("list"));
  $("#view-grouped").addEventListener("click", () => setView("grouped"));
}

async function init() {
  wireControls();
  // Default to the grouped "By matchday" view; only an explicit saved "list" choice opts out.
  try { state.view = localStorage.getItem("wc-view") === "list" ? "list" : "grouped"; } catch { state.view = "grouped"; }
  reflectViewButtons();
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
