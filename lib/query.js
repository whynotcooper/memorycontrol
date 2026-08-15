/**
 * Structured query DSL parser.
 *
 * memorycontrol accepts a small database-like query language so the model (and
 * the web UI) can search memory by structure, not just by keywords:
 *
 *   free terms                 full-text terms (ranked)
 *   +term                      term must be present
 *   -term                      term must be absent
 *   "exact phrase"             phrase must appear (title or content)
 *   kind:decision              filter by entry kind (repeatable = OR)
 *   tag:auth  tag:"api design" filter by tag (repeatable = OR)
 *   scope:global|workspace     filter by scope
 *   workspace:/abs/path        filter by workspace (absolute path)
 *   link:mem_abc               entries linking to mem_abc
 *   importance:>3  <2  >=4     importance range
 *   since:2026-01-01           createdAt >= value (also 7d / 2w / 3mo / 1y)
 *   until:2026-06-01           createdAt <= value (end of day for YYYY-MM-DD)
 *   created:>x  updated:<x     ranges on those timestamps
 */
import { parseDateInput } from "./util.js";

const KNOWN_FIELDS = new Set([
  "kind", "kinds", "tag", "tags", "scope", "workspace", "link",
  "importance", "since", "until", "created", "updated", "expires",
]);

/**
 * Tokenize the raw query, respecting double-quoted phrases even when they
 * appear inside a field value (e.g. tag:"api design").
 */
export function tokenizeDsl(input) {
  const tokens = [];
  const s = String(input);
  let i = 0;
  let cur = "";
  let inQuote = false;
  const flush = () => {
    if (cur !== "") {
      tokens.push({ kind: "raw", value: cur });
      cur = "";
    }
  };
  while (i < s.length) {
    const ch = s[i];
    if (ch === '"') {
      inQuote = !inQuote;
      cur += '"';
      i += 1;
      continue;
    }
    if (!inQuote && (ch === " " || ch === "\t" || ch === "\n" || ch === "\r")) {
      flush();
      i += 1;
      continue;
    }
    cur += ch;
    i += 1;
  }
  flush();
  // A token that is exactly a quoted string is a phrase.
  return tokens.map((t) => {
    if (t.value.length >= 2 && t.value.startsWith('"') && t.value.endsWith('"')) {
      return { kind: "phrase", value: t.value.slice(1, -1) };
    }
    return t;
  });
}

/** Strip surrounding quotes from a field value. */
function unquote(value) {
  const v = value.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1).trim();
  return v;
}

function applyFilter(q, field, rawValue) {
  const value = unquote(rawValue);
  if (value === "") return;
  if (field === "kind" || field === "kinds") {
    q.filters.kinds.push(value);
    return;
  }
  if (field === "tag" || field === "tags") {
    q.filters.tags.push(value);
    return;
  }
  if (field === "scope") {
    if (value === "global" || value === "workspace" || value === "all") {
      q.filters.scopes.push(value);
    }
    return;
  }
  if (field === "workspace") {
    q.filters.workspace = value;
    return;
  }
  if (field === "link") {
    q.filters.link = value;
    return;
  }
  if (field === "importance") {
    const { op, num } = parseOpNumber(value);
    if (num === null) return;
    if (op === "gt") q.filters.importanceMin = num;
    else if (op === "lt") q.filters.importanceMax = num;
    else if (op === "gte") q.filters.importanceMin = Math.max(q.filters.importanceMin ?? -Infinity, num);
    else if (op === "lte") q.filters.importanceMax = Math.min(q.filters.importanceMax ?? Infinity, num);
    else {
      q.filters.importanceMin = num;
      q.filters.importanceMax = num;
    }
    return;
  }
  if (field === "since") {
    const d = parseDateInput(value);
    if (d) q.filters.createdSince = d;
    return;
  }
  if (field === "until") {
    const d = parseDateInput(value, { endOfDay: true });
    if (d) q.filters.createdUntil = d;
    return;
  }
  if (field === "created" || field === "updated" || field === "expires") {
    const key = field === "created" ? "created" : field === "updated" ? "updated" : "expires";
    const { op, rest } = parseOpText(value);
    const d = parseDateInput(rest, { endOfDay: op === "lt" || op === "lte" });
    if (!d) return;
    if (op === "gt" || op === "gte") q.filters[`${key}Since`] = d;
    else if (op === "lt" || op === "lte") q.filters[`${key}Until`] = d;
    else {
      q.filters[`${key}Since`] = d;
      q.filters[`${key}Until`] = parseDateInput(rest, { endOfDay: true });
    }
  }
}

function parseOpNumber(value) {
  const m = /^(>=|<=|>|<)?\s*([+-]?\d+(?:\.\d+)?)$/.exec(value);
  if (!m) return { op: null, num: null };
  const num = Number(m[2]);
  if (!Number.isFinite(num)) return { op: null, num: null };
  return { op: opName(m[1]), num };
}

function parseOpText(value) {
  const m = /^(>=|<=|>|<)(.*)$/.exec(value);
  if (!m) return { op: null, rest: value };
  return { op: opName(m[1]), rest: m[2].trim() };
}

/** Map a comparison symbol to a stable word: '>' -> 'gt', etc. */
function opName(symbol) {
  switch (symbol) {
    case ">": return "gt";
    case "<": return "lt";
    case ">=": return "gte";
    case "<=": return "lte";
    default: return "eq";
  }
}

/**
 * Parse a query string into a normalized query object.
 * @param {string} input
 * @returns {{ text: string[], phrase: string|null, must: string[], without: string[], filters: object }}
 */
export function parseQuery(input) {
  const q = {
    text: [],
    phrase: null,
    must: [],
    without: [],
    filters: {
      kinds: [],
      tags: [],
      scopes: [],
      workspace: null,
      link: null,
      importanceMin: null,
      importanceMax: null,
      createdSince: null,
      createdUntil: null,
      updatedSince: null,
      updatedUntil: null,
      expiresSince: null,
      expiresUntil: null,
    },
  };
  if (!input) return q;
  for (const tok of tokenizeDsl(input)) {
    if (tok.kind === "phrase") {
      if (tok.value.trim() !== "") q.phrase = tok.value.trim();
      continue;
    }
    const raw = tok.value.trim();
    if (raw === "") continue;
    if (raw.startsWith("+")) {
      const t = raw.slice(1);
      if (t) q.must.push(t);
      continue;
    }
    if (raw.startsWith("-")) {
      const t = raw.slice(1);
      if (t) q.without.push(t);
      continue;
    }
    const m = /^([a-zA-Z_]+):(.*)$/.exec(raw);
    if (m && KNOWN_FIELDS.has(m[1]) && m[2] !== undefined) {
      applyFilter(q, m[1], m[2]);
      continue;
    }
    q.text.push(raw);
  }
  return q;
}
