// match-inference.mjs
// Pure football-metadata inference. No I/O. Reused by add-links.mjs and enrich-items.mjs.
//
// Guiding rule (from the spec): DO NOT INVENT FACTS. We only ever copy scores/goals/stages
// from matches.json. Text is used to *identify which match* a link is about, never to
// fabricate a result. When identification is uncertain we set matchId=null, fill
// candidateMatches, and flag needsReview.

export const CANONICAL_STAGES = [
  "Group stage",
  "Round of 32",
  "Round of 16",
  "Quarter-finals",
  "Semi-finals",
  "Third-place play-off",
  "Final",
];

// At/above this match-confidence we commit a matchId; below it we keep candidates only.
const LINK_THRESHOLD = 0.8;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Build lookup indexes once, then pass to inferMatch().
 * @param {Array} matches      data/matches.json
 * @param {Object} teamAliases data/team-aliases.json
 * @param {Object} stageAliases data/stage-aliases.json
 */
export function buildIndexes(matches, teamAliases, stageAliases) {
  const aliasList = []; // { canonical, code, aliasLower }
  const codeToCanonical = {};
  const canonicalToCode = {};

  for (const [canonical, info] of Object.entries(teamAliases || {})) {
    const code = info?.code || null;
    if (code) {
      codeToCanonical[code.toUpperCase()] = canonical;
      canonicalToCode[canonical] = code;
    }
    const aliases = new Set([canonical, ...(info?.aliases || [])]);
    for (const a of aliases) {
      if (a) aliasList.push({ canonical, code, aliasLower: String(a).toLowerCase() });
    }
  }
  // Longer aliases first so "South Korea" wins over "Korea".
  aliasList.sort((a, b) => b.aliasLower.length - a.aliasLower.length);

  const stageList = [];
  for (const [canonical, aliases] of Object.entries(stageAliases || {})) {
    for (const a of aliases) stageList.push({ canonical, aliasLower: String(a).toLowerCase() });
  }
  stageList.sort((a, b) => b.aliasLower.length - a.aliasLower.length);

  const resolveTeam = (nameOrCode) => {
    if (!nameOrCode) return null;
    const s = String(nameOrCode).trim();
    if (teamAliases?.[s]) return s; // already canonical
    if (codeToCanonical[s.toUpperCase()]) return codeToCanonical[s.toUpperCase()];
    const lower = s.toLowerCase();
    const hit = aliasList.find((a) => a.aliasLower === lower);
    return hit ? hit.canonical : s; // fall back to the raw name
  };

  // Augment matches with resolved participant set for quick pairing.
  const matchesById = {};
  const augmented = (matches || []).map((m) => {
    const homeName = m.homeTeam?.name || null;
    const awayName = m.awayTeam?.name || null;
    const participants = new Set([resolveTeam(homeName), resolveTeam(awayName)].filter(Boolean));
    const aug = { ...m, _participants: participants };
    if (m.matchId) matchesById[m.matchId] = m;
    return aug;
  });

  return { aliasList, codeToCanonical, canonicalToCode, stageList, matches: augmented, matchesById, resolveTeam };
}

/** Find canonical teams mentioned in `text`, with the index of first mention (for ordering). */
function detectTeams(text, rawText, idx) {
  const found = new Map(); // canonical -> first index
  const lower = text.toLowerCase();

  for (const { canonical, aliasLower } of idx.aliasList) {
    if (found.has(canonical)) continue;
    // Word-boundary-ish search (handles punctuation around the alias).
    const re = new RegExp(`(?:^|[^a-z0-9])${escapeRe(aliasLower)}(?:[^a-z0-9]|$)`, "i");
    const m = re.exec(lower);
    if (m) found.set(canonical, m.index);
  }

  // FIFA codes: match only as standalone UPPERCASE tokens to avoid "CAN"/"can" noise.
  for (const [code, canonical] of Object.entries(idx.codeToCanonical)) {
    if (found.has(canonical)) continue;
    const re = new RegExp(`\\b${escapeRe(code)}\\b`);
    const m = re.exec(rawText); // case-sensitive against original text
    if (m) found.set(canonical, m.index);
  }

  return [...found.entries()].sort((a, b) => a[1] - b[1]).map(([canonical]) => canonical);
}

