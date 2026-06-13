// file-utils.mjs
// Small, dependency-free helpers for reading/writing the archive's JSON files.
// Goals: pretty, human-readable output; never corrupt a file on a crash mid-write
// (write to a temp file then rename); keep a .bak copy before overwriting important data.

import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Project root is two levels up from scripts/utils/
export const ROOT = path.resolve(__dirname, "..", "..");
export const DATA_DIR = path.join(ROOT, "data");
export const ASSETS_DIR = path.join(ROOT, "assets");
export const THUMBS_DIR = path.join(ASSETS_DIR, "thumbs");

export const PATHS = {
  items: path.join(DATA_DIR, "items.json"),
  matches: path.join(DATA_DIR, "matches.json"),
  teamAliases: path.join(DATA_DIR, "team-aliases.json"),
  stageAliases: path.join(DATA_DIR, "stage-aliases.json"),
};

export async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

/** Read and parse a JSON file. Returns `fallback` if the file does not exist. */
export async function readJson(p, fallback = undefined) {
  if (!(await fileExists(p))) {
    if (fallback !== undefined) return fallback;
    throw new Error(`File not found: ${p}`);
  }
  const raw = await fs.readFile(p, "utf8");
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in ${p}: ${err.message}`);
  }
}

/** Copy `p` to `p.bak` (best effort). Used before overwriting important files. */
export async function backupFile(p) {
  if (!(await fileExists(p))) return false;
  try {
    await fs.copyFile(p, `${p}.bak`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write `data` as pretty JSON to `p` atomically: write a sibling temp file, then
 * rename over the target. A crash mid-write leaves the original intact.
 */
export async function writeJson(p, data) {
  await ensureDir(path.dirname(p));
  const json = JSON.stringify(data, null, 2) + "\n";
  const tmp = `${p}.tmp-${process.pid}`;
  await fs.writeFile(tmp, json, "utf8");
  await fs.rename(tmp, p);
  return json;
}

/** Verify a file on disk parses as JSON. Returns { ok, error }. */
export async function validateJsonFile(p) {
  try {
    const raw = await fs.readFile(p, "utf8");
    JSON.parse(raw);
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Deterministic short id from a string (stable across runs → dedupe-friendly). */
export function makeId(seed) {
  return crypto.createHash("sha1").update(String(seed)).digest("hex").slice(0, 12);
}

/** Current time as an ISO timestamp (UTC, no ms). */
export function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}
