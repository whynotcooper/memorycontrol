import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../lib/index.js";
import { parseExtractionJson } from "../lib/context.js";

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), "mc-ctx-"));
}

function makeEvent(seq, type, data) {
  return { seq, type, data: data ?? {} };
}

function textEvent(seq, role, text) {
  return makeEvent(seq, role, {
    content: [{ type: "text", text }],
    source: role === "user/message" ? { kind: "user" } : undefined,
  });
}

/** A minimal Session object with raw events and a request header. */
function makeSession(id, events, cwd = "/ws") {
  let seq = 0;
  const evts = events.map((e) => ({ ...e, seq: e.seq ?? ++seq }));
  return {
    id,
    seq: evts.length,
    header: { cwd },
    events: evts,
    requestHeader() { return { config: { provider: "test-provider", model: "test-model" } }; },
  };
}

/** Stub llm that streams a canned JSON answer, counting calls. */
function stubLlm(answer) {
  const calls = [];
  return {
    calls,
    async *stream(options) {
      calls.push(options);
      const text = typeof answer === "function" ? answer(options) : answer;
      yield { type: "text-delta", index: 0, text };
    },
  };
}

/** Rich fake ctx: supports apply() (tools/systemPrompt/sessions/llm/on/emit). */
function fakeCtx() {
  const defs = [];
  const sections = [];
  const sessions = new Map();
  const listeners = new Map();
  const ctx = {
    defs,
    sections,
    sessions: { get(id) { return sessions.get(id); } },
    listeners,
    disposers: [],
    tools: { register(def) { defs.push(def); } },
    systemPrompt: { section(s) { sections.push(s); } },
    llm: null,
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
      return () => {};
    },
    emit(event, ...args) {
      for (const h of listeners.get(event) ?? []) h(...args);
    },
    get(name) {
      if (name === "tools") return ctx.tools;
      if (name === "systemPrompt") return ctx.systemPrompt;
      if (name === "sessions") return ctx.sessions;
      if (name === "llm") return ctx.llm;
      return undefined;
    },
    effect(fn) {
      const disposer = fn();
      ctx.disposers.push(disposer);
    },
  };
  return ctx;
}

function contextConfig(over = {}) {
  return { context: { extract: { minNewChars: 10, minIntervalMs: 60000, ...(over.extract ?? {}) }, archive: { enabled: true }, recall: { enabled: true, onSessionStart: true }, ...(over.top ?? {}) } };
}

const EXTRACT_JSON = JSON.stringify([
  { kind: "decision", title: "Token refresh uses 5min window", content: "Auth module refreshes tokens every 5 minutes with backoff.", tags: ["auth"], importance: 4 },
  { kind: "preference", title: "Reply in Chinese", content: "User prefers Chinese replies.", tags: ["user"], importance: 5 },
]);

test("parseExtractionJson tolerates fences and trailing commas", () => {
  const withFence = `Here you go:\n\`\`\`json\n${EXTRACT_JSON}\n\`\`\``;
  const entries = parseExtractionJson(withFence);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].kind, "decision");
  assert.equal(parseExtractionJson('[{"kind":"fact","content":"x"},]').length, 1);
  assert.deepEqual(parseExtractionJson("no json here"), []);
  assert.deepEqual(parseExtractionJson("[]"), []);
});

