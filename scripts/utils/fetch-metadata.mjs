// fetch-metadata.mjs
// Fetch a URL and extract standard web metadata (Open Graph, Twitter Card, JSON-LD,
// <title>, meta description, canonical link, oEmbed discovery).
//
// Design rule: NEVER throw to the caller. On any failure (network, timeout, non-HTML,
// non-200) return a partial object with `error` set and whatever could be derived from
// the URL itself. One bad URL must never crash a batch run.

import * as cheerio from "cheerio";

const DEFAULT_TIMEOUT_MS = 12000;
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** Map a hostname to a human-friendly source name. */
export function sourceFromHost(host = "") {
  const h = host.toLowerCase();
  if (h.includes("reddit.com") || h.includes("redd.it")) return "Reddit";
  if (h.includes("youtube.com") || h.includes("youtu.be")) return "YouTube";
  if (h.includes("twitter.com") || h.includes("x.com")) return "X/Twitter";
  if (h.includes("tiktok.com")) return "TikTok";
  if (h.includes("instagram.com")) return "Instagram";
  if (h.includes("facebook.com") || h.includes("fb.watch")) return "Facebook";
  if (h.includes("bsky.app")) return "Bluesky";
  if (h.includes("threads.net")) return "Threads";
  if (h.includes("imgur.com")) return "Imgur";
  if (h.includes("twitch.tv")) return "Twitch";
  return null;
}

/** fetch() with a timeout via AbortController. Returns the Response or throws. */
export async function fetchWithTimeout(url, opts = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Spread opts first (method, body, …), then enforce signal/redirect and merge headers
    // last so caller headers compose with the defaults instead of replacing the whole object.
    return await fetch(url, {
      redirect: "follow",
      ...opts,
      signal: controller.signal,
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        ...(opts.headers || {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

function firstString(...vals) {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/** Parse a date string to a normalized ISO timestamp, or null if absent/implausible. */
export function normalizeDate(s) {
  if (!s || typeof s !== "string") return null;
  const d = new Date(s.trim());
  if (isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  if (y < 1990 || y > 2100) return null; // guard against garbage parses
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Pull name/headline/image/date out of any JSON-LD blocks (handles arrays + @graph). */
function parseJsonLd($) {
  const out = { name: null, description: null, image: null, datePublished: null };
  $('script[type="application/ld+json"]').each((_, el) => {
    let data;
    try {
      data = JSON.parse($(el).contents().text());
    } catch {
      return;
    }
    const nodes = [];
    const collect = (d) => {
      if (!d) return;
      if (Array.isArray(d)) return d.forEach(collect);
      if (typeof d === "object") {
        nodes.push(d);
        if (Array.isArray(d["@graph"])) d["@graph"].forEach(collect);
      }
    };
    collect(data);
    for (const n of nodes) {
      out.name = out.name || firstString(n.headline, n.name, n.title);
      out.description = out.description || firstString(n.description);
      out.datePublished = out.datePublished || firstString(n.datePublished, n.uploadDate, n.dateCreated);
      if (!out.image) {
        const img = n.image || n.thumbnailUrl;
        if (typeof img === "string") out.image = img;
        else if (Array.isArray(img)) out.image = firstString(...img.map((x) => (typeof x === "string" ? x : x?.url)));
        else if (img && typeof img === "object") out.image = firstString(img.url);
      }
    }
  });
  return out;
}

/** Resolve a possibly-relative URL against the page URL. */
function absoluteUrl(maybeUrl, baseUrl) {
  if (!maybeUrl) return null;
  try {
    return new URL(maybeUrl, baseUrl).toString();
  } catch {
    return maybeUrl;
  }
}

/**
 * Fetch and extract metadata for `url`.
 * Always resolves to an object; check `.error` to know if the fetch failed.
 */
export async function fetchMetadata(url, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const result = {
    requestUrl: url,
    finalUrl: url,
    source: sourceFromHost(safeHost(url)),
    title: null,
    description: null,
    siteName: null,
    canonicalUrl: null,
    image: null,
    postDate: null,
    oembedUrl: null,
    error: null,
  };

  let res;
  try {
    res = await fetchWithTimeout(url, {}, timeoutMs);
  } catch (err) {
    result.error = err.name === "AbortError" ? "timeout" : `fetch failed: ${err.message}`;
    return result;
  }

  result.finalUrl = res.url || url;
  if (!res.ok) {
    result.error = `http ${res.status}`;
    return result;
  }

  const contentType = (res.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("html") && !contentType.includes("xml")) {
    // Not an HTML page (e.g. a direct image or video). Still useful as a thumbnail.
    if (contentType.startsWith("image/")) result.image = result.finalUrl;
    result.error = `non-html content-type: ${contentType || "unknown"}`;
    return result;
  }

  let html;
  try {
    html = await res.text();
  } catch (err) {
    result.error = `read body failed: ${err.message}`;
    return result;
  }

  try {
    const $ = cheerio.load(html);
    const meta = (sel) => $(sel).attr("content");

    const jsonLd = parseJsonLd($);

    result.title = firstString(
      meta('meta[property="og:title"]'),
      meta('meta[name="twitter:title"]'),
      jsonLd.name,
      $("title").first().text(),
    );
    result.description = firstString(
      meta('meta[property="og:description"]'),
      meta('meta[name="twitter:description"]'),
      meta('meta[name="description"]'),
      jsonLd.description,
    );
    result.siteName = firstString(
      meta('meta[property="og:site_name"]'),
      meta('meta[name="application-name"]'),
    );
    result.canonicalUrl = absoluteUrl(
      firstString($('link[rel="canonical"]').attr("href"), meta('meta[property="og:url"]')),
      result.finalUrl,
    );
    result.image = absoluteUrl(
      firstString(
        meta('meta[property="og:image:secure_url"]'),
        meta('meta[property="og:image"]'),
        meta('meta[name="twitter:image"]'),
        meta('meta[name="twitter:image:src"]'),
        jsonLd.image,
      ),
      result.finalUrl,
    );
    result.oembedUrl = absoluteUrl(
      firstString(
        $('link[type="application/json+oembed"]').attr("href"),
        $('link[type="text/json+oembed"]').attr("href"),
      ),
      result.finalUrl,
    );
    result.postDate = normalizeDate(
      firstString(
        meta('meta[property="article:published_time"]'),
        meta('meta[property="og:article:published_time"]'),
        meta('meta[name="article:published_time"]'),
        meta('meta[itemprop="datePublished"]'),
        meta('meta[name="date"]'),
        meta('meta[name="pubdate"]'),
        meta('meta[name="publish-date"]'),
        meta('meta[name="parsely-pub-date"]'),
        $("time[datetime]").first().attr("datetime"),
        jsonLd.datePublished,
      ),
    );

    if (!result.source && result.siteName) result.source = result.siteName;
    if (!result.source) result.source = "Article";
  } catch (err) {
    result.error = `parse failed: ${err.message}`;
  }

  return result;
}

function safeHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
