// content-tags.mjs
// Pure, data-driven content tagging. Derives tags like "Goal", "Saves", "Highlights",
// "Vibes" from a post's title using editable keyword/regex rules in data/tag-rules.json.
// No I/O here — the caller reads the rules file and passes the object in.
//
// Contract for the `tags` field:
//   • The taxonomy tags (the keys of tag-rules.json) are AUTO-derived and refreshed on every
//     add/enrich run — they always reflect the post's current content.
//   • Any other tag you add by hand (anything not in the taxonomy and not a "r/<sub>" tag) is
//     PRESERVED across runs. To make a taxonomy tag stick to a kind of post, add a keyword to
//     data/tag-rules.json rather than editing items by hand.

/** Compile { tag: [pattern, …] } into [{ tag, regexes }]. Bad patterns are skipped, not fatal. */
export function compileTagRules(rules) {
  const out = [];
  for (const [tag, patterns] of Object.entries(rules || {})) {
    const regexes = [];
    for (const p of patterns || []) {
      try {
        regexes.push(new RegExp(p, "i"));
      } catch {
        /* ignore an invalid pattern so one typo can't break tagging */
      }
    }
    out.push({ tag, regexes });
  }
  return out;
}

/** Tags (in taxonomy order) whose patterns match `text`. */
export function inferContentTags(text, compiled) {
  const s = String(text || "");
  if (!s.trim()) return [];
  const tags = [];
  for (const { tag, regexes } of compiled) {
    if (regexes.some((re) => re.test(s))) tags.push(tag);
  }
  return tags;
}

/** The set of auto-managed tag names (the taxonomy keys). */
export function managedTagSet(compiled) {
  return new Set(compiled.map((c) => c.tag));
}

/**
 * Merge freshly-derived auto tags with an item's existing tags:
 *   result = autoTags (taxonomy order) + manual tags preserved (deduped).
 * Drops stale taxonomy tags (re-derived each run) and legacy "r/<sub>" subreddit tags
 * (the subreddit already lives in `source` / `sourceDetail`).
 */
export function mergeTags(existing, autoTags, compiled) {
  const managed = managedTagSet(compiled);
  const isSubreddit = (t) => /^r\//i.test(t);
  const manual = (existing || []).filter(
    (t) => typeof t === "string" && t && !managed.has(t) && !isSubreddit(t),
  );
  const out = [];
  for (const t of [...(autoTags || []), ...manual]) if (!out.includes(t)) out.push(t);
  return out;
}
