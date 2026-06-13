// normalize-url.mjs
// Normalize a submitted URL into a canonical, comparable form and produce a set of
// equivalent "variants" so the same link submitted in different shapes is detected
// as a duplicate. Pure functions, no I/O.

// Query parameters that never identify content — safe to strip everywhere.
const TRACKING_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_name",
  "fbclid", "gclid", "dclid", "msclkid", "yclid", "igshid", "mc_cid", "mc_eid",
  "ref", "ref_source", "ref_url", "referrer", "source", "share_id", "rdt",
  "_branch_match_id", "spm", "scwx", "context", "$deep_link", "correlation_id",
]);

// Hosts that should collapse to a single canonical host for comparison.
const HOST_CANONICAL = {
  "old.reddit.com": "www.reddit.com",
  "new.reddit.com": "www.reddit.com",
  "np.reddit.com": "www.reddit.com",
  "m.reddit.com": "www.reddit.com",
  "i.reddit.com": "www.reddit.com",
  "reddit.com": "www.reddit.com",
  "m.youtube.com": "www.youtube.com",
  "youtube.com": "www.youtube.com",
  "mobile.twitter.com": "twitter.com",
  "www.twitter.com": "twitter.com",
  "x.com": "twitter.com",
  "www.x.com": "twitter.com",
};

function stripTrailingSlash(pathname) {
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.replace(/\/+$/, "");
  return pathname;
}

/** Best-effort URL parse. Adds https:// if no scheme was supplied. */
export function parseUrl(raw) {
  let input = String(raw || "").trim();
  if (!input) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) input = "https://" + input;
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

/**
 * Normalize a URL.
 * Returns { ok, original, normalized, host, canonicalHost, variants }.
 * `normalized` is the primary comparison key; `variants` are additional equivalent
 * forms (e.g. youtu.be vs youtube.com/watch) used for duplicate detection.
 */
export function normalizeUrl(raw) {
  const original = String(raw || "").trim();
  const u = parseUrl(original);
  if (!u) return { ok: false, original, normalized: original, host: null, canonicalHost: null, variants: [] };

  // Force https for http(s) URLs.
  if (u.protocol === "http:") u.protocol = "https:";

  const rawHost = u.hostname.toLowerCase();
  const canonicalHost = HOST_CANONICAL[rawHost] || rawHost;

  // Drop tracking params; keep the rest, sorted for a stable key.
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !TRACKING_PARAMS.has(k.toLowerCase()))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const pathname = stripTrailingSlash(u.pathname);

  const buildKey = (host) => {
    const search = params.length ? "?" + params.map(([k, v]) => `${k}=${v}`).join("&") : "";
    return `https://${host}${pathname}${search}`;
  };

  const normalized = buildKey(canonicalHost);

  // Equivalent variants for duplicate detection.
  const variants = new Set([normalized, buildKey(rawHost)]);

  // youtu.be/<id>  <->  youtube.com/watch?v=<id>
  if (rawHost === "youtu.be") {
    const id = pathname.replace(/^\//, "");
    if (id) variants.add(`https://www.youtube.com/watch?v=${id}`);
  }
  if (canonicalHost === "www.youtube.com" && u.searchParams.get("v")) {
    variants.add(`https://youtu.be/${u.searchParams.get("v")}`);
  }

  // Reddit: a permalink with or without the trailing title slug is the same post.
  // /r/<sub>/comments/<id>/<slug>  ==  /r/<sub>/comments/<id>
  const redditMatch = pathname.match(/^(\/r\/[^/]+\/comments\/[^/]+)(\/.*)?$/i);
  if (canonicalHost === "www.reddit.com" && redditMatch) {
    variants.add(`https://www.reddit.com${redditMatch[1]}`);
  }

  return {
    ok: true,
    original,
    normalized,
    host: rawHost,
    canonicalHost,
    variants: [...variants],
  };
}
