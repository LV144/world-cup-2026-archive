// match-sources.mjs
// Isolated, swappable adapters that fetch WC 2026 fixtures/results from free, no-auth
// public sources and return them already mapped to OUR matches.json schema.
//
// Primary  : openfootball (community-maintained structured JSON on GitHub) — no scraping.
//            https://github.com/openfootball/world-cup.json (2026)
// Fallback : Wikipedia fixture tables (HTML scrape; left as an isolated stub).
//
// Knockout matches whose teams aren't decided yet use placeholder slots ("1A", "2B",
// "W73", "3A/B/C/D/F"). We SKIP those until the teams are known — re-running update-matches
// adds each knockout fixture once openfootball fills in the real teams. If every adapter
// fails, fetchMatchesFromSources() returns { ok:false } and the caller leaves matches.json
// untouched.

import { fetchWithTimeout } from "./fetch-metadata.mjs";
import { CANONICAL_STAGES } from "./match-inference.mjs";

const OPENFOOTBALL_MATCHES = "https://raw.githubusercontent.com/openfootball/world-cup.json/master/2026/worldcup.json";
const OPENFOOTBALL_TEAMS = "https://raw.githubusercontent.com/openfootball/world-cup.json/master/2026/worldcup.teams.json";

function mapStage(roundName, stageAliases) {
  if (!roundName) return null;
  const lower = String(roundName).toLowerCase();
  for (const [canonical, aliases] of Object.entries(stageAliases || {})) {
    if (aliases.some((a) => lower.includes(String(a).toLowerCase()))) return canonical;
  }
  if (/matchday|group/.test(lower)) return "Group stage";
  return CANONICAL_STAGES.includes(roundName) ? roundName : null;
}

/** Fallback name→{name,code} resolver built from our team-aliases.json. */
function makeAliasResolver(teamAliases) {
  const byAlias = {};
  for (const [canonical, info] of Object.entries(teamAliases || {})) {
    const entry = { name: canonical, code: info?.code || null };
    byAlias[canonical.toLowerCase()] = entry;
    if (info?.code) byAlias[info.code.toLowerCase()] = entry;
    for (const a of info?.aliases || []) byAlias[String(a).toLowerCase()] = entry;
  }
  return (name) => byAlias[String(name || "").toLowerCase()] || null;
}

/** Authoritative name→{name,code} map from openfootball teams.json. */
function buildTeamMap(teamsJson) {
  const map = {};
  const arr = Array.isArray(teamsJson) ? teamsJson : Object.values(teamsJson || {});
  for (const t of arr) {
    if (!t || !t.name) continue;
    const entry = { name: t.name, code: t.fifa_code || null };
    map[t.name.toLowerCase()] = entry;
    if (t.name_normalised) map[t.name_normalised.toLowerCase()] = entry;
    if (t.fifa_code) map[t.fifa_code.toLowerCase()] = entry;
  }
  return map;
}

// A "team" string that is actually a bracket slot, not a decided team.
function isPlaceholder(name) {
  if (!name || typeof name !== "string") return true;
  const s = name.trim();
  return (
    /^\d+[a-l]$/i.test(s) ||      // 1A, 2B (group position)
    /^[wl]\d+$/i.test(s) ||       // W73 (winner of match 73), L101 (loser)
    /^3[a-l]\/[a-l/]+$/i.test(s) || // 3A/B/C/D/F (third-place permutations)
    s.includes("/") ||
    /^(winner|loser|runner|tbd)/i.test(s)
  );
}

function resolveTeam(name, teamMap, fallback) {
  if (isPlaceholder(name)) return null;
  return teamMap[String(name).toLowerCase()] || fallback(name) || null;
}