/** Detect an explicit "A vs B" ordering between the first two detected teams. */
function detectExplicitOrder(text, orderedTeams, idx) {
  if (orderedTeams.length < 2) return null;
  const lower = text.toLowerCase();
  const posOf = (canonical) => {
    for (const { canonical: c, aliasLower } of idx.aliasList) {
      if (c !== canonical) continue;
      const i = lower.indexOf(aliasLower);
      if (i >= 0) return { start: i, end: i + aliasLower.length };
    }
    return null;
  };
  const a = posOf(orderedTeams[0]);
  const b = posOf(orderedTeams[1]);
  if (!a || !b) return null;
  const [first, second] = a.start <= b.start ? [orderedTeams[0], orderedTeams[1]] : [orderedTeams[1], orderedTeams[0]];
  const lo = Math.min(a.end, b.end);
  const hi = Math.max(a.start, b.start);
  const between = lower.slice(lo, hi);
  if (/\b(vs?|x)\b|[-–—@]|\d+\s*[-–—:]\s*\d+/.test(between)) {
    return { home: first, away: second };
  }
  return null;
}

function detectStage(text, idx) {
  const lower = text.toLowerCase();
  for (const { canonical, aliasLower } of idx.stageList) {
    const re = new RegExp(`(?:^|[^a-z0-9])${escapeRe(aliasLower)}(?:[^a-z0-9]|$)`, "i");
    if (re.test(lower)) return canonical;
  }
  return null;
}

function detectGroup(text) {
  const m = text.match(/\bgroup\s+([a-l])\b/i);
  return m ? m[1].toUpperCase() : null;
}

