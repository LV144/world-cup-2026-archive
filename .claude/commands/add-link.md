---
description: Add URL(s) to the World Cup 2026 archive — fetch metadata, infer match, archive, confirm result, enrich, validate, publish
argument-hint: <url> [<url> ...] [Tag ...]
---

Add the following URL(s) to the World Cup 2026 archive by invoking the **add-link** skill and
following its full procedure (add → review → confirm any result without inventing it → enrich →
validate → commit & push):

$ARGUMENTS

Any **non-URL words** above are tags to **pin** on the added item(s) — e.g. `<url> Banger` pins
the `Banger` tag. Pinned tags apply to all URLs in this run and persist through future enrichment.

If no URLs are provided above, ask me for them first.