/** Convert openfootball "13:00 UTC-6" + date to an ISO UTC timestamp. */
function parseKickoffUtc(date, time) {
  if (!date) return null;
  const m = time && String(time).match(/(\d{1,2}):(\d{2})\s*UTC([+-]\d{1,2})(\d{2})?/i);
  if (!m) return `${date}T00:00:00Z`;
  const hh = +m[1], mm = +m[2], offH = +m[3], offMM = m[4] ? +m[4] : 0;
  const offsetMin = offH * 60 + (offH < 0 ? -offMM : offMM); // local = UTC + offset
  const dt = new Date(`${date}T00:00:00Z`);
  dt.setUTCMinutes(hh * 60 + mm - offsetMin); // UTC = local - offset; rollover handled
  return dt.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function mapGoals(arr, teamName) {
  return (arr || []).map((g) => {
    const name = g?.name || g?.player || null;
    const min = g?.minute != null ? parseInt(g.minute, 10) : NaN;
    return {
      team: teamName,
      player: name,
      minute: Number.isFinite(min) ? min : null,
      ownGoal: /\(o\.?g\.?\)|own[ -]?goal/i.test(name || "") || !!g?.owngoal,
      penalty: /\(pen\.?\)|penalty/i.test(name || "") || !!g?.penalty,
    };
  });
}

/** Map one openfootball match to our schema, or null if its teams aren't decided yet. */
function normalizeOpenfootball(m, teamMap, fallback, stageAliases) {
  const home = resolveTeam(m.team1, teamMap, fallback);
  const away = resolveTeam(m.team2, teamMap, fallback);
  if (!home || !away || !home.code || !away.code || !m.date) return null;

  const stage = mapStage(m.round, stageAliases);
  const ft = m.score?.ft;
  const completed = Array.isArray(ft) && ft[0] != null && ft[1] != null;
  const groupLetter = stage === "Group stage" ? String(m.group || "").match(/([a-l])\b/i)?.[1] : null;

  return {
    matchId: `${home.code}-${away.code}-${m.date}`,
    stage,
    group: groupLetter ? groupLetter.toUpperCase() : null,
    round: stage && stage !== "Group stage" ? m.round || null : null,
    kickoffUtc: parseKickoffUtc(m.date, m.time),
    status: completed ? "completed" : "scheduled",
    homeTeam: { name: home.name, code: home.code },
    awayTeam: { name: away.name, code: away.code },
    score: completed ? { home: ft[0], away: ft[1] } : null,
    goals: completed ? [...mapGoals(m.goals1, home.name), ...mapGoals(m.goals2, away.name)] : [],
    venue: m.ground || null,
    sourceUrls: [],
  };
}

async function tryOpenfootball(ctx, log) {
  let teamsJson = null;
  try {
    const tr = await fetchWithTimeout(OPENFOOTBALL_TEAMS, { headers: { Accept: "application/json" } }, 12000);
    if (tr.ok) teamsJson = await tr.json();
  } catch (err) {
    log(`  openfootball teams.json: ${err.message}`);
  }

  let matchesJson;
  try {
    const mr = await fetchWithTimeout(OPENFOOTBALL_MATCHES, { headers: { Accept: "application/json" } }, 12000);
    if (!mr.ok) {
      log(`  openfootball worldcup.json: HTTP ${mr.status}`);
      return null;
    }
    matchesJson = await mr.json();
  } catch (err) {
    log(`  openfootball worldcup.json: ${err.message}`);
    return null;
  }

  const teamMap = teamsJson ? buildTeamMap(teamsJson) : {};
  const out = [];
  let skipped = 0;
  for (const m of matchesJson.matches || []) {
    const norm = normalizeOpenfootball(m, teamMap, ctx.resolveCode, ctx.stageAliases);
    if (norm) out.push(norm);
    else skipped++;
  }
  if (out.length) {
    log(`  openfootball: ${out.length} matches with decided teams (${skipped} undecided knockout slots skipped)`);
    return out;
  }
  return null;
}

// Wikipedia fallback is intentionally a clearly-marked, isolated stub. Swap in a real parser
// here without touching the rest of the code.
async function tryWikipedia(ctx, log) {
  log("  wikipedia: fallback parser not implemented (edit scripts/utils/match-sources.mjs to add one)");
  return null;
}

/**
 * Try each source in order. Returns { ok, source, matches, error }.
 * `matches` are already in matches.json schema (minus lastUpdated, which the caller stamps).
 */
export async function fetchMatchesFromSources({ teamAliases, stageAliases, log = () => {} }) {
  const ctx = { resolveCode: makeAliasResolver(teamAliases), stageAliases };

  log("Trying source: openfootball …");
  const off = await tryOpenfootball(ctx, log);
  if (off && off.length) return { ok: true, source: "openfootball", matches: off, error: null };

  log("Trying source: wikipedia …");
  const wiki = await tryWikipedia(ctx, log);
  if (wiki && wiki.length) return { ok: true, source: "wikipedia", matches: wiki, error: null };

  return { ok: false, source: null, matches: [], error: "no source returned usable data" };
}