function detectDate(...sources) {
  for (const s of sources) {
    if (!s) continue;
    const m = String(s).match(/(20\d{2})[-/](\d{1,2})[-/](\d{1,2})/);
    if (m) {
      const [, y, mo, d] = m;
      return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
  }
  return null;
}

const dateOnly = (iso) => (iso ? String(iso).slice(0, 10) : null);

function withinOneDay(a, b) {
  if (!a || !b) return false;
  const da = new Date(a + "T00:00:00Z").getTime();
  const db = new Date(b + "T00:00:00Z").getTime();
  return Math.abs(da - db) <= 24 * 3600 * 1000;
}

export function matchLabelFor(match) {
  const h = match.homeTeam?.name || "?";
  const a = match.awayTeam?.name || "?";
  return `${h} vs ${a}`;
}

export function scoreLabelFor(match) {
  if (!match || match.status !== "completed" || !match.score) return null;
  const { home, away } = match.score;
  if (home == null || away == null) return null;
  return `${match.homeTeam?.name} ${home}–${away} ${match.awayTeam?.name}`; // en dash U+2013
}

/** Authoritative field set derived from a linked match (used by add + enrich). */
export function fieldsFromMatch(match, idx) {
  const teams = [match.homeTeam?.name, match.awayTeam?.name].filter(Boolean);
  const teamCodes = [match.homeTeam?.code, match.awayTeam?.code].filter(Boolean);
  return {
    matchId: match.matchId,
    matchLabel: matchLabelFor(match),
    stage: CANONICAL_STAGES.includes(match.stage) ? match.stage : null,
    group: match.group || null,
    teams,
    teamCodes,
    scoreLabel: scoreLabelFor(match),
    goals: match.status === "completed" && Array.isArray(match.goals) ? match.goals : [],
  };
}

function candidateFrom(match, confidence, reason) {
  return {
    matchId: match.matchId,
    matchLabel: matchLabelFor(match),
    stage: match.stage || null,
    group: match.group || null,
    kickoffUtc: match.kickoffUtc || null,
    confidence: Number(confidence.toFixed(2)),
    reason,
  };
}

/**
 * Infer football metadata for a link.
 * @returns full set of inferred fields + metadataConfidence + needsReview.
 */
export function inferMatch(signals, idx) {
  const title = signals.title || "";
  const ogTitle = signals.ogTitle || "";
  const description = signals.description || "";
  const url = signals.url || "";
  const subreddit = signals.subreddit || "";
  const dateSaved = signals.dateSaved || "";

  const text = [title, ogTitle, description, subreddit].filter(Boolean).join("  ·  ");
  const rawText = [title, ogTitle, description].filter(Boolean).join("  ");

  const base = {
    matchId: null,
    matchLabel: null,
    stage: null,
    group: null,
    teams: [],
    teamCodes: [],
    scoreLabel: null,
    goals: [],
    candidateMatches: [],
    metadataConfidence: { match: 0, teams: 0, stage: 0, score: 0 },
    needsReview: false,
  };

  const teamsDetected = detectTeams(text, rawText, idx);
  const explicit = detectExplicitOrder(text, teamsDetected, idx);
  const stageDetected = detectStage(text, idx);
  const groupDetected = detectGroup(text);
  const dateDetected = detectDate(url, text) || dateOnly(dateSaved);

  // Soft stage/group from text (only used when no authoritative match is linked).
  if (stageDetected) {
    base.stage = stageDetected;
    base.metadataConfidence.stage = 0.7;
  }
  if (groupDetected) base.group = groupDetected;

  const linkMatch = (match, confidence, _reason) => {
    Object.assign(base, fieldsFromMatch(match, idx));
    base.metadataConfidence.match = confidence;
    base.metadataConfidence.teams = 1.0;
    base.metadataConfidence.stage = 1.0;
    base.metadataConfidence.score = 1.0; // we know the score state (known or "not yet")
    base.candidateMatches = [];
  };

  // ---- Two or more teams detected ----
  if (teamsDetected.length >= 2) {
    const detectedSet = new Set(teamsDetected);
    const pairMatches = idx.matches.filter((m) => {
      const p = [...m._participants];
      return p.length === 2 && p.every((t) => detectedSet.has(t));
    });

    if (pairMatches.length === 1) {
      const reason = explicit ? "explicit match label + both teams" : "both teams form a unique fixture";
      linkMatch(pairMatches[0], 1.0, reason);
    } else if (pairMatches.length > 1) {
      // Two teams that meet more than once (e.g. group + knockout). Disambiguate with
      // stage/group/date, only applying a filter when it leaves at least one candidate.
      let narrowed = pairMatches;
      const refine = (pred) => {
        const next = narrowed.filter(pred);
        if (next.length) narrowed = next;
      };
      if (stageDetected) refine((m) => m.stage === stageDetected);
      if (narrowed.length > 1 && groupDetected) refine((m) => m.group === groupDetected);
      if (narrowed.length > 1 && dateDetected) refine((m) => withinOneDay(dateOnly(m.kickoffUtc), dateDetected));
      if (narrowed.length === 1) {
        linkMatch(narrowed[0], 0.9, "both teams + stage/date disambiguation");
      } else {
        base.candidateMatches = pairMatches.map((m) => candidateFrom(m, 0.7, "both teams match this fixture; multiple possible"));
        base.metadataConfidence.match = 0.7;
        base.metadataConfidence.teams = 0.9;
      }
    } else {
      // Teams known but no fixture in matches.json (e.g. unscheduled knockout, or DB incomplete).
      const two = teamsDetected.slice(0, 2);
      base.teams = explicit ? [explicit.home, explicit.away] : two;
      base.teamCodes = base.teams.map((t) => idx.canonicalToCode[t]).filter(Boolean);
      base.metadataConfidence.teams = 0.6;
      base.metadataConfidence.match = 0.0;
    }
  }
  // ---- Exactly one team detected ----
  else if (teamsDetected.length === 1) {
    const team = teamsDetected[0];
    base.teams = [team];
    base.teamCodes = [idx.canonicalToCode[team]].filter(Boolean);
    base.metadataConfidence.teams = 0.5;

    const teamMatches = idx.matches.filter((m) => m._participants.has(team));
    let narrowed = teamMatches;
    let corroborated = false; // did a date/stage signal actually filter the set?
    if (dateDetected) {
      const byDate = teamMatches.filter((m) => withinOneDay(dateOnly(m.kickoffUtc), dateDetected));
      if (byDate.length) { narrowed = byDate; corroborated = true; }
    }
    if (stageDetected) {
      const byStage = narrowed.filter((m) => m.stage === stageDetected);
      if (byStage.length) { narrowed = byStage; corroborated = true; }
    }

    if (narrowed.length === 1 && corroborated) {
      // One team + a signal that genuinely narrows to a single fixture: strong candidate.
      // Per the rules we still do not force a single-team link — keep it a candidate to review.
      base.candidateMatches = [candidateFrom(narrowed[0], 0.6, "one team + date/stage narrows to one fixture")];
      base.metadataConfidence.match = 0.6;
    } else if (narrowed.length >= 1) {
      base.candidateMatches = narrowed
        .slice(0, 8)
        .map((m) => candidateFrom(m, 0.4, "one team mentioned; multiple possible fixtures"));
      base.metadataConfidence.match = 0.4;
    } else {
      base.metadataConfidence.match = 0.0;
    }
  }

  // ---- needsReview ----
  const hasFootballSignal = teamsDetected.length >= 1 || !!stageDetected || !!groupDetected;
  let needsReview = false;
  if (!title) needsReview = true; // missing core metadata
  if (base.matchId && base.metadataConfidence.match < LINK_THRESHOLD) needsReview = true;
  if (!base.matchId && hasFootballSignal) needsReview = true; // looks football-related but unresolved
  if (base.candidateMatches.length > 0) needsReview = true;
  base.needsReview = needsReview;

  return base;
}
