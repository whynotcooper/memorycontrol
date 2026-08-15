import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { apply, Config } from "../lib/index.js";
import { registerWebApi } from "../lib/web.js";

function fakeCtx(root) {
  const defs = [];
  const sections = [];
  const sessions = new Map();
  const ctx = {
    defs,
    sections,
    sessions: { get(id) { return sessions.get(id); } },
    disposers: [],
    tools: { register(def) { defs.push(def); } },
    systemPrompt: { section(s) { sections.push(s); } },
    get(name) {
      if (name === "tools") return ctx.tools;
      if (name === "systemPrompt") return ctx.systemPrompt;
      if (name === "sessions") return ctx.sessions;
      return undefined;
    },
    effect(fn) {
      const disposer = fn();
      ctx.disposers.push(disposer);
    },
  };
  return ctx;
}

function fakeExec(cwd = "/ws") {
  return { agent: { session: { id: "s1", header: { cwd } } } };
}

function tool(ctx, name) {
  return ctx.defs.find((d) => d.name === name);
}

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), "mc-plugin-"));
}

test("apply registers all memory tools and the prompt section", () => {
  const root = tmpRoot();
  try {
    const ctx = fakeCtx(root);
    apply(ctx, { root, webApi: false });
    const names = ctx.defs.map((d) => d.name).sort();
    assert.deepEqual(names, [
      "memory_delete", "memory_export", "memory_get", "memory_import",
      "memory_list", "memory_prune", "memory_save", "memory_search", "memory_stats",
    ]);
    assert.ok(ctx.sections.some((s) => s.name === "memory:control"));
    assert.ok(ctx.sections[0].text.includes("memory_save"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("full save -> search -> get -> list -> delete flow", async () => {
  const root = tmpRoot();
  try {
    const ctx = fakeCtx(root);
    apply(ctx, { root, webApi: false });

    const saved = await tool(ctx, "memory_save").execute({
      content: "The auth module uses a 5 minute token refresh window with retry backoff.",
      title: "Token refresh design",
      kind: "decision",
      tags: ["auth", "backend"],
      importance: 5,
      scope: "workspace",
    }, fakeExec("/proj/a"));
    assert.match(saved.id, /^mem_/);

    const search = await tool(ctx, "memory_search").execute({
      query: "token refresh",
      scope: "workspace",
    }, fakeExec("/proj/a"));
    assert.equal(search.total, 1);
    assert.equal(search.hits[0].id, saved.id);
    assert.equal(search.hits[0].snippet.length > 0, true);
    assert.equal(search.hits[0].content, undefined); // compact hits

    const got = await tool(ctx, "memory_get").execute({ ids: [saved.id] });
    assert.equal(got.entries.length, 1);
    assert.ok(got.entries[0].content.includes("retry backoff"));

    // workspace isolation: a different workspace does not see it
    const other = await tool(ctx, "memory_search").execute({ query: "token", scope: "workspace" }, fakeExec("/proj/b"));
    assert.equal(other.total, 0);

    const listed = await tool(ctx, "memory_list").execute({ scope: "workspace", limit: 10 }, fakeExec("/proj/a"));
    assert.equal(listed.total, 1);

    const del = await tool(ctx, "memory_delete").execute({ ids: [saved.id] });
    assert.equal(del.deleted, 1);
    assert.equal((await tool(ctx, "memory_search").execute({ query: "token", scope: "workspace" }, fakeExec("/proj/a"))).total, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("global scope is visible across workspaces; DSL filters work", async () => {
  const root = tmpRoot();
  try {
    const ctx = fakeCtx(root);
    apply(ctx, { root, webApi: false });
    await tool(ctx, "memory_save").execute({
      content: "Team uses conventional commits; build via pnpm run build.",
      title: "Repo conventions",
      kind: "preference",
      tags: ["conventions"],
      importance: 4,
      scope: "global",
    }, fakeExec("/any"));

    const r = await tool(ctx, "memory_search").execute({ query: "conventional commits", scope: "auto" }, fakeExec("/elsewhere"));
    assert.equal(r.total, 1);

    const filtered = await tool(ctx, "memory_search").execute({ query: "kind:preference tag:conventions", scope: "auto" }, fakeExec("/elsewhere"));
    assert.equal(filtered.total, 1);

    const none = await tool(ctx, "memory_search").execute({ query: "kind:decision", scope: "auto" }, fakeExec("/elsewhere"));
    assert.equal(none.total, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("expiry, prune, export, import", async () => {
  const root = tmpRoot();
  try {
    const ctx = fakeCtx(root);
    apply(ctx, { root, webApi: false });
    const past = new Date(Date.now() - 5000).toISOString();
    const keep = await tool(ctx, "memory_save").execute({ content: "keep me", scope: "global" }, fakeExec());
    await tool(ctx, "memory_save").execute({ content: "temp note", scope: "global", expires_at: past }, fakeExec());

    const dry = await tool(ctx, "memory_prune").execute({ dry_run: true });
    assert.equal(dry.removed, 0);
    const pruned = await tool(ctx, "memory_prune").execute({});
    assert.equal(pruned.removed, 1);

    const outPath = join(root, "backup.json");
    const exp = await tool(ctx, "memory_export").execute({ path: outPath, scope: "all" }, fakeExec());
    assert.equal(exp.count, 1);
    assert.ok(existsSync(outPath));

    // fresh store, import back
    const ctx2 = fakeCtx(root);
    apply(ctx2, { root: join(root, "second"), webApi: false });
    const imp = await tool(ctx2, "memory_import").execute({ path: outPath });
    assert.equal(imp.imported, 1);
    const got = await tool(ctx2, "memory_get").execute({ ids: [keep.id] });
    assert.equal(got.entries.length, 1);
    assert.equal(got.entries[0].content, "keep me");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stats tool reports entries", async () => {
  const root = tmpRoot();
  try {
    const ctx = fakeCtx(root);
    apply(ctx, { root, webApi: false });
    await tool(ctx, "memory_save").execute({ content: "a", kind: "fact", scope: "global" }, fakeExec());
    await tool(ctx, "memory_save").execute({ content: "b", kind: "decision", scope: "global" }, fakeExec());
    const s = await tool(ctx, "memory_stats").execute({});
    assert.equal(s.total, 2);
    assert.equal(s.byKind.fact, 1);
    assert.equal(s.root, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- web API route ---

function fakeReq(method, headers, body) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = headers;
  process.nextTick(() => {
    if (body) req.emit("data", Buffer.from(body));
    req.emit("end");
  });
  return req;
}

function fakeRes() {
  return {
    status: 0,
    body: "",
    headers: null,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; },
  };
}

function installWeb(ctx, root) {
  const routes = [];
  const webServer = {
    register(route) { routes.push(route); return () => {}; },
  };
  ctx.__web = { routes, webServer };
  ctx.get = (name) => {
    if (name === "tools") return ctx.tools;
    if (name === "systemPrompt") return ctx.systemPrompt;
    if (name === "sessions") return ctx.sessions;
    if (name === "webServer") return webServer;
    return undefined;
  };
}

test("web API: save + search over the route, cross-origin rejected", async () => {
  const root = tmpRoot();
  try {
    const ctx = fakeCtx(root);
    installWeb(ctx, root);
    apply(ctx, { root, webApi: true });
    const { routes } = ctx.__web;

    // save
    const saveReq = fakeReq("POST", { host: "127.0.0.1:3081", origin: "http://127.0.0.1:3081" }, JSON.stringify({
      op: "save",
      args: { content: "web saved memory", title: "Web", scope: "global" },
      sessionId: "s1",
    }));
    const saveRes = fakeRes();
    await routes[0].handler(saveReq, saveRes);
    assert.equal(saveRes.status, 200);
    const saved = JSON.parse(saveRes.body);
    assert.match(saved.id, /^mem_/);

    // search
    const searchReq = fakeReq("POST", { host: "127.0.0.1:3081", origin: "http://127.0.0.1:3081" }, JSON.stringify({
      op: "search",
      args: { query: "web saved", scope: "all" },
      sessionId: "s1",
    }));
    const searchRes = fakeRes();
    await routes[0].handler(searchReq, searchRes);
    assert.equal(searchRes.status, 200);
    const found = JSON.parse(searchRes.body);
    assert.equal(found.total, 1);

    // cross-origin rejected
    const evil = fakeReq("POST", { host: "127.0.0.1:3081", origin: "http://evil.example" }, JSON.stringify({ op: "stats" }));
    const evilRes = fakeRes();
    await routes[0].handler(evil, evilRes);
    assert.equal(evilRes.status, 403);

    // unknown op
    const bad = fakeReq("POST", { host: "127.0.0.1:3081" }, JSON.stringify({ op: "nope" }));
    const badRes = fakeRes();
    await routes[0].handler(bad, badRes);
    assert.equal(badRes.status, 400);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Config schema resolves defaults", () => {
  const cfg = Config;
  assert.ok(cfg);
});
