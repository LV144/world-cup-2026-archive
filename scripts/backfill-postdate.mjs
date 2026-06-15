// backfill-postdate.mjs
// Usage: npm run backfill-postdate   (or: node scripts/backfill-postdate.mjs)
//
// One-off / repeatable repair: fill `postDate` on items that never got one (so the grouped
// "By matchday" view doesn't bucket them under their save date). Reddit's JSON/OAuth carry
// `created_utc` but are 403-blocked from many IPs; the old.reddit `.rss` feed is far less gated
// and exposes a real <published> timestamp, so we read that. Rate-limited (HTTP 429), so requests
// are spaced out and retried with backoff. Never invents a date — items it can't resolve are left
// untouched and reported. Re-running is safe (only fills items still missing postDate).

import { PATHS, readJson, writeJson, backupFile } from "./utils/file-utils.mjs";
import { parseRedditPath, isRedditUrl } from "./utils/reddit-metadata.mjs";

const UA = process.env.REDDIT_USER_AGENT || "world-cup-archive/1.0 (link archive; +https://github.com/)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fetch the post's published timestamp from the old.reddit RSS feed. Retries on 429/5xx. */
async function fetchPublished(postId, { tries = 6, baseDelay = 5000 } = {}) {
  const rssUrl = `https://old.reddit.com/comments/${postId}/.rss`;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(rssUrl, {
        headers: { "User-Agent": UA, Accept: "application/atom+xml, application/rss+xml, text/xml" },
      });
      if (res.status === 429 || res.status >= 500) {
        const wait = baseDelay * attempt;
        console.log(`    ${postId}: HTTP ${res.status}, retrying in ${wait / 1000}s (attempt ${attempt}/${tries})`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) return { error: `HTTP ${res.status}` };
      const xml = await res.text();
      // Atom feeds use <published>; fall back to <updated> if absent.
      const m = xml.match(/<published>([^<]+)<\/published>/i) || xml.match(/<updated>([^<]+)<\/updated>/i);
      if (!m) return { error: "no <published> in feed" };
      const iso = new Date(m[1].trim()).toISOString(); // normalize +00:00 → Z
      return { postDate: iso };
    } catch (e) {
      const wait = baseDelay * attempt;
      console.log(`    ${postId}: ${e.message}, retrying in ${wait / 1000}s (attempt ${attempt}/${tries})`);
      await sleep(wait);
    }
  }
  return { error: "exhausted retries" };
}

async function main() {
  const items = await readJson(PATHS.items, []);
  const targets = items.filter((it) => !it.postDate && it.url && isRedditUrl(it.url));
  const skipped = items.filter((it) => !it.postDate && !(it.url && isRedditUrl(it.url)));

  console.log("World Cup Archive — backfill-postdate\n");
  console.log(`  items missing postDate: ${items.filter((it) => !it.postDate).length}`);
  console.log(`  resolvable via Reddit:  ${targets.length}`);
  if (skipped.length) console.log(`  non-Reddit (skipped):   ${skipped.length}`);
  console.log("");

  const filled = [];
  const failed = [];
  for (const it of targets) {
    const { postId } = parseRedditPath(it.url);
    if (!postId) {
      failed.push({ id: it.id, reason: "no postId in URL" });
      continue;
    }
    const r = await fetchPublished(postId);
    if (r.postDate) {
      it.postDate = r.postDate;
      filled.push({ id: it.id, postDate: r.postDate, title: it.title });
      console.log(`  ✓ ${postId}  ${r.postDate}  ${(it.title || "").slice(0, 50)}`);
    } else {
      failed.push({ id: it.id, reason: r.error });
      console.log(`  ✗ ${postId}  ${r.error}`);
    }
    await sleep(7000); // be polite; old.reddit RSS rate-limits aggressively per-IP
  }

  if (filled.length) {
    await backupFile(PATHS.items);
    await writeJson(PATHS.items, items);
  }

  console.log(`\n  filled:  ${filled.length}`);
  console.log(`  failed:  ${failed.length}${failed.length ? " — " + failed.map((f) => f.id).join(", ") : ""}`);
  if (failed.length) console.log("\n  Re-run to retry the failures, or set postDate by hand for any that stay unresolved.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
