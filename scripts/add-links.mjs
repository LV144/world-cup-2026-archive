// add-links.mjs
// Usage: npm run add -- <url1> <url2> ...
//
// For each URL: normalize, skip duplicates, fetch web metadata (Reddit handled specially),
// download a local thumbnail when possible, infer football metadata, and append a fully
// schema'd item to data/items.json. One bad URL never aborts the batch; partial success is
// always preserved and the written file is re-validated as JSON.

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  PATHS, THUMBS_DIR, readJson, writeJson, backupFile, validateJsonFile,
  ensureDir, makeId, nowIso,
} from "./utils/file-utils.mjs";
import { normalizeUrl } from "./utils/normalize-url.mjs";
import { fetchMetadata } from "./utils/fetch-metadata.mjs";
import { fetchRedditMetadata, isRedditUrl } from "./utils/reddit-metadata.mjs";
import { buildIndexes, inferMatch } from "./utils/match-inference.mjs";
import { fetchWithTimeout } from "./utils/fetch-metadata.mjs";

const EXT_BY_TYPE = {
  "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/gif": "gif",
  "image/webp": "webp", "image/avif": "avif", "image/svg+xml": "svg",
};

/** Collect every comparison key (url, canonicalUrl, variants) for an existing item. */
function keysForItem(item) {
  const keys = new Set();
  for (const u of [item.url, item.canonicalUrl]) {
    if (!u) continue;
    const n = normalizeUrl(u);
    if (n.ok) n.variants.forEach((v) => keys.add(v));
    else keys.add(u);
  }
  return keys;
}

/** Best-effort thumbnail download. Returns a repo-relative path or null. Never throws. */
async function downloadThumbnail(imageUrl, id) {
  if (!imageUrl || imageUrl.startsWith("data:")) return null; // skip placeholders / inline svg
  try {
    const res = await fetchWithTimeout(imageUrl, {}, 12000);
    if (!res.ok) return null;
    const type = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!type.startsWith("image/")) return null;
    const ext = EXT_BY_TYPE[type] || "img";
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > 8 * 1024 * 1024) return null; // skip empty / >8MB
    await ensureDir(THUMBS_DIR);
    const filename = `${id}.${ext}`;
    await fs.writeFile(path.join(THUMBS_DIR, filename), buf);
    return `assets/thumbs/${filename}`;
  } catch {
    return null;
  }
}

function buildItem({ norm, meta, inferred, id }) {
  const tags = [];
  if (meta.subreddit) tags.push(`r/${meta.subreddit}`);
  return {
    id,
    title: meta.title || norm.original,
    url: norm.normalized,
    canonicalUrl: meta.canonicalUrl || null,
    source: meta.source || null,
    sourceDetail: meta.subreddit ? `r/${meta.subreddit}` : null,
    description: meta.description || null,
    thumbnailRemoteUrl: meta.image || null,
    thumbnailLocalPath: inferred._thumbLocal || null,
    dateSaved: nowIso(),

    matchId: inferred.matchId,
    matchLabel: inferred.matchLabel,
    stage: inferred.stage,
    group: inferred.group,
    teams: inferred.teams,
    teamCodes: inferred.teamCodes,
    scoreLabel: inferred.scoreLabel,
    goals: inferred.goals,

    candidateMatches: inferred.candidateMatches,

    type: [],
    tags,
    importance: null,
    note: "",
    backup: "",

    metadataConfidence: inferred.metadataConfidence,
    needsReview: inferred.needsReview,
  };
}

