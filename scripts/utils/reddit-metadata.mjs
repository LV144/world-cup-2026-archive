// reddit-metadata.mjs
// Reddit needs special handling: since the 2023 API lockdown it blocks the default fetch
// User-Agent, rate-limits the public `.json` endpoint, and serves a "please wait" bot-check
// interstitial — especially from datacenter IPs. We try several strategies in order and
// degrade gracefully; a blocked/empty Reddit response must never crash the run.
//
// Cascade (first source that yields a usable, non-interstitial title wins):
//   0) OAuth API (oauth.reddit.com)      — OPT-IN, most reliable. Enabled when
//      REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET are set (see .env.example). Never required.
//   1) www.reddit.com page / Open Graph
//   2) www.reddit.com `.json`
//   3) old.reddit.com page / `.json`     — the old front-end is often less gated
//   4) Wayback Machine snapshot          — archive.org has a real, unblocked copy of the page
//   5) Reddit oEmbed                     — title + thumbnail
//   6) old.reddit `.rss`                 — title only (RSS is less gated than JSON)
//   7) URL-derived slug                  — last resort, always succeeds
//
// Authentication is OPTIONAL: with no credentials the no-auth strategies (1-7) still run.

import { fetchMetadata, fetchWithTimeout } from "./fetch-metadata.mjs";

const DEFAULT_UA = "world-cup-archive/1.0 (static link archive; +https://github.com/)";
const redditUA = () => process.env.REDDIT_USER_AGENT || DEFAULT_UA;

// A generic fallback thumbnail used when Reddit gives us nothing usable.
// data: URI so it works offline and never 404s. Simple Reddit-orange square.
export const REDDIT_PLACEHOLDER =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">` +
      `<rect width="120" height="120" rx="16" fill="#ff4500"/>` +
      `<circle cx="60" cy="66" r="34" fill="#fff"/>` +
      `<circle cx="46" cy="64" r="6" fill="#ff4500"/><circle cx="74" cy="64" r="6" fill="#ff4500"/>` +
      `<path d="M44 80 q16 12 32 0" stroke="#ff4500" stroke-width="5" fill="none" stroke-linecap="round"/>` +
      `</svg>`,
  );

const PLACEHOLDER_THUMBS = new Set(["self", "default", "nsfw", "spoiler", "image", ""]);

export function isRedditUrl(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h.endsWith("reddit.com") || h === "redd.it" || h.endsWith(".redd.it");
  } catch {
    return false;
  }
}

/** Parse /r/<sub>/comments/<id>/<slug> → { subreddit, postId, titleFromSlug }. */
export function parseRedditPath(url) {
  const out = { subreddit: null, postId: null, titleFromSlug: null };
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/r\/([^/]+)\/comments\/([^/]+)(?:\/([^/]+))?/i);
    if (m) {
      out.subreddit = m[1];
      out.postId = m[2];
      if (m[3]) out.titleFromSlug = decodeURIComponent(m[3]).replace(/_/g, " ").trim();
    } else {
      const sub = u.pathname.match(/\/r\/([^/]+)/i);
      if (sub) out.subreddit = sub[1];
    }
  } catch {
    /* ignore */
  }
  return out;
}

function htmlDecode(s) {
  if (!s) return s;
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'");
}

