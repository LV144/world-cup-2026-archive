---
name: add-link
description: Add one or more URLs (Reddit posts, articles, videos, tweets, images) to the World Cup 2026 link archive. Fetches metadata, infers the match, auto-archives to the Wayback Machine, confirms any result without inventing it, enriches, validates, and publishes. Use whenever the user wants to add, save, or archive a link/post to this World Cup archive.
---

# Add link(s) to the World Cup 2026 Archive

Standardized flow for adding links to this project (`world-cup-2026-archive`). Run every step in
order. The `npm run add` script does the mechanical work; this skill adds the review,
result-confirmation, and publishing steps around it.

## Steps

1. **Collect URLs (and any tags).** Take the URL(s) from the user's message (or the slash-command
   arguments). If none were given, ask for them. Multiple URLs are fine in one run. Any **non-URL
   words** the user writes (e.g. `Banger`, `Vibes`) are **tags to pin** on the added item(s).

2. **Add.** Run the script (it normalizes, dedupes, fetches metadata, infers the match, downloads
   a thumbnail, scrapes the post date, and auto-archives Reddit links to the Wayback Machine).
   Pass any tag words **after** the URLs — the script pins every non-URL token onto each item it
   adds in that run, and pinned tags persist through future `enrich` runs:
   ```
   npm run add -- "<url1>" "<url2>" ... [Tag ...]
   ```
   Pinned tags apply to **all** URLs in the run, so if different links need different tags, add
   them in separate runs. To pin a tag on an **existing** item, add the tag to that item's
   `pinnedTags` array in `data/items.json` and run `npm run enrich`.

3. **Review.** Read `data/items.json` and, for each newly added item (the script lists the added
   URLs; they're also the most recent entries), report concisely:
   - title · source (+ subreddit) · postDate
   - match: `matchLabel [matchId]` + match confidence — or candidateMatches — or "no match linked"
   - scoreLabel (if any, includes team flags) · auto `tags` (Goal/Saves/Highlights/Vibes/…) ·
     `needsReview` (and why) · archivedUrl
   Also report anything **skipped** (duplicate) or **failed**, with the reason. If a content tag
   looks wrong or missing, the fix is to edit `data/tag-rules.json` (not the item) and re-run
   `npm run enrich`.

4. **Confirm result (only for items where `matchId` is set).**
   - Inspect the post title/slug for an implied **score or goals** (e.g. "Mexico 1-0 South
     Africa", "Kane scores", "2-2 thriller").
   - Find that match in `data/matches.json`. If the post implies a result the match does **not**
     yet record (`status` ≠ `"completed"`, or a different score), **ask the user to confirm** the
     exact score and, if mentioned, scorer + minute.
   - **Never infer or write a score, scorer, minute, stage, or team yourself** — only record what
     the user explicitly confirms. If they don't confirm, leave the match as-is.
   - On confirmation, edit that match in `data/matches.json`:
     - `status` → `"completed"`, `score` → `{ "home": H, "away": A }`
     - `goals` → append `{ "team", "player", "minute", "ownGoal": false, "penalty": false }`
       entries — include only the parts the user gave; leave unknown fields `null`
     - append the post URL to `sourceUrls`
     - remove any `"sample": true` flag and sample `"note"` on that match
     - set `lastUpdated` to the current UTC timestamp
   - Then propagate it into the linked items:
     ```
     npm run enrich
     ```

5. **Validate.**
   ```
   npm run validate
   ```
   If it reports **errors**, show them and **stop** (do not commit). Warnings are OK.

6. **Publish (automatic).** Stage the new item(s), any `matches.json` change, and the downloaded
   thumbnail(s), then commit and push:
   ```
   git add -A
   git commit -m "Add: <short title>"        # for several links: "Add N links: <t1>; <t2>; …"
   git push
   ```
   The GitHub Pages site (https://lv144.github.io/world-cup-2026-archive/) rebuilds in ~1 minute.

7. **Report.** Tell the user it's live, summarize what was added/inferred/needs-review (including
   any pinned tags), and remind them they can hand-edit `type` / `importance` / `note` / `backup`
   for any item in `data/items.json` (those manual fields are never overwritten by the scripts).
   Content `tags` are auto-derived from the title via `data/tag-rules.json` (tune that file rather
   than the items), plus any **pinned** tags they wrote after the link.

## Rules (mirror the project's core principle)

- **Do not invent facts** — scores, scorers, minutes, stages, teams, venues, or match links. When
  uncertain, leave fields `null`/empty and let `needsReview` stay `true`.
- A bad or blocked URL must not stop the others (the script already isolates per-URL failures).
- Reddit is frequently blocked from some IPs; partial metadata (e.g. a slug-derived title) is
  expected and fine.
- Never touch the manual fields (`type`, `importance`, `note`, `backup`). Content `tags` are
  auto-managed (Goal/Saves/Highlights/Vibes/Banger/…) and refreshed each run; tags in `pinnedTags`
  (set from words written after the link) and any hand-added tag outside the `tag-rules.json`
  taxonomy are always preserved.
