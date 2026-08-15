import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQuery, tokenizeDsl } from "../lib/query.js";

test("tokenizeDsl handles quotes and spacing", () => {
  const t = tokenizeDsl('kind:decision "exact phrase" +must -without plain');
  assert.deepEqual(t.map((x) => x.kind), ["raw", "phrase", "raw", "raw", "raw"]);
  assert.equal(t[1].value, "exact phrase");
});

test("parseQuery: free text, phrase, must, without", () => {
  const q = parseQuery('token refresh +must keep "exact phrase" -badword');
  assert.deepEqual(q.text, ["token", "refresh", "keep"]);
  assert.equal(q.phrase, "exact phrase");
  assert.deepEqual(q.must, ["must"]);
  assert.deepEqual(q.without, ["badword"]);
});

test("parseQuery: structured field filters", () => {
  const q = parseQuery('kind:decision kind:fact tag:auth tag:"api design" scope:global importance:>3 since:2026-01-01 link:mem_abc workspace:C:/proj');
  assert.deepEqual(q.filters.kinds, ["decision", "fact"]);
  assert.deepEqual(q.filters.tags, ["auth", "api design"]);
  assert.deepEqual(q.filters.scopes, ["global"]);
  assert.equal(q.filters.importanceMin, 3);
  assert.equal(q.filters.importanceMax, null);
  assert.ok(q.filters.createdSince);
  assert.equal(q.filters.link, "mem_abc");
  assert.equal(q.filters.workspace, "C:/proj");
});

test("parseQuery: importance comparisons and time ranges", () => {
  const q = parseQuery("importance:<2 updated:>2026-05-01 until:2026-06-01 created:2026-01-01");
  assert.equal(q.filters.importanceMax, 2);
  assert.ok(q.filters.updatedSince);
  assert.ok(q.filters.createdUntil);
  assert.ok(q.filters.createdSince);
  assert.ok(q.filters.createdUntil && Date.parse(q.filters.createdUntil) > Date.parse(q.filters.createdSince));
});

test("parseQuery: empty input gives empty query", () => {
  const q = parseQuery("");
  assert.equal(q.text.length, 0);
  assert.equal(q.phrase, null);
  assert.equal(q.filters.kinds.length, 0);
});

test("parseQuery: unknown fields stay free text", () => {
  const q = parseQuery("color:blue anything");
  assert.deepEqual(q.text, ["color:blue", "anything"]);
});
