import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../lib/store.js";
import { normPath } from "../lib/util.js";

const WS1 = normPath(join(tmpdir(), "mc-ws1"));
const WS2 = normPath(join(tmpdir(), "mc-ws2"));

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), "mc-store-"));
}

test("save creates and updates entries; update preserves createdAt", async () => {
  const root = tmpRoot();
  try {
    const store = new MemoryStore({ root });
    const e1 = await store.save({ content: "first content", title: "First", kind: "decision", tags: ["a"], importance: 4, scope: "workspace", workspace: WS1 });
    assert.match(e1.id, /^mem_/);
    assert.equal(store.count(), 1);
    assert.equal(e1.scope, "workspace");
    assert.equal(e1.workspace, WS1);

    const e2 = await store.save({ id: e1.id, content: "updated content", tags: ["a", "b"] });
    assert.equal(e2.id, e1.id);
    assert.equal(e2.createdAt, e1.createdAt);
    assert.equal(e2.content, "updated content");
    assert.deepEqual(e2.tags, ["a", "b"]);
    assert.equal(e2.title, "First");
    assert.equal(store.count(), 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("persistence: a new store instance sees prior writes", async () => {
  const root = tmpRoot();
  try {
    const s1 = new MemoryStore({ root });
    await s1.save({ content: "durable", title: "D", scope: "global" });
    const s2 = new MemoryStore({ root });
    assert.equal(s2.count(), 1);
    const e = s2.getMany(["x"]); // miss
    assert.equal(e.length, 0);
    const all = s2.all();
    assert.equal(all[0].title, "D");
    assert.equal(all[0].scope, "global");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("search finds updated terms and drops old ones after update", async () => {
  const root = tmpRoot();
  try {
    const store = new MemoryStore({ root });
    const e = await store.save({ content: "oldtopic details", scope: "global" });
    const before = await store.search({ query: "oldtopic", scope: "all" });
    assert.equal(before.total, 1);

    await store.save({ id: e.id, content: "brandnewtopic details" });
    const afterOld = await store.search({ query: "oldtopic", scope: "all" });
    assert.equal(afterOld.total, 0);
    const afterNew = await store.search({ query: "brandnewtopic", scope: "all" });
    assert.equal(afterNew.total, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scope filtering: global vs workspace", async () => {
  const root = tmpRoot();
  try {
    const store = new MemoryStore({ root });
    await store.save({ content: "global fact", scope: "global" });
    await store.save({ content: "ws1 fact", scope: "workspace", workspace: WS1 });
    await store.save({ content: "ws2 fact", scope: "workspace", workspace: WS2 });

    const global = await store.search({ query: "fact", scope: "global" });
    assert.equal(global.total, 1);

    const ws1 = await store.search({ query: "fact", scope: "workspace", workspace: WS1 });
    assert.equal(ws1.total, 1);
    assert.equal(ws1.hits[0].content ?? "", ""); // hits are compact (no content)

    const auto = await store.search({ query: "fact", scope: "auto", workspace: WS1 });
    assert.equal(auto.total, 2); // global + ws1

    const all = await store.search({ query: "fact", scope: "all" });
    assert.equal(all.total, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("DSL filters inside query string work end to end", async () => {
  const root = tmpRoot();
  try {
    const store = new MemoryStore({ root });
    await store.save({ content: "auth decision one", kind: "decision", tags: ["auth"], importance: 5, scope: "global" });
    await store.save({ content: "auth fact two", kind: "fact", tags: ["auth"], importance: 2, scope: "global" });
    await store.save({ content: "other thing", kind: "note", tags: ["x"], scope: "global" });

    const r = await store.search({ query: 'auth kind:decision tag:auth importance:>3', scope: "all" });
    assert.equal(r.total, 1);
    assert.equal(r.hits[0].kind, "decision");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("expiry: pruneExpired removes only expired entries", async () => {
  const root = tmpRoot();
  try {
    const store = new MemoryStore({ root });
    const past = new Date(Date.now() - 1000).toISOString();
    const future = new Date(Date.now() + 86400000).toISOString();
    await store.save({ content: "expired", scope: "global", expires_at: past });
    await store.save({ content: "live", scope: "global", expires_at: future });
    await store.save({ content: "permanent", scope: "global" });

    const dry = await store.pruneExpired({ dryRun: true });
    assert.equal(dry.removed, 0);
    assert.equal(dry.expiredIds.length, 1);
    assert.equal(store.count(), 3);

    const res = await store.pruneExpired();
    assert.equal(res.removed, 1);
    assert.equal(store.count(), 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("export + import roundtrip preserves data", async () => {
  const root = tmpRoot();
  try {
    const s1 = new MemoryStore({ root });
    await s1.save({ content: "one", title: "One", kind: "fact", tags: ["t"], scope: "workspace", workspace: WS1 });
    await s1.save({ content: "two", title: "Two", scope: "global" });

    const { entries } = s1.exportEntries({ scope: "all" });
    assert.equal(entries.length, 2);

    const root2 = tmpRoot();
    try {
      const s2 = new MemoryStore({ root: root2 });
      const res = await s2.importEntries({ entries });
      assert.equal(res.imported, 2);
      assert.equal(s2.count(), 2);
      // re-import skips existing by id
      const res2 = await s2.importEntries({ entries });
      assert.equal(res2.imported, 0);
      assert.equal(res2.skipped, 2);
    } finally {
      rmSync(root2, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findByTitle matches exact then prefix", async () => {
  const root = tmpRoot();
  try {
    const store = new MemoryStore({ root });
    const e = await store.save({ content: "x", title: "Token Refresh Fix", scope: "global" });
    assert.equal(store.findByTitle("token refresh fix").id, e.id);
    assert.equal(store.findByTitle("Token Refresh").id, e.id);
    assert.equal(store.findByTitle("nope"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stats reports totals and tags", async () => {
  const root = tmpRoot();
  try {
    const store = new MemoryStore({ root });
    await store.save({ content: "a", kind: "fact", tags: ["x", "y"], scope: "global" });
    await store.save({ content: "b", kind: "decision", tags: ["x"], scope: "global" });
    const s = store.stats();
    assert.equal(s.total, 2);
    assert.equal(s.byKind.fact, 1);
    assert.equal(s.byKind.decision, 1);
    assert.equal(s.topTags[0].tag, "x");
    assert.equal(s.topTags[0].count, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
