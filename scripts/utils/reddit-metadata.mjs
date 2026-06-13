// reddit-metadata.mjs
// Reddit needs special handling: it blocks the default fetch User-Agent, rate-limits,
// and serves an interstitial to bots. We try several no-auth strategies in order and
// degrade gracefully — a blocked/empty Reddit response must never crash the run.
//
// Order:
//   1) Standard page / Open Graph metadata (via fetch-metadata).
//   2) Reddit JSON endpoint (append `.json` to the permalink) with a custom UA.
//   3) Reddit oEmbed endpoint.
//   4) URL-derived metadata (subreddit + post id from the path).

import { fetchMetadata, fetchWithTimeout } from "./fetch-metadata.mjs";

const REDDIT_UA = "world-cup-archive/1.0 (static link archive; no auth)";

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
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

function usableThumb(t) {
  if (!t || typeof t !== "string") return null;
  if (PLACEHOLDER_THUMBS.has(t.toLowerCase())) return null;
  if (!/^https?:\/\//i.test(t)) return null;
  return htmlDecode(t);
}

// Reddit sometimes returns HTTP 200 with a bot-check / "please wait" interstitial that
// still carries an og:title. Such titles (and the generic homepage title) are useless and
// must not pre-empt the URL-derived fallback.
function looksBlocked(s) {
  if (!s) return false;
  return /please wait|whoa there|verifying you are human|are you a robot|just a moment|enable javascript|access denied|you'?ve been blocked|dive into anything/i.test(s);
}

/** Strategy 2: the public .json endpoint. Returns partial metadata or null. */
async function tryRedditJson(url) {
  let jsonUrl = url.split("#")[0].split("?")[0];
  jsonUrl = jsonUrl.replace(/\/+$/, "") + "/.json";
  try {
    const res = await fetchWithTimeout(jsonUrl, { headers: { "User-Agent": REDDIT_UA, Accept: "application/json" } }, 10000);
    if (!res.ok) return null;
    const data = await res.json();
    const post = data?.[0]?.data?.children?.[0]?.data;
    if (!post) return null;

    // Prefer the highest-resolution preview image, then media/oembed, then thumbnail.
    let image =
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
      permalink: post.permalink ? `https://www.reddit.com${post.permalink}` : null,
      over18: !!post.over_18,
      linkUrl: post.url_overridden_by_dest || post.url || null,
    };
  } catch {
    return null;
  }
}

/** Strategy 3: the oEmbed endpoint. Returns partial metadata or null. */
async function tryRedditOembed(url) {
  const oembed = `https://www.reddit.com/oembed?url=${encodeURIComponent(url)}`;
  try {
    const res = await fetchWithTimeout(oembed, { headers: { "User-Agent": REDDIT_UA, Accept: "application/json" } }, 9000);
    if (!res.ok) return null;
    const data = await res.json();
    return {
      title: htmlDecode(data.title) || null,
      subreddit: null,
      image: usableThumb(data.thumbnail_url),
      author: data.author_name || null,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch Reddit metadata via the cascade.
 * Always resolves to a normalized metadata object shaped like fetchMetadata's output
 * plus `subreddit`, `createdUtc`, and `strategiesTried`.
 */
export async function fetchRedditMetadata(url) {
  const fromPath = parseRedditPath(url);
  const result = {
    requestUrl: url,
    finalUrl: url,
    source: "Reddit",
    title: null,
    description: null,
    siteName: "Reddit",
    canonicalUrl: fromPath.postId
      ? `https://www.reddit.com/r/${fromPath.subreddit}/comments/${fromPath.postId}`
      : null,
    image: null,
    subreddit: fromPath.subreddit || null,
    createdUtc: null,
    usedPlaceholder: false,
    strategiesTried: [],
    error: null,
  };

  // Strategy 1: standard OG metadata — but reject bot-check interstitial titles/images so
  // we fall through to the structured / URL-derived strategies below.
  try {
    const og = await fetchMetadata(url);
    result.strategiesTried.push("opengraph");
    const ogUsable = og.title && !looksBlocked(og.title);
    if (ogUsable) {
      result.title = result.title || og.title;
      if (og.image) result.image = result.image || og.image;
      if (og.canonicalUrl) result.canonicalUrl = og.canonicalUrl;
    }
    if (og.description && !looksBlocked(og.description)) result.description = result.description || og.description;
  } catch {
    /* keep going */
  }

  // Strategy 2: JSON endpoint (best structured source).
  const j = await tryRedditJson(url);
  result.strategiesTried.push("json");
  if (j) {
    result.title = result.title || j.title;
    result.description = result.description || j.description;
    result.image = result.image || j.image;
    result.subreddit = result.subreddit || j.subreddit;
    result.createdUtc = result.createdUtc || j.createdUtc;
    if (j.permalink) result.canonicalUrl = j.permalink;
  }

  // Strategy 3: oEmbed (title + thumbnail).
  if (!result.title || !result.image) {
    const o = await tryRedditOembed(url);
    result.strategiesTried.push("oembed");
    if (o) {
      result.title = result.title || o.title;
      result.image = result.image || o.image;
    }
  }

  // Strategy 4: URL-derived fallback.
  if (!result.title) {
    result.title = fromPath.titleFromSlug || (fromPath.subreddit ? `Reddit post in r/${fromPath.subreddit}` : "Reddit post");
    result.strategiesTried.push("url-derived");
  }

  // Generic Reddit thumbnail when nothing usable was found.
  if (!result.image) {
    result.image = REDDIT_PLACEHOLDER;
    result.usedPlaceholder = true;
  }

  return result;
}
