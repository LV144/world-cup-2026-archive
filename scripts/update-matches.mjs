// update-matches.mjs
// Usage: npm run update-matches
//
// Refresh data/matches.json from a free, no-auth public source (see match-sources.mjs).
// Merges by stable matchId: a field is only overwritten when the source supplies a non-null
// value, so manually added fields (venue, sourceUrls, hand-entered scores) are never wiped.
// If the source is unreachable, the existing file is left untouched. Sample/placeholder
// matches are dropped only once real data is successfully fetched.

import {
  PATHS, readJson, writeJson, backupFile, nowIso,
} from "./utils/file-utils.mjs";
import { fetchMatchesFromSources } from "./utils/match-sources.mjs";

/** Merge `incoming` (from source) onto `existing` without wiping manual/non-null fields. */
function mergeMatch(existing, incoming) {
  if (!existing) return { ...incoming, lastUpdated: nowIso() };
  const merged = { ...existing };
  let changed = false;
  const overwriteIfPresent = (key) => {
    if (incoming[key] != null && JSON.stringify(incoming[key]) !== JSON.stringify(existing[key])) {
      merged[key] = incoming[key];
      changed = true;
    }
  };
  // Source-owned fields.
  ["stage", "group", "round", "kickoffUtc", "status", "homeTeam", "awayTeam", "score", "venue"].forEach(overwriteIfPresent);
  // Goals: only replace when the source actually provides a non-empty list (don't erase manual goals).
  if (Array.isArray(incoming.goals) && incoming.goals.length && JSON.stringify(incoming.goals) !== JSON.stringify(existing.goals)) {
    merged.goals = incoming.goals;
    changed = true;
  }
  // sourceUrls: union, never shrink.
  if (Array.isArray(incoming.sourceUrls) && incoming.sourceUrls.length) {
    const union = Array.from(new Set([...(existing.sourceUrls || []), ...incoming.sourceUrls]));
    if (union.length !== (existing.sourceUrls || []).length) {
      merged.sourceUrls = union;
      changed = true;
    }
  }
  if (existing.sample && changed) delete merged.sample; // real data has arrived for this row
  if (changed) merged.lastUpdated = nowIso();
  return merged;
}

async function main() {
  const [existing, teamAliases, stageAliases] = await Promise.all([
    readJson(PATHS.matches, []),
    readJson(PATHS.teamAliases, {}),
    readJson(PATHS.stageAliases, {}),
  ]);

  console.log("World Cup Archive — update-matches\n");

  const result = await fetchMatchesFromSources({
    teamAliases,
    stageAliases,
    log: (m) => console.log(m),
  });

  if (!result.ok) {
    console.log(`\n⚠ No source returned usable data (${result.error}).`);
    console.log("  matches.json left untouched. You can edit it by hand, or extend");
    console.log("  scripts/utils/match-sources.mjs to add/repair a source parser.");
    return; // graceful: exit 0, file untouched
  }

  console.log(`\nSource: ${result.source} — ${result.matches.length} matches fetched.\n`);

  const byId = new Map(existing.map((m) => [m.matchId, m]));
  const incomingIds = new Set(result.matches.map((m) => m.matchId));
  const summary = { added: [], updated: [] };

  for (const inc of result.matches) {
    const prev = byId.get(inc.matchId);
    const merged = mergeMatch(prev, inc);
    if (!prev) summary.added.push(merged.matchId);
    else if (merged.lastUpdated !== prev.lastUpdated) summary.updated.push(merged.matchId);
    byId.set(inc.matchId, merged);
  }

  // Drop leftover sample/placeholder rows now that real data exists.
  const droppedSamples = [];
  for (const [id, m] of byId) {
    if (m.sample && !incomingIds.has(id)) {
      droppedSamples.push(id);
      byId.delete(id);
    }
  }

  const out = [...byId.values()].sort((a, b) => String(a.kickoffUtc).localeCompare(String(b.kickoffUtc)));

  await backupFile(PATHS.matches);
  await writeJson(PATHS.matches, out);

  console.log(`  added:   ${summary.added.length}${summary.added.length ? " — " + summary.added.join(", ") : ""}`);
  console.log(`  updated: ${summary.updated.length}${summary.updated.length ? " — " + summary.updated.join(", ") : ""}`);
  if (droppedSamples.length) console.log(`  removed sample placeholders: ${droppedSamples.join(", ")}`);
  console.log(`  total matches now: ${out.length}`);
  console.log(`\n  Next: run \`npm run enrich\` to refresh archived items with new scores/stages.`);
}

main().catch((err) => {
  console.error("Fatal error (matches.json left untouched):", err);
  process.exit(1);
});