async function main() {
  const urls = process.argv.slice(2).filter(Boolean);
  if (!urls.length) {
    console.error("Usage: npm run add -- <url1> <url2> ...");
    process.exit(1);
  }

  const [items, matches, teamAliases, stageAliases] = await Promise.all([
    readJson(PATHS.items, []),
    readJson(PATHS.matches, []),
    readJson(PATHS.teamAliases, {}),
    readJson(PATHS.stageAliases, {}),
  ]);
  const idx = buildIndexes(matches, teamAliases, stageAliases);

  // Existing keys for duplicate detection (extended as we add within the batch).
  const seen = new Map(); // key -> item id/url
  for (const it of items) for (const k of keysForItem(it)) seen.set(k, it.id || it.url);

  const added = [];
  const skipped = [];
  const failed = [];

  for (const rawUrl of urls) {
    try {
      const norm = normalizeUrl(rawUrl);
      if (!norm.ok) {
        failed.push({ url: rawUrl, reason: "could not parse URL" });
        continue;
      }

      const dupKey = norm.variants.find((v) => seen.has(v));
      if (dupKey) {
        skipped.push({ url: rawUrl, reason: `duplicate of existing item (${seen.get(dupKey)})` });
        continue;
      }

      // Fetch metadata (Reddit gets the special cascade).
      const meta = isRedditUrl(norm.normalized)
        ? await fetchRedditMetadata(norm.normalized)
        : await fetchMetadata(norm.normalized);

      const id = makeId(norm.normalized);

      // Thumbnail (best effort; failure never blocks the item).
      const thumbLocal = await downloadThumbnail(meta.image, id);

      // Football inference.
      const inferred = inferMatch(
        {
          title: meta.title,
          ogTitle: meta.title,
          description: meta.description,
          url: norm.normalized,
          subreddit: meta.subreddit,
          dateSaved: nowIso(),
        },
        idx,
      );
      inferred._thumbLocal = thumbLocal;

      const item = buildItem({ norm, meta, inferred, id });
      items.push(item);
      for (const k of keysForItem(item)) seen.set(k, item.id);

      added.push({ item, meta });
    } catch (err) {
      failed.push({ url: rawUrl, reason: err.message });
    }
  }

  // Persist (backup first, then atomic write, then re-validate).
  if (added.length) {
    await backupFile(PATHS.items);
    await writeJson(PATHS.items, items);
    const check = await validateJsonFile(PATHS.items);
    if (!check.ok) {
      console.error(`\n✗ items.json failed JSON validation after write: ${check.error}`);
      console.error("  A backup is at data/items.json.bak");
      process.exit(1);
    }
  }

  // ---- Summary ----
  console.log(`\nWorld Cup Archive — add-links`);
  console.log(`  added:   ${added.length}`);
  console.log(`  skipped: ${skipped.length}`);
  console.log(`  failed:  ${failed.length}\n`);

  for (const { item, meta } of added) {
    console.log(`+ ${item.title}`);
    console.log(`    url:    ${item.url}`);
    console.log(`    source: ${item.source || "?"}${item.sourceDetail ? " · " + item.sourceDetail : ""}`);
    if (item.matchId) {
      console.log(`    match:  ${item.matchLabel} [${item.matchId}]${item.scoreLabel ? " — " + item.scoreLabel : ""}`);
      console.log(`    stage:  ${item.stage || "?"}${item.group ? " (Group " + item.group + ")" : ""}`);
    } else if (item.candidateMatches.length) {
      console.log(`    match:  uncertain — ${item.candidateMatches.length} candidate(s): ${item.candidateMatches.map((c) => c.matchLabel).join(", ")}`);
    } else if (item.teams.length) {
      console.log(`    teams:  ${item.teams.join(", ")} (no fixture linked)`);
    }
    const c = item.metadataConfidence;
    console.log(`    conf:   match=${c.match} teams=${c.teams} stage=${c.stage} score=${c.score}`);
    console.log(`    thumb:  ${item.thumbnailLocalPath ? "local " + item.thumbnailLocalPath : item.thumbnailRemoteUrl ? "remote only" : "none"}`);
    if (meta.error) console.log(`    note:   metadata partial (${meta.error})`);
    if (item.needsReview) console.log(`    ⚑ needs review`);
    console.log("");
  }
  for (const s of skipped) console.log(`= skipped: ${s.url}\n    ${s.reason}`);
  for (const f of failed) console.log(`✗ failed:  ${f.url}\n    ${f.reason}`);

  const review = added.filter((a) => a.item.needsReview).length;
  if (review) console.log(`\n${review} item(s) need review — open data/items.json and check/fill football metadata.`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
