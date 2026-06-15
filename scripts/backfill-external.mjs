// backfill-external.mjs — populate `externalUrl` on existing Reddit items that predate the
// field, by re-reading each post's metadata. Best-effort: an item stays null if Reddit blocks
// `.json` from your IP (common on datacenter/CI; your own laptop usually works) and no OAuth is
// configured. Run from a machine where Reddit is reachable:
//     WAYBACK_SAVE=off node scripts/backfill-external.mjs   (WAYBACK_SAVE=off skips re-archiving)
// Also ensures every item carries the `externalUrl` key (null when none), so the schema is uniform.
import { PATHS, readJson, writeJson, backupFile, loadDotEnv } from "./utils/file-utils.mjs";
import { fetchRedditMetadata, isRedditUrl } from "./utils/reddit-metadata.mjs";

await loadDotEnv();
const items = await readJson(PATHS.items, []);

// 1) Normalize: ensure every item carries the externalUrl key, inserted right after
//    thumbnailLocalPath so the schema matches buildItem's field order.
let normalized = 0;
const out = items.map((it) => {
  if ("externalUrl" in it) return it;
  normalized++;
  const n = {};
  for (const [k, v] of Object.entries(it)) {
    n[k] = v;
    if (k === "thumbnailLocalPath") n.externalUrl = null;
  }
  if (!("externalUrl" in n)) n.externalUrl = null; // no thumbnailLocalPath key → append
  return n;
});

// 2) For Reddit items still missing a destination, try to recover it (best-effort).
const patched = [];
const stillNull = [];
for (const item of out) {
  if (item.externalUrl || !isRedditUrl(item.url)) continue;
  const meta = await fetchRedditMetadata(item.url);
  if (meta.externalUrl) {
    item.externalUrl = meta.externalUrl;
    patched.push(`${item.id} → ${meta.externalUrl}`);
  } else {
    stillNull.push(item.id);
  }
}

if (normalized || patched.length) {
  await backupFile(PATHS.items);
  await writeJson(PATHS.items, out);
}

console.log(`Backfill externalUrl — normalized ${normalized}, patched ${patched.length}, still null ${stillNull.length}`);
for (const p of patched) console.log(`  + ${p}`);
if (stillNull.length) console.log(`  (no external link found / blocked: ${stillNull.join(", ")})`);
