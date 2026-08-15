/**
 * Shared low-level helpers for self-memorycontrol.
 * No external dependencies — only Node builtins.
 */
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync,
  readFileSync, renameSync, writeSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

/** Current time as an ISO-8601 string. */
export function nowIso() {
  return new Date().toISOString();
}

/** Generate a new memory entry id. */
export function newId() {
  return `mem_${randomBytes(8).toString("hex")}`;
}

/** The harness home directory ($DSH_HOME, falling back to ~/.dsh). */
export function homeRoot() {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}

/** Resolve the configured memory storage root. */
export function memoryRoot(root) {
  if (typeof root === "string" && root.trim() !== "") return resolve(root.trim());
  return join(homeRoot(), "memory");
}

/** Normalize an absolute path to forward slashes (stable string form). */
export function normPath(p) {
  if (!p) return "";
  return resolve(String(p)).split(sep).join("/");
}

/** Atomically write JSON: temp file + fsync + rename. */
export function atomicWriteJson(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const body = JSON.stringify(data, null, 2);
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, body, null, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

/** Read and parse a JSON file; return null when missing or malformed. */
export function readJson(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Clamp a number into the importance range 1..5 (default 3). */
export function clampImportance(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 3;
  return Math.min(5, Math.max(1, n));
}

/**
 * Parse a date-ish value into an ISO string, or null.
 * Accepts ISO-8601 timestamps, `YYYY-MM-DD` (start of day), and relative
 * offsets like `7d`, `2w`, `3mo`, `1y` (that many units ago).
 */
export function parseDateInput(v, { endOfDay = false } = {}) {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v).trim();
  if (s === "") return null;
  const rel = /^(\d+)(mo|w|d|m|q|y)$/i.exec(s);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const now = new Date();
    if (unit === "d") now.setUTCDate(now.getUTCDate() - n);
    else if (unit === "w") now.setUTCDate(now.getUTCDate() - n * 7);
    else if (unit === "m" || unit === "mo") now.setUTCMonth(now.getUTCMonth() - n);
    else if (unit === "q") now.setUTCMonth(now.getUTCMonth() - n * 3);
    else if (unit === "y") now.setUTCFullYear(now.getUTCFullYear() - n);
    return now.toISOString();
  }
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(s)) d.setUTCHours(23, 59, 59, 999);
  return d.toISOString();
}

/** Whether a string is a valid ISO-parseable date. */
export function isValidDate(s) {
  return typeof s === "string" && s !== "" && !Number.isNaN(Date.parse(s));
}
