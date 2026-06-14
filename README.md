# World Cup 2026 Internet Archive

A small, durable, **static** website for collecting and sharing World Cup 2026 internet
posts — mainly Reddit links, but also articles, videos, social media posts, images, and any
other URL. Paste links, let the tooling fetch web metadata and infer football context, and
publish a clean, filterable card archive to any static host.

No database, no backend, no paid APIs, no authentication. All data lives in plain, editable
JSON files.

---

## 1. What this project is

You run one command:

```bash
npm run add -- <url1> <url2> <url3>
```

…and the project will, for each URL:

1. Normalize the URL and skip duplicates.
2. Fetch web metadata (title, description, source, canonical URL, thumbnail) via Open Graph,
   Twitter Card, JSON-LD, oEmbed, and `<title>` fallbacks.
3. Handle Reddit specially (page metadata → public `.json` endpoint → oEmbed → URL-derived).
4. Infer World Cup metadata when possible: stage, group, match, teams, team codes, score (only
   if the match has finished), and goals.
5. Download a local copy of the thumbnail when feasible.
6. Store everything in `data/items.json`.
7. Mark anything uncertain with `needsReview: true` instead of inventing facts.

The frontend (`index.html` + `styles.css` + `app.js`) reads the JSON and renders a responsive,
filterable, sortable archive. It works even when metadata is missing.

> **Important:** This archive stores **metadata, links, notes, and thumbnails** — not full
> copyrighted article text. For Reddit, the `backup` field is available for your own
> screenshots or copied excerpts.

---

## 2. How the data model works

### `data/items.json` — archived links (array)

| Field | Meaning |
| --- | --- |
| `id` | Stable id (derived from the normalized URL). |
| `title`, `description` | From page metadata. |
| `url` | Original submitted URL, normalized. |
| `canonicalUrl` | Canonical URL from metadata, if any. |
| `source`, `sourceDetail` | e.g. `Reddit` / `r/worldcup`, `YouTube`, `Article`. |
| `thumbnailRemoteUrl` | Image URL from metadata. |
| `thumbnailLocalPath` | Local copy under `assets/thumbs/`, if downloaded. |
| `archivedUrl` | Wayback Machine snapshot of the link (auto-captured for Reddit), if any. |
| `postDate` | When the post itself was published — scraped from the post's HTML/metadata. Reddit: `created-timestamp` (new reddit), the `<time>` tag (old.reddit), or `created_utc` (API). Articles/video: `article:published_time`, JSON-LD `datePublished`/`uploadDate`, `<time>`. Accepts ISO or unix-epoch values; `null` if not found. |
| `dateSaved` | When the item was added to this archive (ISO timestamp). |
| `matchId`, `matchLabel` | Linked match (e.g. `Mexico vs South Africa`), if confidently inferred. |
| `stage`, `group` | Canonical stage / group letter. |
| `teams`, `teamCodes` | Teams involved + FIFA-style codes. |
| `scoreLabel` | e.g. `Mexico 2–0 South Africa` (only when the match is completed). |
| `goals` | Copied from the match if available. |
| `candidateMatches` | Possible matches when inference is uncertain. |
| `type`, `tags` | `meme`, `analysis`, `match thread`, `highlight`, etc. **(manual)** |
| `importance` | `must-save` / `good` / `maybe`. **(manual)** |
| `note`, `backup` | Your context + preservation field. **(manual)** |
| `metadataConfidence` | `{ match, teams, stage, score }`, each `0`–`1`. |
| `needsReview` | `true` when metadata is incomplete or uncertain. |

**Manual fields** (`type`, `tags`, `importance`, `note`, `backup`) are **never overwritten** by
the scripts.

### `data/matches.json` — structured match data (array)

Each match: `matchId`, `stage`, `group`, `round`, `kickoffUtc`, `status`
(`scheduled` / `completed`), `homeTeam`/`awayTeam` (`{name, code}`), `score` (`null` until
played), `goals`, `venue`, `sourceUrls`, `lastUpdated`.

Canonical stages (use these exactly): `Group stage`, `Round of 32`, `Round of 16`,
`Quarter-finals`, `Semi-finals`, `Third-place play-off`, `Final`.

> The shipped `matches.json` contains a few **clearly-labeled sample matches** (`"sample": true`)
> so the tooling and frontend work out of the box. They are placeholders, not verified results —
> run `npm run update-matches` (or edit the file) to replace them with real data. Successfully
> fetched real data automatically removes the sample rows.

### `data/team-aliases.json` & `data/stage-aliases.json`

Editable maps from spellings/abbreviations/nicknames to canonical team names + FIFA codes, and
from common stage terms to canonical stage values. Add or fix entries freely — the inference
engine reads them on every run. The team list is reference data (common nations + hosts), not a
claim about the final 48; edit it to match the actual field.

---

## 3. How to add links

```bash
npm run add -- "https://www.reddit.com/r/worldcup/comments/abc123/some_post/"
npm run add -- "<url1>" "<url2>" "<url3>"
```

