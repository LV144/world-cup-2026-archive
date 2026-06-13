// enrich-items.mjs
// Usage: npm run enrich
//
// Re-run football enrichment over existing items after matches.json has been updated
// (e.g. matches finished, scores arrived). Two behaviours:
//   • items WITH a known matchId  -> refresh match-derived fields from matches.json.
//   • items WITHOUT a matchId     -> retry inference; only apply if it now resolves a fixture.
// Manual fields (type, tags, importance, note, backup) are NEVER touched. Web-metadata
// fields (title, url, source, thumbnails, dateSaved) are left as-is.

import {
  PATHS, readJson, writeJson, backupFile,
} from "./utils/file-utils.mjs";
import { buildIndexes, inferMatch, fieldsFromMatch } from "./utils/match-inference.mjs";

const LINK_THRESHOLD = 0.8;

function subredditFromItem(item) {
  if (item.sourceDetail && item.sourceDetail.startsWith("r/")) return item.sourceDetail.slice(2);
  const tag = (item.tags || []).find((t) => typeof t === "string" && t.startsWith("r/"));
  return tag ? tag.slice(2) : null;
}

/** Apply an authoritative match field set to an item; returns whether anything changed. */
function applyMatchFields(item, match) {
  const f = fieldsFromMatch(match);
  const before = JSON.stringify([item.matchId, item.matchLabel, item.stage, item.group, item.teams, item.teamCodes, item.scoreLabel, item.goals]);
  item.matchId = f.matchId;
  item.matchLabel = f.matchLabel;
  item.stage = f.stage;
  item.group = f.group;
  item.teams = f.teams;
  item.teamCodes = f.teamCodes;
  item.scoreLabel = f.scoreLabel;
  item.goals = f.goals;
  item.candidateMatches = [];
  item.metadataConfidence = { ...item.metadataConfidence, match: 1.0, teams: 1.0, stage: 1.0, score: 1.0 };
  item.needsReview = !item.title; // resolved fixture; only flag if core metadata missing
  const after = JSON.stringify([item.matchId, item.matchLabel, item.stage, item.group, item.teams, item.teamCodes, item.scoreLabel, item.goals]);
  return before !== after;
}

async function main() {
  const [items, matches, teamAliases, stageAliases] = await Promise.all([
    readJson(PATHS.items, []),
    readJson(PATHS.matches, []),
    readJson(PATHS.teamAliases, {}),
    readJson(PATHS.stageAliases, {}),
  ]);
  const idx = buildIndexes(matches, teamAliases, stageAliases);

  const updated = [];
  const newlyLinked = [];
  const dangling = [];

  for (const item of items) {
    if (item.matchId) {
      const match = idx.matchesById[item.matchId];
      if (match) {
        if (applyMatchFields(item, match)) updated.push(item.id);
      } else {
        // Referenced match no longer exists — keep the id but flag for review.
        item.needsReview = true;
        dangling.push(item.id);
      }
      continue;
    }

    // No matchId: retry inference; only commit if it now resolves to a fixture.
    const inferred = inferMatch(
      {
        title: item.title,
        ogTitle: item.title,
        description: item.description,
        url: item.url,
        subreddit: subredditFromItem(item),
        dateSaved: item.dateSaved,
      },
      idx,
    );
    if (inferred.matchId && inferred.metadataConfidence.match >= LINK_THRESHOLD) {
      const match = idx.matchesById[inferred.matchId];
      if (match && applyMatchFields(item, match)) {
        updated.push(item.id);
        newlyLinked.push(item.id);
      }
    }
    // Otherwise leave the item untouched (preserve any manual football edits).
  }

  if (updated.length || dangling.length) {
    await backupFile(PATHS.items);
    await writeJson(PATHS.items, items);
  }

  console.log("World Cup Archive — enrich-items\n");
  console.log(`  items:        ${items.length}`);
  console.log(`  updated:      ${updated.length}${updated.length ? " — " + updated.join(", ") : ""}`);
  console.log(`  newly linked: ${newlyLinked.length}${newlyLinked.length ? " — " + newlyLinked.join(", ") : ""}`);
  if (dangling.length) console.log(`  ⚠ dangling matchId (not in matches.json): ${dangling.join(", ")}`);
  if (!updated.length && !dangling.length) console.log("\n  Nothing to update.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