test("turn-level extraction saves durable entries and throttles", async () => {
  const root = tmpRoot();
  try {
    const ctx = fakeCtx();
    ctx.llm = stubLlm(EXTRACT_JSON);
    apply(ctx, { root, webApi: false, ...contextConfig() });

    const session = makeSession("s1", [
      textEvent(1, "user/message", "please remember: reply in Chinese, and we use pnpm for builds"),
      textEvent(2, "assistant/message", "Noted. I'll keep that in memory."),
      makeEvent(3, "turn/end"),
    ]);
    ctx.emit("session/event", session, session.events[0]);
    ctx.emit("session/event", session, session.events[1]);
    ctx.emit("session/event", session, session.events[2]);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(ctx.llm.calls.length, 1);
    const store = ctx.__selfMemory.store;
    assert.equal(store.count(), 2);
    const saved = store.all();
    assert.ok(saved.some((e) => e.kind === "decision" && e.tags.includes("auth")));
    assert.ok(saved.every((e) => e.scope === "workspace" && e.source?.kind === "auto"));

    // second turn/end within the cooldown must NOT trigger another call
    const session2 = makeSession("s1", [
      ...session.events,
      textEvent(4, "user/message", "another turn with plenty of content to extract"),
      makeEvent(5, "turn/end"),
    ]);
    session2.seq = 5;
    ctx.emit("session/event", session2, session2.events[4]);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(ctx.llm.calls.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compaction summary archives full text and extracts knowledge", async () => {
  const root = tmpRoot();
  try {
    const ctx = fakeCtx();
    ctx.llm = stubLlm(EXTRACT_JSON);
    apply(ctx, { root, webApi: false, ...contextConfig() });

    const session = makeSession("s1", [
      textEvent(1, "user/message", "old turn: decide to use vitest for testing"),
      textEvent(2, "assistant/message", "Done — vitest it is."),
      makeEvent(3, "compaction/start", { compactionId: "c1", turn: 1 }),
      makeEvent(4, "compaction/summary", {
        compactionId: "c1",
        summary: [{ type: "text", text: "Earlier: decided to use vitest for testing." }],
        shadowedRange: { start: 1, end: 2 },
        shadowedSeqs: [1, 2],
        shadowedTokenCount: 120,
        provider: "test-provider",
        model: "test-model",
      }),
      makeEvent(5, "compaction/end", { compactionId: "c1", error: null }),
    ]);
    ctx.emit("session/event", session, session.events[3]);
    await new Promise((r) => setTimeout(r, 60));
    const store = ctx.__selfMemory.store;
    const archives = store.all().filter((e) => e.kind === "context" && e.tags.includes("archive"));
    assert.equal(archives.length, 1);
    assert.ok(archives[0].content.includes("vitest"));
    assert.ok(archives[0].content.includes("compacted range"));
    const extracted = store.all().filter((e) => e.kind === "decision" && e.tags.includes("auth"));
    assert.equal(extracted.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session-start recall injects a bounded memory-recall message", async () => {
  const root = tmpRoot();
  try {
    const ctx = fakeCtx();
    ctx.llm = stubLlm("[]");
    apply(ctx, { root, webApi: false, ...contextConfig({ extract: { enabled: false } }) });
    const store = ctx.__selfMemory.store;
    await store.save({ content: "User prefers Chinese replies.", title: "Language", kind: "preference", importance: 5, scope: "global" });
    await store.save({ content: "Vitest for unit tests.", title: "Testing", kind: "decision", importance: 4, scope: "workspace", workspace: "/ws" });
    await store.save({ content: "other workspace", title: "Other", kind: "note", importance: 3, scope: "workspace", workspace: "/elsewhere" });
    const injected = [];
    const agent = {
      id: "a1",
      session: { id: "s1", header: { cwd: "/ws" }, events: [], requestHeader() { return null; } },
      inject(message) { injected.push(message); },
    };
    ctx.emit("agent/session-start", { agent, source: { kind: "resume" } });
    assert.equal(injected.length, 1);
    const text = injected[0].content.map((b) => b.text).join("");
    assert.ok(text.includes("<memory-recall>"));
    assert.ok(text.includes("Language"));
    assert.ok(text.includes("Testing"));
    assert.ok(!text.includes("Other")); // different workspace excluded
    assert.equal(injected[0].source.kind, "plugin");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("context_status and context_archive tools work end to end", async () => {
  const root = tmpRoot();
  try {
    const ctx = fakeCtx();
    ctx.llm = stubLlm(EXTRACT_JSON);
    apply(ctx, { root, webApi: false, ...contextConfig() });
    const defs = ctx.defs;
    const archiveTool = defs.find((d) => d.name === "context_archive");
    const statusTool = defs.find((d) => d.name === "context_status");
    assert.ok(archiveTool && statusTool);

    const exec = {
      agent: {
        id: "a1",
        session: makeSession("s1", [
          textEvent(1, "user/message", "Let's fix the auth bug"),
          textEvent(2, "assistant/message", "Root cause: wrong expiry calc."),
        ]),
      },
    };
    const archived = await archiveTool.execute({ summarize: false }, exec);
    assert.ok(archived.archiveId);
    assert.ok(archived.chars > 0);

    const status = await statusTool.execute({}, exec);
    assert.equal(status.context.enabled, true);
    assert.ok(status.conversation.surfaceChars >= 0);
    assert.equal(status.context.archives, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

