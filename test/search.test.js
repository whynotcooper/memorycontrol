import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addToIndex, buildIndex, editDistance, fuzzyCandidates, removeFromIndex,
  searchEntries, tokenize,
} from "../lib/search.js";
import { parseQuery } from "../lib/query.js";

function entry(id, over = {}) {
  return {
    id,
    kind: over.kind ?? "note",
    title: over.title ?? "",
    content: over.content ?? "",
    tags: over.tags ?? [],
    importance: over.importance ?? 3,
    scope: over.scope ?? "workspace",
    workspace: over.workspace ?? "/ws",
    links: over.links ?? [],
    createdAt: over.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: over.updatedAt ?? "2026-01-01T00:00:00.000Z",
  };
}

test("tokenize: latin words, numbers, CJK bigrams", () => {
  assert.deepEqual(tokenize("Token refresh 123"), ["token", "refresh", "123"]);
  const cjk = tokenize("令牌刷新");
  assert.ok(cjk.includes("令牌"));
  assert.ok(cjk.includes("牌刷"));
  assert.ok(cjk.includes("刷新"));
  assert.deepEqual(tokenize("单"), ["单"]);
  assert.deepEqual(tokenize(null), []);
});

test("editDistance is bounded and correct", () => {
  assert.equal(editDistance("token", "token", 3), 0);
  assert.equal(editDistance("token", "tokn", 3), 1);
  assert.equal(editDistance("abc", "xyz", 1), 2);
});

test("fuzzyCandidates finds near terms", () => {
  const vocab = new Set(["token", "tokens", "refresh", "other"]);
  const subs = fuzzyCandidates("tokn", vocab);
  assert.ok(subs.some((s) => s.term === "token"));
});

test("searchEntries: relevance ranks title matches above content matches", () => {
  const entries = [
    entry("a", { title: "JWT token refresh design", content: "how we refresh", updatedAt: "2026-02-01T00:00:00.000Z" }),
    entry("b", { title: "Other", content: "the token refresh happens in auth", updatedAt: "2026-01-01T00:00:00.000Z" }),
    entry("c", { title: "Unrelated", content: "nothing here", updatedAt: "2026-03-01T00:00:00.000Z" }),
  ];
  const index = buildIndex(entries);
  const q = parseQuery("token refresh");
  const { hits } = searchEntries({ entries, index, q, limit: 10, offset: 0 });
  assert.equal(hits[0].id, "a");
  assert.equal(hits.length, 2);
});

test("searchEntries: phrase must appear", () => {
  const entries = [entry("a", { content: "the quick brown fox" }), entry("b", { content: "quick fox" })];
  const index = buildIndex(entries);
  const q = parseQuery('"quick brown"');
  const { hits } = searchEntries({ entries, index, q });
  assert.deepEqual(hits.map((h) => h.id), ["a"]);
});

test("searchEntries: must and without filters", () => {
  const entries = [entry("a", { content: "alpha beta" }), entry("b", { content: "alpha" }), entry("c", { content: "beta" })];
  const index = buildIndex(entries);
  const q = parseQuery("+alpha -beta");
  const { hits } = searchEntries({ entries, index, q });
  assert.deepEqual(hits.map((h) => h.id), ["b"]);
});

test("searchEntries: structured filters and paging", () => {
  const entries = [
    entry("a", { kind: "decision", tags: ["auth"], importance: 5 }),
    entry("b", { kind: "fact", tags: ["auth"], importance: 2 }),
    entry("c", { kind: "fact", tags: ["other"], importance: 4 }),
  ];
  const index = buildIndex(entries);
  const q = parseQuery("kind:fact tag:auth");
  const { hits, total } = searchEntries({ entries, index, q, limit: 10, offset: 0 });
  assert.equal(total, 1);
  assert.equal(hits[0].id, "b");
});

test("searchEntries: importance ordering", () => {
  const entries = [
    entry("low", { importance: 1, updatedAt: "2026-03-01T00:00:00.000Z" }),
    entry("high", { importance: 5, updatedAt: "2026-02-01T00:00:00.000Z" }),
    entry("mid", { importance: 3, updatedAt: "2026-01-01T00:00:00.000Z" }),
  ];
  const index = buildIndex(entries);
  const q = parseQuery("");
  const { hits } = searchEntries({ entries, index, q, orderBy: "importance", limit: 10 });
  assert.deepEqual(hits.map((h) => h.id), ["high", "mid", "low"]);
});

test("searchEntries: browse mode (empty query) returns all filtered entries", () => {
  const entries = [entry("a", { content: "hello" }), entry("b", { content: "world" })];
  const index = buildIndex(entries);
  const q = parseQuery("");
  const { hits, total } = searchEntries({ entries, index, q });
  assert.equal(total, 2);
  assert.equal(hits.length, 2);
});

test("index maintenance: add/remove updates postings", () => {
  const e1 = entry("a", { content: "unique term" });
  const index = buildIndex([]);
  addToIndex(index, e1);
  assert.ok(index.has("unique"));
  removeFromIndex(index, e1);
  assert.ok(!index.has("unique"));
});

test("fuzzy search recovers misspelled terms", () => {
  const entries = [entry("a", { title: "token refresh", content: "auth flow" })];
  const index = buildIndex(entries);
  const q = parseQuery("tokn refres");
  const { hits, fuzzy } = searchEntries({ entries, index, q, limit: 10 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, "a");
  assert.equal(fuzzy, true);
});
