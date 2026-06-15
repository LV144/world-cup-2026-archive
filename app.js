// app.js — renders the static archive from data/items.json + data/matches.json.
// No framework, no backend. Degrades gracefully when metadata is missing.
//
// Optional owner-only edit mode (see editor section below): gated behind a GitHub
// fine-grained token kept in localStorage; saves commit data/items.json via the
// GitHub contents API. Friends without the token get a plain read-only archive.

import { matchLabelFor, scoreLabelFor, fieldsFromMatch } from "./scripts/utils/match-inference.mjs";
import { compileTagRules, inferContentTags, mergeTags, canonicalizeTags } from "./scripts/utils/content-tags.mjs";

// Repo the editor commits to (must match the GitHub Pages source repo).
const REPO = { owner: "LV144", repo: "world-cup-2026-archive", branch: "main", path: "data/items.json" };
const TOKEN_KEY = "wc-gh-token";

const STAGE_ORDER = [
  "Group stage", "Round of 32", "Round of 16",
  "Quarter-finals", "Semi-finals", "Third-place play-off", "Final",
];
const IMPORTANCE_ORDER = ["must-save", "good", "maybe"];

const state = {
  items: [], matchesById: new Map(), flagByTeam: new Map(), filtered: [], view: "grouped",
  compiledTags: [], token: null, editingId: null,
};

/** Edit mode is unlocked iff a token is present in this browser. UI gating only. */
const canEdit = () => !!state.token;

/** "🇲🇽 Mexico" when we know the team's flag (from matches.json), else just the name. */
const teamWithFlag = (name) => {
  const fl = state.flagByTeam.get(name);
  return fl ? `${fl} ${name}` : name;
};