- Duplicates (by URL, canonical URL, or normalized variants) are skipped and reported.
- One bad/blocked URL never aborts the batch — partial success is preserved.
- After writing, `items.json` is re-validated as JSON; a `.bak` backup is kept.
- The summary prints what was added, what was inferred, and what needs review.

Then review: open `data/items.json`, fill in `type` / `tags` / `importance` / `note`, and add a
`backup` for anything you want to preserve.

### Reddit links (and optional credentials)

Since Reddit's 2023 API lockdown, Reddit blocks the public `.json` endpoint and serves a
"please wait" bot-check from many IPs/User-Agents (datacenter IPs are hit hardest; your own
laptop usually fares better). The tool handles this with a **fallback cascade** that needs no
setup — for each Reddit URL it tries, in order:

1. **Reddit OAuth API** — only if you've set credentials (see below).
2. `www.reddit.com` page / Open Graph.
3. `www.reddit.com/...json`.
4. `old.reddit.com` page / `.json` (the old front-end is less gated).
5. **Wayback Machine** snapshot (archive.org has an unblocked copy of the page).
6. Reddit **oEmbed**.
7. `old.reddit.com/....rss` (title only).
8. **URL-derived** title from the post slug (always works; football inference still runs on it).

So a Reddit link always saves something — at worst a slug-derived title plus the generic Reddit
thumbnail — and never crashes the run.

#### Auto-archiving (Save Page Now)

For every Reddit link, the tool also ensures a **Wayback Machine snapshot** exists, stored in the
item's `archivedUrl` (shown as an "Archived" link on each card):

- If archive.org already has a snapshot of the URL, it's linked.
- If not (e.g. a brand-new post), the tool calls archive.org's **Save Page Now** to create one on
  the spot — no auth, no approval. This both **preserves** the post (Reddit posts get deleted or
  blocked) and gives the cascade a readable copy to pull metadata from.

Save Page Now is slow (~10–30s) and rate-limited, so it only fires when no snapshot exists yet.
To skip *creating* new snapshots (existing ones are still linked), set `WAYBACK_SAVE=off`:

```powershell
$env:WAYBACK_SAVE="off"; npm run add -- "<url>"   # PowerShell
```
```bash
WAYBACK_SAVE=off npm run add -- "<url>"            # bash
```

This is now the most reliable durability mechanism for Reddit, given Reddit's API is effectively
closed to self-serve apps as of mid-2026 (see below).

**Optional: Reddit OAuth credentials.** If you can still create a Reddit app, OAuth gives the
cleanest metadata. **Heads-up:** as of mid-2026 Reddit's self-serve app creation at
`prefs/apps` is widely reported broken (the "create app" button silently fails / resets the
captcha) and Data API access is gated behind a manual approval process. Reddit's Devvit platform
is for apps that run *on* Reddit and does **not** help an external script like this. So treat
OAuth as a nice-to-have — the no-auth cascade + auto-archiving above is the supported path here.
If you do have working credentials:

1. Register a free app at <https://www.reddit.com/prefs/apps> (type **script** or **web app**).
2. `cp .env.example .env` and fill in `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET`.
3. Run `npm run add -- ...` as usual — it auto-detects the credentials and uses
   `oauth.reddit.com` (≈100 requests/min, plenty).

`.env` is git-ignored, so your secret is never committed. You can also export the variables in
your shell instead of using `.env`:

```powershell
# PowerShell
$env:REDDIT_CLIENT_ID="..."; $env:REDDIT_CLIENT_SECRET="..."; npm run add -- "<url>"
```
```bash
# bash
REDDIT_CLIENT_ID=... REDDIT_CLIENT_SECRET=... npm run add -- "<url>"
```

---

## 4. How to refresh World Cup match data

```bash
npm run update-matches
```

Fetches fixtures/results from a free, no-auth public source and merges them into
`data/matches.json` by stable `matchId`.

- **Source:** the primary adapter pulls structured JSON from the community **openfootball**
  dataset on GitHub (no scraping). A **Wikipedia** fallback hook exists but is left as a clearly
  marked stub — extend `scripts/utils/match-sources.mjs` to enable it. Both parsers are isolated
  in that one file, so swapping/fixing a source is a one-function change.
- A field is only overwritten when the source supplies a non-null value — manual fields, venues,
  and hand-entered scores are never wiped.
- If no source is reachable, `matches.json` is **left untouched** and the script exits cleanly.
- Scores stay `null` until a match is actually played; scorers/minutes are only stored when the
  source provides them. Nothing is invented.

> If openfootball hasn't published the 2026 dataset (or the path has moved), the script will
> report "no source returned usable data." In that case, edit `data/matches.json` by hand or add
> a parser to `match-sources.mjs`.

---

## 5. How to enrich existing items after matches finish

```bash
npm run enrich
```

After updating matches, this refreshes archived items:

- Items **with** a `matchId`: refresh `stage`, `group`, `teams`, `teamCodes`, `scoreLabel`,
  `goals` from `matches.json`.
