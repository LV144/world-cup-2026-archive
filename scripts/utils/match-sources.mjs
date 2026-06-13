// match-sources.mjs
// Isolated, swappable adapters that fetch WC 2026 fixtures/results from free, no-auth
// public sources and return them already mapped to OUR matches.json schema.
//
// Primary  : openfootball (community-maintained structured JSON on GitHub) — no scraping.
// Fallback : Wikipedia fixture tables (HTML scrape; fragile, isolated, easy to fix/replace).
//
// If every adapter fails, fetchMatchesFromSources() returns { ok:false } and the caller
// leaves matches.json untouched. Keeping each parser in its own function means a broken
// source is a one-function fix, not a rewrite.

import { fetchWithTimeout } from "./fetch-metadata.mjs";
import { CANONICAL_STAGES } from "./match-inference.mjs";

// openfootball naming has drifted across tournaments/repos, so try a few known shapes.
const OPENFOOTBALL_CANDIDATES = [
  "https://raw.githubusercontent.com/openfootball/world-cup.json/master/2026/worldcup.json",
  "https://raw.githubusercontent.com/openfootball/world-cup.json/master/2026--north-america/worldcup.json",
  "https://raw.githubusercontent.com/openfootball/football.json/master/2026-world-cup/worldcup.json",
];

function mapStage(roundName, stageAliases) {
  if (!roundName) return null;
  const lower = String(roundName).toLowerCase();
  for (const [canonical, aliases] of Object.entries(stageAliases || {})) {
    if (aliases.some((a) => lower.includes(String(a).toLowerCase()))) return canonical;
  }
  if (/matchday|group/.test(lower)) return "Group stage";
  return CANONICAL_STAGES.includes(roundName) ? roundName : null;
}

function makeCodeResolver(teamAliases) {
  const byAlias = {};
  for (const [canonical, info] of Object.entries(teamAliases || {})) {
    if (info?.code) {
      byAlias[canonical.toLowerCase()] = { name: canonical, code: info.code };
      byAlias[info.code.toLowerCase()] = { name: canonical, code: info.code };
    }
    for (const a of info?.aliases || []) byAlias[String(a).toLowerCase()] = { name: canonical, code: info?.code || null };
  }
  return (rawName, rawCode) => {
    const hit = byAlias[String(rawName || "").toLowerCase()] || (rawCode && byAlias[String(rawCode).toLowerCase()]);
    if (hit) return { name: hit.name, code: hit.code || rawCode || null };
    const fallbackCode = rawCode || String(rawName || "").replace(/[^a-z]/gi, "").slice(0, 3).toUpperCase() || null;
    return { name: rawName || null, code: fallbackCode };
  };
}

/** Turn one openfootball match row into our schema. */
function normalizeOpenfootball(raw, roundName, ctx) {
  const home = ctx.resolveCode(raw.team1?.name || raw.team1, raw.team1?.code);
  const away = ctx.resolveCode(raw.team2?.name || raw.team2, raw.team2?.code);
  const date = raw.date || null;
  if (!home.name || !away.name || !date) return null;

  const time = raw.time && /^\d{1,2}:\d{2}$/.test(raw.time) ? raw.time : null;
  const kickoffUtc = `${date}T${time ? time + ":00" : "00:00:00"}Z`;

  const ft = raw.score?.ft || raw.score1 != null && [raw.score1, raw.score2] || null;
  let score = null;
  let status = "scheduled";
  let goals = [];
  if (Array.isArray(ft) && ft[0] != null && ft[1] != null) {
    score = { home: Number(ft[0]), away: Number(ft[1]) };
    status = "completed";
    // openfootball sometimes carries goal events; copy only what's actually present.
    if (Array.isArray(raw.goals1) || Array.isArray(raw.goals2)) {
      const mk = (g, teamName) => ({
        team: teamName,
        player: g.name || g.player || null,
        minute: g.minute != null ? Number(g.minute) : null,
        ownGoal: !!g.owngoal,
        penalty: !!g.penalty,
      });
      goals = [...(raw.goals1 || []).map((g) => mk(g, home.name)), ...(raw.goals2 || []).map((g) => mk(g, away.name))];
    }
  }

  const stage = mapStage(roundName, ctx.stageAliases);
  const groupMatch = String(roundName || "").match(/group\s+([a-l])/i) || String(raw.group || "").match(/([a-l])/i);

  return {
    matchId: `${home.code}-${away.code}-${date}`,
    stage,
    group: stage === "Group stage" && groupMatch ? groupMatch[1].toUpperCase() : null,
    round: stage && stage !== "Group stage" ? roundName || null : null,
    kickoffUtc,
    status,
    homeTeam: { name: home.name, code: home.code },
    awayTeam: { name: away.name, code: away.code },
    score,
    goals,
    venue: raw.stadium?.name || raw.city || null,
    sourceUrls: [],
  };
}

async function tryOpenfootball(ctx, log) {
  for (const url of OPENFOOTBALL_CANDIDATES) {
    try {
      const res = await fetchWithTimeout(url, { headers: { Accept: "application/json" } }, 12000);
      if (!res.ok) continue;
      const data = await res.json();
      const rounds = data.rounds || [];
      const out = [];
      for (const round of rounds) {
        for (const m of round.matches || []) {
          const norm = normalizeOpenfootball(m, round.name, ctx);
          if (norm) out.push(norm);
        }
      }
      if (out.length) {
        log(`  openfootball: parsed ${out.length} matches from ${url}`);
        return out;
      }
    } catch (err) {
      log(`  openfootball: ${url} -> ${err.message}`);
    }
  }
  return null;
}

// Wikipedia fallback is intentionally a clearly-marked, isolated stub. Wikipedia's fixture
// markup changes often; rather than ship a brittle parser that silently produces wrong data
// (violating "do not invent facts"), we return null and tell the user to extend this function
// or edit matches.json by hand. Swap in a real parser here without touching the rest of the code.
async function tryWikipedia(ctx, log) {
  log("  wikipedia: fallback parser not implemented (edit scripts/utils/match-sources.mjs to add one)");
  return null;
}

/**
 * Try each source in order. Returns { ok, source, matches, error }.
 * `matches` are already in matches.json schema (minus lastUpdated, which the caller stamps).
 */
export async function fetchMatchesFromSources({ teamAliases, stageAliases, log = () => {} }) {
  const ctx = { resolveCode: makeCodeResolver(teamAliases), stageAliases };

  log("Trying source: openfootball …");
  const off = await tryOpenfootball(ctx, log);
  if (off && off.length) return { ok: true, source: "openfootball", matches: off, error: null };

  log("Trying source: wikipedia …");
  const wiki = await tryWikipedia(ctx, log);
  if (wiki && wiki.length) return { ok: true, source: "wikipedia", matches: wiki, error: null };

  return { ok: false, source: null, matches: [], error: "no source returned usable data" };
}
