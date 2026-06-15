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

// "Highlights" is the umbrella for on-pitch match action: any goal or save clip is also a
// highlight, so these subtype tags imply it. (Keep in sync with the taxonomy in tag-rules.json.)
const HIGHLIGHT_SUBTYPES = ["Goal", "Banger", "Saves"];

/** Tags (in taxonomy order) whose patterns match `text`, plus implied umbrella tags. */
export function inferContentTags(text, compiled) {
  const s = String(text || "");
  if (!s.trim()) return [];
  const matched = new Set();
  for (const { tag, regexes } of compiled) {
    if (regexes.some((re) => re.test(s))) matched.add(tag);
  }
  if (HIGHLIGHT_SUBTYPES.some((t) => matched.has(t))) matched.add("Highlights");
  // Return in taxonomy (compiled) order so display ordering stays stable.
  return compiled.map((c) => c.tag).filter((t) => matched.has(t));
}

/** The set of auto-managed tag names (the taxonomy keys). */
export function managedTagSet(compiled) {
  return new Set(compiled.map((c) => c.tag));
}

/**
 * Clean up user-typed tags: strip a leading "#", trim, drop empties, dedupe, and snap to the
 * taxonomy's canonical casing when one matches case-insensitively ("banger" → "Banger"). Tags
 * not in the taxonomy are kept as typed. Used for the pinned tags written after a link.
 */
export function canonicalizeTags(tags, compiled) {
  const managed = [...managedTagSet(compiled)];
  const out = [];
  for (const raw of tags || []) {
    const t = String(raw || "").replace(/^#/, "").trim();
    if (!t) continue;
    const canon = managed.find((m) => m.toLowerCase() === t.toLowerCase()) || t;
    if (!out.includes(canon)) out.push(canon);
  }
  return out;
}

/**
 * Merge freshly-derived auto tags with an item's existing + pinned − suppressed tags:
 *   result = (autoTags (taxonomy order) + pinned + preserved legacy manual tags) − suppressed.
 * Drops stale taxonomy tags (re-derived each run) and legacy "r/<sub>" subreddit tags (the
 * subreddit already lives in `source` / `sourceDetail`). `pinned` always survive — the durable
 * channel for manual tags (e.g. a "Banger" the title doesn't keyword-match). `suppressed` is the
 * opposite durable channel: tags the user removed by hand stay removed across re-tagging
 * (suppression wins over both auto and pinned). Matching is case-insensitive via canonical form.
 */
export function mergeTags(existing, autoTags, compiled, pinned = [], suppressed = []) {
  const managed = managedTagSet(compiled);
  const isSubreddit = (t) => /^r\//i.test(t);
  const pinnedCanon = canonicalizeTags(pinned, compiled);
  const suppressedCanon = canonicalizeTags(suppressed, compiled);
  const isSuppressed = (t) => suppressedCanon.some((s) => s.toLowerCase() === String(t).toLowerCase());
  const manual = (existing || []).filter(
    (t) => typeof t === "string" && t && !managed.has(t) && !isSubreddit(t) && !pinnedCanon.includes(t),
  );
  const out = [];
  for (const t of [...(autoTags || []), ...pinnedCanon, ...manual]) {
    if (!out.includes(t) && !isSuppressed(t)) out.push(t);
  }
  return out;
}