- Items **without** a `matchId`: retry inference; link only if it now resolves confidently.
- Manual fields (`type`, `tags`, `importance`, `note`, `backup`) are never touched.

So a "match thread" you saved before kickoff will pick up the final score automatically once the
match data updates.

---

## 6. How to manually edit metadata

All data is plain JSON — edit `data/items.json` and `data/matches.json` in any editor.

- Fix or fill `stage`, `teams`, `note`, `tags`, `importance`, etc.
- Set `needsReview` to `false` once you've checked an item.
- To force a match link, set the item's `matchId` to a real `matchId` from `matches.json` and run
  `npm run enrich` to populate the rest.
- Add aliases to `data/team-aliases.json` so future inference recognizes a team/spelling.
- Run `npm run validate` after editing to catch mistakes.

---

## 7. How to preview locally

```bash
npm install        # one-time, installs cheerio
npm run serve      # serves the folder at http://localhost:8080
```

Open <http://localhost:8080>. (Opening `index.html` directly via `file://` won't work because
browsers block `fetch` of local files — use the served URL.)

---

## 8. How to deploy to GitHub Pages

1. Create a GitHub repo and push this folder:
   ```bash
   git init && git add . && git commit -m "World Cup 2026 archive"
   git branch -M main
   git remote add origin https://github.com/<you>/world-cup-2026-archive.git
   git push -u origin main
   ```
2. In the repo: **Settings → Pages → Build and deployment → Source: Deploy from a branch**,
   branch `main`, folder `/ (root)`. Save.
3. Your site appears at `https://<you>.github.io/world-cup-2026-archive/`.

Because the site is plain static files and uses **relative** `data/...` paths, it works on a
project subpath with no configuration. Commit `assets/thumbs/` so local thumbnails are served.
Re-run `npm run add`, commit, and push to update.

---

## 9. How to deploy to Netlify

- **Drag-and-drop:** zip/drag the project folder onto <https://app.netlify.com/drop>.
- **Git:** "Add new site → Import an existing project", pick the repo. There is no build step:
  - Build command: *(leave empty)*
  - Publish directory: `.` (the repo root)

---

## 10. How to deploy to Cloudflare Pages

1. **Workers & Pages → Create → Pages → Connect to Git**, select the repo.
2. Framework preset: **None**. Build command: *(empty)*. Build output directory: `/` (root).
3. Deploy. Updates ship automatically on every push.

(You can also use `npx wrangler pages deploy .` for a direct upload.)

---

## 11. Known limitations

- **Reddit metadata may be incomplete** — Reddit rate-limits and blocks bots; the tool falls
  back through several strategies (old.reddit → Wayback → oEmbed → RSS → URL-derived) and, for
  the most reliable results, an **optional OAuth path** (see "Reddit links" above). Without
  credentials, some posts still yield only a slug-derived title and a generic thumbnail.
- **Some sites block scraping** — the item is still saved with whatever could be derived.
- **Thumbnails can disappear** — remote images rot. Local copies in `assets/thumbs/` are more
  durable; commit them.
- **Goal-scorer data may not be available** — scores update without scorers; goals stay `[]`.
- **The archive stores metadata and links, not full copyrighted articles.**
- **Football inference is best-effort** — uncertain items are flagged `needsReview`, never
  guessed. Match data quality depends entirely on `matches.json`.

---

## 12. Preservation notes

- Reddit links are **auto-archived to the Wayback Machine** on add (`archivedUrl`), so most posts
  are already preserved. For extra-important ones, also add **screenshots or copied excerpts** in
  the item's `backup` field (and you can paste additional archive links there too).
- **Remote thumbnails are convenient but local thumbnails are more durable** — the `add` script
  downloads a local copy when it can; keep `assets/thumbs/` committed.
- Run `npm run validate` regularly, and keep the `.bak` files around until you're confident a
  rewrite went well.

---

## Project layout

```
world-cup-2026-archive/
  index.html  styles.css  app.js          # static frontend
  package.json  README.md  .gitignore
  data/
    items.json          # archived links
    matches.json        # WC 2026 matches (sample seed + scraped/updated)
    team-aliases.json   # team name/code/alias map (editable)
    stage-aliases.json  # stage term map (editable)
  scripts/
    add-links.mjs  update-matches.mjs  enrich-items.mjs  validate.mjs
    utils/
      fetch-metadata.mjs  reddit-metadata.mjs  match-inference.mjs
      normalize-url.mjs   file-utils.mjs       match-sources.mjs
  assets/thumbs/          # downloaded thumbnails (committed)
```

## Commands

| Command | What it does |
| --- | --- |
| `npm run add -- <urls…>` | Fetch metadata + infer football data, append items. |
| `npm run update-matches` | Refresh `matches.json` from a public source. |
| `npm run enrich` | Re-apply match data to existing items. |
| `npm run validate` | Check JSON validity, duplicates, references, stages. |
| `npm run serve` | Preview locally at `http://localhost:8080`. |
