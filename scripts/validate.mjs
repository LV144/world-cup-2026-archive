// validate.mjs
// Usage: npm run validate
//
// Integrity checks across the data files. Errors -> exit 1; warnings -> exit 0.

import {
  PATHS, validateJsonFile, readJson,
} from "./utils/file-utils.mjs";
import { CANONICAL_STAGES } from "./utils/match-inference.mjs";
import { normalizeUrl } from "./utils/normalize-url.mjs";

const LINK_THRESHOLD = 0.8;
const REQUIRED_ITEM_FIELDS = ["id", "title", "url", "dateSaved", "metadataConfidence", "needsReview"];
const ITEM_ARRAY_FIELDS = ["teams", "teamCodes", "tags", "type", "goals", "candidateMatches"];
const REQUIRED_MATCH_FIELDS = ["matchId", "stage", "status", "kickoffUtc", "homeTeam", "awayTeam"];

async function main() {
  const errors = [];
  const warnings = [];
  const e = (m) => errors.push(m);
  const w = (m) => warnings.push(m);

  // ---- 1. JSON validity ----
  const files = [
    ["items.json", PATHS.items],
    ["matches.json", PATHS.matches],
    ["team-aliases.json", PATHS.teamAliases],
    ["stage-aliases.json", PATHS.stageAliases],
  ];
  for (const [label, p] of files) {
    const r = await validateJsonFile(p);
    if (!r.ok) e(`${label}: invalid JSON — ${r.error}`);
  }
  if (errors.length) return report(errors, warnings); // can't continue without valid JSON

  const items = await readJson(PATHS.items, []);
  const matches = await readJson(PATHS.matches, []);

  if (!Array.isArray(items)) e("items.json: root must be an array");
  if (!Array.isArray(matches)) e("matches.json: root must be an array");
  if (errors.length) return report(errors, warnings);

  const matchIds = new Set(matches.map((m) => m.matchId));

  // ---- 2. Matches ----
  for (const [i, m] of matches.entries()) {
    const where = `matches[${i}] (${m.matchId || "no id"})`;
    for (const f of REQUIRED_MATCH_FIELDS) if (m[f] == null) e(`${where}: missing required field "${f}"`);
    if (m.stage != null && !CANONICAL_STAGES.includes(m.stage)) e(`${where}: non-canonical stage "${m.stage}"`);
    if (m.homeTeam && (!m.homeTeam.name || !m.homeTeam.code)) w(`${where}: homeTeam missing name/code`);
    if (m.awayTeam && (!m.awayTeam.name || !m.awayTeam.code)) w(`${where}: awayTeam missing name/code`);
    if (m.status === "completed" && (!m.score || m.score.home == null || m.score.away == null)) {
      w(`${where}: status is "completed" but has no score`);
    }
    if (m.status === "scheduled" && m.score) w(`${where}: status is "scheduled" but a score is set`);
    if (!Array.isArray(m.goals)) e(`${where}: "goals" must be an array`);
  }
  const dupMatchIds = matches.map((m) => m.matchId).filter((id, i, arr) => id && arr.indexOf(id) !== i);
  for (const id of new Set(dupMatchIds)) e(`matches.json: duplicate matchId "${id}"`);

  // ---- 3. Items ----
  const urlSeen = new Map();
  for (const [i, it] of items.entries()) {
    const where = `items[${i}] (${it.id || it.url || "?"})`;
    for (const f of REQUIRED_ITEM_FIELDS) if (it[f] == null) e(`${where}: missing required field "${f}"`);
    for (const f of ITEM_ARRAY_FIELDS) if (it[f] != null && !Array.isArray(it[f])) e(`${where}: "${f}" must be an array`);

    // Duplicate url / canonicalUrl (compare on normalized variants).
    for (const u of [it.url, it.canonicalUrl]) {
      if (!u) continue;
      const n = normalizeUrl(u);
      const keys = n.ok ? n.variants : [u];
      for (const k of keys) {
        if (urlSeen.has(k) && urlSeen.get(k) !== it.id) e(`${where}: duplicate URL of ${urlSeen.get(k)} (${k})`);
        else urlSeen.set(k, it.id);
      }
    }

    // matchId must exist.
    if (it.matchId != null && !matchIds.has(it.matchId)) e(`${where}: matchId "${it.matchId}" not found in matches.json`);

    // Canonical stage.
    if (it.stage != null && !CANONICAL_STAGES.includes(it.stage)) e(`${where}: non-canonical stage "${it.stage}"`);

    // needsReview must reflect low confidence / unresolved football signals.
    const conf = it.metadataConfidence || {};
    const shouldReview =
      (Array.isArray(it.candidateMatches) && it.candidateMatches.length > 0) ||
      (it.matchId && typeof conf.match === "number" && conf.match < LINK_THRESHOLD) ||
      (!it.matchId && Array.isArray(it.teams) && it.teams.length > 0) ||
      !it.title;
    if (shouldReview && it.needsReview !== true) {
      e(`${where}: low/uncertain confidence but needsReview is not true`);
    }

    // scoreLabel only when a fixture is linked.
    if (it.scoreLabel && !it.matchId) w(`${where}: has scoreLabel but no matchId`);
  }

  report(errors, warnings);
}

function report(errors, warnings) {
  console.log("World Cup Archive — validate\n");
  if (warnings.length) {
    console.log(`Warnings (${warnings.length}):`);
    for (const m of warnings) console.log(`  ⚠ ${m}`);
    console.log("");
  }
  if (errors.length) {
    console.log(`Errors (${errors.length}):`);
    for (const m of errors) console.log(`  ✗ ${m}`);
    console.log("\nValidation FAILED.");
    process.exit(1);
  }
  console.log(`✓ Validation passed${warnings.length ? ` with ${warnings.length} warning(s)` : ""}.`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