/** Label a fixture with its score when completed ("🇺🇸 USA 4–1 🇵🇾 Paraguay"), else "A vs B". */
function matchDisplayLabel(matchId, fallback = null) {
  const m = state.matchesById.get(matchId);
  if (m) return scoreLabelFor(m) || matchLabelFor(m);
  return fallback || matchId || "";
}

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
  for (const i of items) if (i.matchId && i.matchLabel) matchMap.set(i.matchId, matchDisplayLabel(i.matchId, i.matchLabel));
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
      ${canEdit() ? `<button type="button" class="edit-btn" data-edit-id="${esc(item.id)}" title="Edit properties">✎ Edit</button>` : ""}
    </div>
  </article>`;
}

/* ---------- Grouped view: matchday (date posted) → match, with "Other" ---------- */

// Calendar day a post belongs to. Match-linked posts group under the day the match was played
// (matchDate — the local matchday, so all posts about one game sit together regardless of when
// each was posted); everything else falls back to date posted, then date saved.
const dayKeyOf = (item) => {
  const d = item.matchDate || item.postDate || item.dateSaved;
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

/* ---------- Editor (owner-only, token-gated) ----------
 * Saving commits data/items.json via the GitHub contents API. Derived fields are recomputed
 * client-side using the SAME pure helpers the Node scripts use (match-inference + content-tags),
 * so an edited item stays consistent with `npm run enrich` / `npm run validate`.
 */

let edPinned = [];     // canonical pinned tags (always kept) for the open modal
let edSuppressed = []; // canonical suppressed tags (always removed) for the open modal

function reflectEditorLock() {
  const btn = $("#editor-toggle");
  if (!btn) return;
  btn.textContent = canEdit() ? "🔓 Lock editing" : "🔒 Unlock editing";
  const status = $("#editor-status");
  if (status) status.textContent = canEdit() ? "Editing as owner" : "";
}

async function tokenCanWrite(token) {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO.owner}/${REPO.repo}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      cache: "no-store",
    });
    if (!res.ok) return false;
    const j = await res.json();
    return !!(j.permissions && j.permissions.push);
  } catch { return false; }
}

async function unlockEditor() {
  const token = (window.prompt("Paste your GitHub fine-grained token (stored only in this browser):") || "").trim();
  if (!token) return;
  if (!(await tokenCanWrite(token))) {
    alert("That token can't write to this repo (or is invalid). Nothing was stored.");
    return;
  }
  state.token = token;
  try { localStorage.setItem(TOKEN_KEY, token); } catch { /* ignore */ }
  reflectEditorLock();
  applyFilters(); // re-render so edit buttons appear
  toast("Editing unlocked");
}

function lockEditor() {
  state.token = null;
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
  reflectEditorLock();
  applyFilters();
  toast("Editing locked");
}

/** Mirror of enrich-items.mjs: recompute auto tags + match-derived fields for one item. */
function recomputeItem(item) {
  item.tags = mergeTags(item.tags, inferContentTags(item.title || "", state.compiledTags), state.compiledTags, item.pinnedTags || [], item.suppressedTags || []);
  if (item.matchId) {
    const m = state.matchesById.get(item.matchId);
    if (m) {
      const f = fieldsFromMatch(m);
      Object.assign(item, {
        matchLabel: f.matchLabel, matchDate: f.matchDate, stage: f.stage, group: f.group,
        teams: f.teams, teamCodes: f.teamCodes, scoreLabel: f.scoreLabel, goals: f.goals,
        candidateMatches: [], metadataConfidence: { match: 1, teams: 1, stage: 1, score: 1 },
        needsReview: !item.title,
      });
    } else {
      item.needsReview = true; // referenced match missing from matches.json
    }
  } else {
    // No match linked: clear football-derived fields and team chips so validate.mjs is satisfied.
    Object.assign(item, {
      matchLabel: null, matchDate: null, stage: null, group: null, teams: [], teamCodes: [],
      scoreLabel: null, goals: [], candidateMatches: [],
      metadataConfidence: { match: 0, teams: 0, stage: 0, score: 0 },
      needsReview: !item.title,
    });
  }
  return item;
}

function fillMatchSelect(currentId) {
  const sel = $("#ed-match");
  const opts = [...state.matchesById.values()]
    .slice()
    .sort((a, b) => String(a.kickoffUtc || "").localeCompare(String(b.kickoffUtc || "")))
    .map((m) => `<option value="${esc(m.matchId)}">${esc(scoreLabelFor(m) || matchLabelFor(m))}</option>`)
    .join("");
  sel.innerHTML = `<option value="">— No match —</option>` + opts;
  sel.value = currentId || "";
}

function updateMatchPreview() {
  const id = $("#ed-match").value;
  const el = $("#ed-match-preview");
  const m = id ? state.matchesById.get(id) : null;
  if (!m) { el.textContent = "No match linked — team & score fields will be cleared."; return; }
  const f = fieldsFromMatch(m);
  el.textContent = f.scoreLabel ? `Result: ${f.scoreLabel}` : `Linked: ${f.matchLabel} (no result recorded yet)`;
}

/** Render the effective final tags (auto ∪ pinned − suppressed) as removable chips. */
function renderTags() {
  const item = state.items.find((x) => x.id === state.editingId);
  const auto = inferContentTags(item?.title || "", state.compiledTags);
  const effective = mergeTags(item?.tags || [], auto, state.compiledTags, edPinned, edSuppressed);
  const pinnedLow = new Set(edPinned.map((t) => t.toLowerCase()));
  $("#ed-tags").innerHTML = effective.length
    ? effective.map((t) => {
        const pin = pinnedLow.has(t.toLowerCase()) ? "📌 " : "";
        return `<span class="chip chip-type">${pin}${esc(t)}<button type="button" class="chip-x" data-rm="${esc(t)}" title="Remove">×</button></span>`;
      }).join("")
    : `<span class="ed-empty">none</span>`;
  $("#ed-removed").innerHTML = edSuppressed.length
    ? `Removed (click to restore): ` + edSuppressed.map((t) => `<button type="button" class="ed-restore" data-restore="${esc(t)}">${esc(t)} ↺</button>`).join(" ")
    : "";
}

/** Add a tag: pins it (durable) and lifts any prior suppression of it. */
function addTag(raw) {
  const c = canonicalizeTags([raw], state.compiledTags)[0];
  if (!c) return;
  edSuppressed = edSuppressed.filter((s) => s.toLowerCase() !== c.toLowerCase());
  if (!edPinned.some((p) => p.toLowerCase() === c.toLowerCase())) edPinned.push(c);
  renderTags();
}

/** Remove a tag: un-pin if it was pinned, otherwise suppress it (durably, surviving enrich). */
function removeTag(t) {
  const low = t.toLowerCase();
  if (edPinned.some((p) => p.toLowerCase() === low)) {
    edPinned = edPinned.filter((p) => p.toLowerCase() !== low);
  } else if (!edSuppressed.some((s) => s.toLowerCase() === low)) {
    edSuppressed.push(t);
  }
  renderTags();
}

function openEditor(id) {
  const item = state.items.find((x) => x.id === id);
  if (!item || !canEdit()) return;
  state.editingId = id;
  edPinned = canonicalizeTags(item.pinnedTags || [], state.compiledTags);
  edSuppressed = canonicalizeTags(item.suppressedTags || [], state.compiledTags);
  $("#ed-title").textContent = item.title || item.url || id;
  $("#ed-importance").value = item.importance || "";
  $("#ed-type").value = (item.type || []).join(", ");
  $("#ed-note").value = item.note || "";
  $("#ed-backup").value = item.backup || "";
  $("#ed-locked").checked = !!item.matchLocked;
  $("#ed-review").checked = !!item.needsReview;
  $("#ed-error").textContent = "";
  fillMatchSelect(item.matchId);
  renderTags();
  updateMatchPreview();
  $("#editor").showModal();
}

function closeEditor() {
  state.editingId = null;
  const dlg = $("#editor");
  if (dlg.open) dlg.close();
}

async function saveEditor() {
  const item = state.items.find((x) => x.id === state.editingId);
  if (!item) return;
  const err = $("#ed-error");
  const saveBtn = $("#ed-save");
  err.textContent = "";

  const edited = JSON.parse(JSON.stringify(item));
  edited.importance = $("#ed-importance").value || null;
  edited.type = $("#ed-type").value.split(",").map((s) => s.trim()).filter(Boolean);
  edited.note = $("#ed-note").value;
  edited.backup = $("#ed-backup").value;
  edited.pinnedTags = canonicalizeTags(edPinned, state.compiledTags);
  edited.suppressedTags = canonicalizeTags(edSuppressed, state.compiledTags);
  edited.matchId = $("#ed-match").value || null;
  edited.matchLocked = $("#ed-locked").checked;
  recomputeItem(edited);
  if ($("#ed-review").checked) edited.needsReview = true;

  saveBtn.disabled = true;
  saveBtn.textContent = "Saving…";
  try {
    await commitItem(edited);
    const i = state.items.findIndex((x) => x.id === edited.id);
    state.items[i] = edited;
    buildFilters();
    applyFilters();
    closeEditor();
    toast("Saved — the site rebuilds in ~1 min");
  } catch (e) {
    err.textContent = e.message || "Save failed";
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = "Save";
  }
}

/* UTF-8-safe base64 (flag emojis / accents break raw btoa/atob). */
function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}
function base64ToUtf8(b64) {
  const bin = atob(String(b64).replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/** Commit the edited item into data/items.json via the GitHub contents API. */
async function commitItem(item) {
  const api = `https://api.github.com/repos/${REPO.owner}/${REPO.repo}/contents/${REPO.path}`;
  const headers = { Authorization: `Bearer ${state.token}`, Accept: "application/vnd.github+json" };

  const attempt = async () => {
    const getRes = await fetch(`${api}?ref=${REPO.branch}`, { headers, cache: "no-store" });
    if (!getRes.ok) throw new Error(`Could not read items.json (HTTP ${getRes.status})`);
    const meta = await getRes.json();
    const arr = JSON.parse(base64ToUtf8(meta.content));
    const idx = arr.findIndex((x) => x.id === item.id);
    if (idx === -1) throw new Error("Item not found in remote items.json");
    arr[idx] = item;
    const json = JSON.stringify(arr, null, 2) + "\n";
    return fetch(api, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `Edit: ${item.title ? item.title.slice(0, 60) : item.id}`,
        content: utf8ToBase64(json),
        sha: meta.sha,
        branch: REPO.branch,
      }),
    });
  };

  let res = await attempt();
  if (res.status === 409) res = await attempt(); // sha moved under us — refetch & retry once
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Save failed (HTTP ${res.status}). ${txt.slice(0, 160)}`);
  }
}

function toast(msg) {
  let t = $("#toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "toast";
    t.className = "toast";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 3000);
}

function wireEditor() {
  const toggle = $("#editor-toggle");
  if (toggle) toggle.addEventListener("click", () => (canEdit() ? lockEditor() : unlockEditor()));
  const dlg = $("#editor");
  if (!dlg) return;
  $("#ed-cancel").addEventListener("click", () => closeEditor());
  $("#ed-save").addEventListener("click", () => saveEditor());
  $("#ed-match").addEventListener("change", updateMatchPreview);
  $("#ed-tag-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addTag(e.target.value);
      e.target.value = "";
    }
  });
  $("#ed-tags").addEventListener("click", (e) => {
    const x = e.target.closest("[data-rm]");
    if (x) removeTag(x.dataset.rm);
  });
  $("#ed-removed").addEventListener("click", (e) => {
    const r = e.target.closest("[data-restore]");
    if (r) { edSuppressed = edSuppressed.filter((s) => s.toLowerCase() !== r.dataset.restore.toLowerCase()); renderTags(); }
  });
  dlg.addEventListener("click", (e) => { if (e.target === dlg) closeEditor(); }); // backdrop click
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

  // Edit buttons are injected per-card; delegate so they survive re-render.
  $("#cards").addEventListener("click", (e) => {
    const btn = e.target.closest(".edit-btn");
    if (btn) openEditor(btn.dataset.editId);
  });
}

async function init() {
  try { state.token = localStorage.getItem(TOKEN_KEY) || null; } catch { state.token = null; }
  wireControls();
  wireEditor();
  reflectEditorLock();
  // Default to the grouped "By matchday" view; only an explicit saved "list" choice opts out.
  try { state.view = localStorage.getItem("wc-view") === "list" ? "list" : "grouped"; } catch { state.view = "grouped"; }
  reflectViewButtons();
  try {
    const [items, matches, tagRules] = await Promise.all([
      loadJson("data/items.json"),
      loadJson("data/matches.json").catch(() => []),
      loadJson("data/tag-rules.json").catch(() => ({})),
    ]);
    state.items = Array.isArray(items) ? items : [];
    state.compiledTags = compileTagRules(tagRules || {});
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