function usableThumb(t) {
  if (!t || typeof t !== "string") return null;
  if (PLACEHOLDER_THUMBS.has(t.toLowerCase())) return null;
  if (!/^https?:\/\//i.test(t)) return null;
  return htmlDecode(t);
}

// Reddit sometimes returns HTTP 200 with a bot-check / "please wait" interstitial that still
// carries an og:title. Such titles (and the generic homepage title) must not pre-empt the
// later strategies.
function looksBlocked(s) {
  if (!s) return false;
  return /please wait|whoa there|verifying you are human|are you a robot|just a moment|enable javascript|access denied|you'?ve been blocked|dive into anything/i.test(s);
}

/** Rebuild a Reddit URL on a different host (e.g. old.reddit.com). */
function onHost(url, host) {
  try {
    const u = new URL(url);
    u.hostname = host;
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * The site a link-post points OUT to (a video on streamff/streamja/dubz, a YouTube/X link,
 * an i.redd.it/v.redd.it media URL, …) — distinct from the Reddit permalink. null for self/text
 * posts and for posts whose destination is just reddit.com.
 */
function externalUrlFrom(post) {
  if (!post || post.is_self) return null;
  const dest = post.url_overridden_by_dest || post.url || null;
  if (!dest || !/^https?:\/\//i.test(dest)) return null;
  try {
    const h = new URL(dest).hostname.toLowerCase();
    if (h === "reddit.com" || h.endsWith(".reddit.com")) return null; // the permalink, not a destination
    return htmlDecode(dest);
  } catch {
    return null;
  }
}

/** Shared: turn a Reddit post `data` object (from .json or OAuth) into partial metadata. */
function extractPostData(post) {
  if (!post) return null;
  const image =
    usableThumb(post?.preview?.images?.[0]?.source?.url) ||
    usableThumb(post?.secure_media?.oembed?.thumbnail_url) ||
    usableThumb(post?.media?.oembed?.thumbnail_url) ||
    usableThumb(post?.thumbnail) ||
    (post?.url && /\.(jpg|jpeg|png|gif|webp)$/i.test(post.url) ? post.url : null);
  return {
    title: htmlDecode(post.title) || null,
    description: post.selftext ? htmlDecode(post.selftext).slice(0, 280) : null,
    subreddit: post.subreddit || null,
    image: image || null,
    createdUtc: post.created_utc ? new Date(post.created_utc * 1000).toISOString() : null,
    canonicalUrl: post.permalink ? `https://www.reddit.com${post.permalink}` : null,
    externalUrl: externalUrlFrom(post),
  };
}

/* ----------------------------- OAuth (optional) ----------------------------- */

let tokenCache = null; // { value, expiresAt }
let oauthWarned = false;

export function redditOauthConfigured() {
  return !!(process.env.REDDIT_CLIENT_ID && process.env.REDDIT_CLIENT_SECRET);
}

async function getRedditToken() {
  if (!redditOauthConfigured()) return null;
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt > now + 5000) return tokenCache.value;

  const basic = Buffer.from(`${process.env.REDDIT_CLIENT_ID}:${process.env.REDDIT_CLIENT_SECRET}`).toString("base64");
  const usePassword = process.env.REDDIT_USERNAME && process.env.REDDIT_PASSWORD;
  const body = new URLSearchParams(
    usePassword
      ? { grant_type: "password", username: process.env.REDDIT_USERNAME, password: process.env.REDDIT_PASSWORD }
      : { grant_type: "client_credentials" },
  );
  try {
    const res = await fetchWithTimeout(
      "https://www.reddit.com/api/v1/access_token",
      { method: "POST", body: body.toString(), headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", "User-Agent": redditUA() } },
      10000,
    );
    if (!res.ok) {
      if (!oauthWarned) {
        oauthWarned = true;
        console.warn(`  ⚠ Reddit OAuth token request failed (HTTP ${res.status}). Check REDDIT_CLIENT_ID/SECRET (and app type). Falling back to no-auth.`);
      }
      return null;
    }
    const j = await res.json();
    if (!j.access_token) return null;
    tokenCache = { value: j.access_token, expiresAt: now + (j.expires_in || 3600) * 1000 };
    return tokenCache.value;
  } catch {
    return null;
  }
}

async function tryOauth(postId) {
  if (!postId) return null;
  const token = await getRedditToken();
  if (!token) return null;
  try {
    const res = await fetchWithTimeout(
      `https://oauth.reddit.com/api/info?id=t3_${postId}&raw_json=1`,
      { headers: { Authorization: `Bearer ${token}`, "User-Agent": redditUA() } },
      10000,
    );
    if (!res.ok) return null;
    const data = await res.json();
    return extractPostData(data?.data?.children?.[0]?.data);
  } catch {
    return null;
  }
}

/* ----------------------------- No-auth strategies ----------------------------- */

async function tryOg(url) {
  try {
    const og = await fetchMetadata(url);
    return { title: og.title, description: og.description, image: og.image, canonicalUrl: og.canonicalUrl, postDate: og.postDate };
  } catch {
    return null;
  }
}

async function tryJson(url, host = "www.reddit.com") {
  try {
    const u = new URL(url);
    u.hostname = host;
    const jsonUrl = u.origin + u.pathname.replace(/\/+$/, "") + "/.json";
    const res = await fetchWithTimeout(jsonUrl, { headers: { "User-Agent": redditUA(), Accept: "application/json" } }, 10000);
    if (!res.ok) return null;
    const data = await res.json();
    return extractPostData(data?.[0]?.data?.children?.[0]?.data);
  } catch {
    return null;
  }
}

const stripReddit = (t) => (t ? t.replace(/\s*[-|:]\s*reddit$/i, "").trim() : t);

// "Save Page Now" preservation is ON by default. Set WAYBACK_SAVE=off to skip *creating* new
// snapshots (existing snapshots are still looked up and linked either way).
const wantArchive = () => process.env.WAYBACK_SAVE !== "off";

/** Look up an existing Wayback snapshot URL for `url` (read-only, no archiving). */
async function waybackAvailable(url) {
  try {
    const res = await fetchWithTimeout(`https://archive.org/wayback/available?url=${encodeURIComponent(url)}`, { headers: { Accept: "application/json" } }, 9000);
    if (!res.ok) return null;
    const snap = (await res.json())?.archived_snapshots?.closest;
    return snap?.available && snap.url ? snap.url.replace(/^http:/, "https:") : null;
  } catch {
    return null;
  }
}

/** Read metadata from an already-archived snapshot page. */
async function metaFromSnapshot(snapshotUrl) {
  try {
    const og = await fetchMetadata(snapshotUrl);
    return { title: og.title && !looksBlocked(og.title) ? stripReddit(og.title) : null, description: og.description, image: og.image, postDate: og.postDate };
  } catch {
    return null;
  }
}

/**
 * Trigger archive.org "Save Page Now" to create a fresh snapshot (no auth), then read metadata
 * from the captured page. Slow (~10-30s) and rate-limited, so used only when no snapshot exists.
 * This is the key post-2026 fix: brand-new Reddit posts that nothing else can reach get archived
 * on the spot — durable preservation plus a readable copy. Best effort; never throws.
 * Returns { title, description, image, snapshotUrl } or null.
 */
async function tryWaybackSave(url) {
  console.log(`  📸 Save Page Now: archiving ${url} … (first capture, may take ~10-30s)`);
  try {
    const og = await fetchMetadata(`https://web.archive.org/save/${url}`, { timeoutMs: 35000 });
    let snapshotUrl = /\/web\/\d+/.test(og.finalUrl || "") ? og.finalUrl : null;
    if (!snapshotUrl) snapshotUrl = await waybackAvailable(url); // SPN didn't redirect; re-check
    const title = og.title && !looksBlocked(og.title) ? stripReddit(og.title) : null;
    if (!snapshotUrl && !title && !og.image) return null;
    return { title, description: og.description, image: og.image, postDate: og.postDate, snapshotUrl };
  } catch {
    return null;
  }
}

async function tryOembed(url) {
  try {
    const res = await fetchWithTimeout(`https://www.reddit.com/oembed?url=${encodeURIComponent(url)}`, { headers: { "User-Agent": redditUA(), Accept: "application/json" } }, 9000);
    if (!res.ok) return null;
    const data = await res.json();
    return { title: htmlDecode(data.title) || null, image: usableThumb(data.thumbnail_url) };
  } catch {
    return null;
  }
}

async function tryRss(url) {
  try {
    const u = new URL(url);
    u.hostname = "old.reddit.com"; // old.reddit RSS is less aggressively gated
    const rssUrl = u.origin + u.pathname.replace(/\/+$/, "") + "/.rss";
    const res = await fetchWithTimeout(rssUrl, { headers: { "User-Agent": redditUA(), Accept: "application/atom+xml, application/rss+xml, text/xml" } }, 9000);
    if (!res.ok) return null;
    const xml = await res.text();
    const m = xml.match(/<title[^>]*>([\s\S]*?)<\/title>/i); // feed-level title == post title for a comments feed
    // <published> (Atom) is the post's creation time; less gated than JSON's created_utc.
    const pub = xml.match(/<published>([^<]+)<\/published>/i) || xml.match(/<updated>([^<]+)<\/updated>/i);
    let postDate = null;
    if (pub) { const d = new Date(pub[1].trim()); if (!isNaN(d.getTime())) postDate = d.toISOString(); }
    const t = m ? htmlDecode(m[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim()) : null;
    const title = t && !looksBlocked(t) ? t : null;
    return title || postDate ? { title, image: null, postDate } : null;
  } catch {
    return null;
  }
}

/* ----------------------------- Cascade ----------------------------- */

export async function fetchRedditMetadata(url) {
  const fromPath = parseRedditPath(url);
  const result = {
    requestUrl: url,
    finalUrl: url,
    source: "Reddit",
    title: null,
    description: null,
    siteName: "Reddit",
    canonicalUrl: fromPath.postId ? `https://www.reddit.com/r/${fromPath.subreddit}/comments/${fromPath.postId}` : null,
    image: null,
    subreddit: fromPath.subreddit || null,
    createdUtc: null,
    postDate: null,
    externalUrl: null,
    archivedUrl: null,
    usedPlaceholder: false,
    usedOauth: false,
    strategiesTried: [],
    error: null,
  };

  // Fill missing fields from a partial result; never overwrite what we already have.
  const absorb = (p) => {
    if (!p) return;
    if (!result.title && p.title && !looksBlocked(p.title)) result.title = p.title;
    if (!result.description && p.description && !looksBlocked(p.description)) result.description = p.description;
    if (!result.image && p.image) result.image = p.image;
    if (!result.subreddit && p.subreddit) result.subreddit = p.subreddit;
    if (!result.createdUtc && p.createdUtc) result.createdUtc = p.createdUtc;
    if (!result.postDate && (p.postDate || p.createdUtc)) result.postDate = p.postDate || p.createdUtc;
    if (!result.externalUrl && p.externalUrl) result.externalUrl = p.externalUrl;
    if (p.canonicalUrl) result.canonicalUrl = p.canonicalUrl;
  };

  // "Rich" strategies return title AND image together; the first that yields a real title
  // is authoritative (its image, or lack of one, is trusted) so we stop there.
  const rich = [
    { name: "oauth", run: () => tryOauth(fromPath.postId), oauth: true },
    { name: "opengraph", run: () => tryOg(url) },
    { name: "json", run: () => tryJson(url, "www.reddit.com") },
    { name: "old.reddit", run: () => tryOg(onHost(url, "old.reddit.com")) },
    { name: "old.json", run: () => tryJson(url, "old.reddit.com") },
  ];

  for (const s of rich) {
    if (s.oauth && !(redditOauthConfigured() && fromPath.postId)) continue;
    result.strategiesTried.push(s.name);
    absorb(await s.run());
    if (s.oauth && result.title) result.usedOauth = true;
    if (result.title) break; // first real title wins (image came with it, or stays null → placeholder)
  }

  // Outbound destination (link posts → a video/article on another site). The OG/HTML path
  // doesn't expose it and the title short-circuit above often stops before any JSON strategy
  // runs, so fetch it explicitly when still unknown. One JSON hit is authoritative (it tells us
  // the destination, or that it's a self/text post with none); only fall back to old.reddit if
  // the first request is blocked. Stays null when Reddit blocks JSON from this IP.
  if (!result.externalUrl) {
    for (const host of ["www.reddit.com", "old.reddit.com"]) {
      result.strategiesTried.push(`ext:${host}`);
      const p = await tryJson(url, host);
      if (p) { absorb(p); break; }
    }
  }

  // Wayback Machine: doubles as a metadata fallback (when still untitled) AND durable
  // preservation. Reuse an existing snapshot if there is one; otherwise create one with
  // Save Page Now so even brand-new posts get archived. archivedUrl is stored on the item.
  result.strategiesTried.push("wayback");
  let snapshotUrl = await waybackAvailable(url);
  if (snapshotUrl && (!result.title || !result.postDate)) absorb(await metaFromSnapshot(snapshotUrl));
  if (!snapshotUrl && wantArchive()) {
    result.strategiesTried.push("wayback-save");
    const saved = await tryWaybackSave(url);
    if (saved) {
      snapshotUrl = saved.snapshotUrl;
      absorb(saved);
    }
  }
  result.archivedUrl = snapshotUrl || null;

  // "Thin" strategies: title-focused fallbacks when nothing above worked.
  if (!result.title) {
    result.strategiesTried.push("oembed");
    absorb(await tryOembed(url));
  }
  // RSS supplies a title AND a real <published> date. Run it when either is still missing —
  // the title often arrives early (OpenGraph) while postDate doesn't, and the grouped view
  // needs the date, so don't gate this solely on a missing title.
  if (!result.title || !result.postDate) {
    result.strategiesTried.push("rss");
    absorb(await tryRss(url));
  }
  if (!result.title) {
    result.strategiesTried.push("url-derived");
    result.title = fromPath.titleFromSlug || (fromPath.subreddit ? `Reddit post in r/${fromPath.subreddit}` : "Reddit post");
  }

  // Generic Reddit thumbnail when nothing usable was found.
  if (!result.image) {
    result.image = REDDIT_PLACEHOLDER;
    result.usedPlaceholder = true;
  }

  return result;
}
