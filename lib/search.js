/**
 * Tokenizer, inverted index, and ranked search for memory entries.
 *
 * Lexical search is dependency-free: Latin words + CJK bigrams are indexed with
 * field weights and TF-IDF-style scoring, boosted by importance and recency.
 * Optional semantic search (see semantic.js) can be blended in as a reranker.
 */
import { parseQuery } from "./query.js";

/** Field weights applied to term counts. */
const FIELD_WEIGHTS = {
  title: 3.5,
  tags: 3.0,
  kind: 2.0,
  id: 2.0,
  links: 1.5,
  content: 1.0,
};

const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff\uac00-\ud7af]/;
const LATIN_RE = /[a-z0-9]+(?:['-][a-z0-9]+)*/g;

/**
 * Tokenize text for indexing/searching: lowercase Latin words/numbers and
 * CJK bigrams (single CJK chars stay unigrams). Output is de-duplicated.
 * @param {*} text
 * @returns {string[]}
 */
export function tokenize(text) {
  if (text === null || text === undefined) return [];
  const s = String(text).toLowerCase();
  const out = new Set();
  for (const m of s.matchAll(LATIN_RE)) {
    const w = m[0];
    if (w.length <= 64) out.add(w);
  }
  // CJK runs → bigrams, or the single char when the run has length 1.
  let run = "";
  const flush = () => {
    if (run.length === 0) return;
    if (run.length === 1) {
      out.add(run);
    } else {
      for (let i = 0; i + 1 < run.length; i += 1) out.add(run.slice(i, i + 2));
    }
    run = "";
  };
  for (const ch of s) {
    if (CJK_RE.test(ch)) run += ch;
    else flush();
  }
  flush();
  return [...out];
}

/** Collect the weighted term multiset of one entry. */
export function entryTerms(entry) {
  const out = new Map();
  const bump = (text, weight) => {
    for (const t of tokenize(text)) out.set(t, (out.get(t) ?? 0) + weight);
  };
  bump(entry.title, FIELD_WEIGHTS.title);
  if (Array.isArray(entry.tags)) for (const tag of entry.tags) bump(tag, FIELD_WEIGHTS.tags);
  bump(entry.kind, FIELD_WEIGHTS.kind);
  bump(entry.id, FIELD_WEIGHTS.id);
  if (Array.isArray(entry.links)) for (const link of entry.links) bump(link, FIELD_WEIGHTS.links);
  bump(entry.content, FIELD_WEIGHTS.content);
  return out;
}

/** Build an inverted index: term -> Map(entryId -> weighted count). */
export function buildIndex(entries) {
  const index = new Map();
  for (const entry of entries) addToIndex(index, entry);
  return index;
}

/** Add one entry's terms to the index. */
export function addToIndex(index, entry) {
  for (const [term, w] of entryTerms(entry)) {
    let posting = index.get(term);
    if (!posting) {
      posting = new Map();
      index.set(term, posting);
    }
    posting.set(entry.id, (posting.get(entry.id) ?? 0) + w);
  }
}

/** Remove one entry's terms from the index. */
export function removeFromIndex(index, entry) {
  for (const term of entryTerms(entry).keys()) {
    const posting = index.get(term);
    if (!posting) continue;
    posting.delete(entry.id);
    if (posting.size === 0) index.delete(term);
  }
}

/** Levenshtein edit distance with bounded early exit. */
export function editDistance(a, b, max) {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  let prev = new Array(lb + 1);
  let cur = new Array(lb + 1);
  for (let j = 0; j <= lb; j += 1) prev[j] = j;
  for (let i = 1; i <= la; i += 1) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= lb; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  return prev[lb];
}

/**
 * Find close vocabulary terms for a term with no (or few) exact postings.
 * Returns [{ term, dist }] with bounded cost.
 */
export function fuzzyCandidates(term, vocab, maxCandidates = 4) {
  if (vocab.size === 0 || term.length < 3) return [];
  const results = [];
  for (const candidate of vocab) {
    const max = Math.max(1, Math.floor(term.length / 4));
    const d = editDistance(term, candidate, max);
    if (d <= max) results.push({ term: candidate, dist: d });
    if (results.length >= maxCandidates * 4) break;
  }
  results.sort((a, b) => a.dist - b.dist || a.term.length - b.term.length);
  return results.slice(0, maxCandidates);
}

const SNIPPET_CHARS = 240;

function makeSnippet(entry, phrase) {
  const text = entry.content || "";
  if (phrase) {
    const norm = String(phrase).toLowerCase();
    const idx = text.toLowerCase().indexOf(norm);
    if (idx !== -1) {
      const start = Math.max(0, idx - 60);
      const end = Math.min(text.length, idx + norm.length + 120);
      return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
    }
  }
  return text.length > SNIPPET_CHARS ? `${text.slice(0, SNIPPET_CHARS)}…` : text;
}

/** Whether an entry passes the hard filter set. */
function passesFilters(entry, f, nowMs) {
  if (f.kinds.length > 0 && !f.kinds.includes(entry.kind)) return false;
  if (f.tags.length > 0 && !(entry.tags ?? []).some((t) => f.tags.includes(t))) return false;
  if (f.scopes.length > 0 && !f.scopes.includes(entry.scope)) return false;
  if (f.workspace && entry.scope === "workspace" && entry.workspace !== f.workspace) return false;
  if (f.link && !(entry.links ?? []).includes(f.link)) return false;
  const imp = entry.importance ?? 3;
  if (f.importanceMin !== null && imp < f.importanceMin) return false;
  if (f.importanceMax !== null && imp > f.importanceMax) return false;
  const t = (iso) => (iso ? Date.parse(iso) : null);
  const created = t(entry.createdAt) ?? nowMs;
  const updated = t(entry.updatedAt) ?? nowMs;
  const expires = t(entry.expiresAt);
  if (f.createdSince && created < t(f.createdSince)) return false;
  if (f.createdUntil && created > t(f.createdUntil)) return false;
  if (f.updatedSince && updated < t(f.updatedSince)) return false;
  if (f.updatedUntil && updated > t(f.updatedUntil)) return false;
  if (f.expiresSince && (expires === null || expires < t(f.expiresSince))) return false;
  if (f.expiresUntil && expires !== null && expires > t(f.expiresUntil)) return false;
  return true;
}

function tokenMatches(entry, token) {
  const terms = entryTerms(entry);
  return terms.has(token);
}

/** Normalized phrase check on title+content. */
function phraseMatches(entry, phrase) {
  const hay = `${entry.title ?? ""}\n${entry.content ?? ""}`.toLowerCase();
  return hay.includes(String(phrase).toLowerCase());
}

/**
 * Ranked search over entries.
 * @param {object} opts
 * @param {Array} opts.entries          candidate entries (pre-filtered by scope)
 * @param {Map}   opts.index            inverted index over ALL entries (for idf)
 * @param {object} opts.q               parsed query (parseQuery result)
 * @param {string} opts.orderBy         relevance | updated | created | importance
 * @param {number} opts.limit
 * @param {number} opts.offset
 * @param {number} opts.nowMs
 * @returns {{ hits: object[], total: number, fuzzy: boolean }}
 */
export function searchEntries({ entries, index, q, orderBy = "relevance", limit = 10, offset = 0, nowMs = Date.now() }) {
  const f = q.filters;
  const N = Math.max(1, entries.length);
  const candidates = [];
  const scores = new Map();

  const phrase = q.phrase;
  const mustTokens = q.must.map((t) => t.toLowerCase());
  const withoutTokens = q.without.map((t) => t.toLowerCase());
  const queryTokens = q.text.map((t) => t.toLowerCase());

  let fuzzy = false;
  // Resolve fuzzy substitutes for query terms with no exact postings.
  const vocab = new Set(index.keys());
  const resolved = [];
  for (const term of queryTokens) {
    if (index.has(term)) {
      resolved.push({ term, weight: 1 });
    } else {
      const subs = fuzzyCandidates(term, vocab);
      if (subs.length > 0) {
        fuzzy = true;
        for (const sub of subs) resolved.push({ term: sub.term, weight: 0.5 });
      }
    }
  }
  // Browse mode: no free-text terms to resolve (phrase/must/without are pure
  // filters). Every filtered candidate scores 1 and ordering falls through to
  // `orderBy`. A present-but-unmatchable text term does NOT enter browse mode.
  const browseMode = queryTokens.length === 0;

  for (const entry of entries) {
    if (!passesFilters(entry, f, nowMs)) continue;
    if (phrase && !phraseMatches(entry, phrase)) continue;
    let skip = false;
    for (const t of mustTokens) {
      if (!tokenMatches(entry, t)) { skip = true; break; }
    }
    if (skip) continue;
    if (withoutTokens.length > 0) {
      for (const t of withoutTokens) {
        if (tokenMatches(entry, t)) { skip = true; break; }
      }
    }
    if (skip) continue;
    candidates.push(entry);
  }

  if (resolved.length > 0) {
    for (const entry of candidates) {
      let score = 0;
      let matched = 0;
      for (const { term, weight } of resolved) {
        const posting = index.get(term);
        if (!posting) continue;
        const count = posting.get(entry.id) ?? 0;
        if (count <= 0) continue;
        matched += 1;
        const df = Math.max(1, posting.size);
        const idf = Math.log2(1 + N / df);
        const tf = 1 + Math.log2(1 + count);
        score += idf * tf * weight;
      }
      if (matched === 0) continue;
      if (matched === resolved.length) score *= 1.35; // all terms present
      const imp = entry.importance ?? 3;
      score *= 1 + (imp - 3) * 0.12;
      const ageDays = Math.max(0, (nowMs - (Date.parse(entry.updatedAt) || nowMs)) / 86400000);
      score *= 1 + 0.25 / (1 + ageDays * 0.05);
      if (phrase) score *= 1.5;
      scores.set(entry.id, score);
    }
  } else if (browseMode) {
    // Browse mode: no query terms at all — everything in the filtered pool
    // scores 1, and ordering falls through to `orderBy` (relevance -> updated).
    for (const entry of candidates) scores.set(entry.id, 1);
  }

  const scored = candidates.filter((e) => scores.has(e.id));
  scored.sort((a, b) => {
    switch (orderBy) {
      case "updated": return (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);
      case "created": return (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0);
      case "importance": return (b.importance ?? 0) - (a.importance ?? 0) || (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);
      default: return scores.get(b.id) - scores.get(a.id);
    }
  });

  const total = scored.length;
  const page = scored.slice(offset, offset + limit);
  const hits = page.map((e) => ({
    id: e.id,
    kind: e.kind,
    title: e.title,
    snippet: makeSnippet(e, phrase),
    tags: e.tags ?? [],
    importance: e.importance ?? 3,
    scope: e.scope,
    workspace: e.workspace,
    links: e.links ?? [],
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    score: Math.round(scores.get(e.id) * 100) / 100,
  }));
  return { hits, total, fuzzy };
}
