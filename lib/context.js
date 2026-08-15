/**
 * ContextManager — the context-management engine of self-memorycontrol.
 *
 * It turns the plugin from a passive memory drawer into an active context
 * manager for long multi-turn conversations. Three cooperating paths, all
 * optional via config, all driven by DSH's own durable session events so the
 * harness stays the single source of truth:
 *
 * 1. Turn-level extraction  — after a turn, durably important knowledge from
 *    the newest messages is distilled into memory entries (Mem0-style
 *    continuous learning). Throttled by new-text volume and a cooldown.
 *
 * 2. Compaction-aware archiving — when the harness compacts an old surface
 *    range (dsh-compaction writes `compaction/start|summary|end` session
 *    events), the full original text of the shadowed range is archived into a
 *    searchable memory entry and durable knowledge is extracted from it. The
 *    lossy summary is no longer the only trace (MemGPT-style page-out).
 *
 * 3. Auto-recall — when a session starts (fresh or resumed), the most
 *    important entries for that workspace are injected as a bounded
 *    `<memory-recall>` user message so relevant memory is paged back in
 *    without the model having to remember to search.
 *
 * Explicit tools: `context_archive` (snapshot + summarize now) and
 * `context_status` (conversation size + module telemetry).
 */
import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm";
import { parseQuery } from "./query.js";
import { searchEntries } from "./search.js";
import { normPath } from "./util.js";

const EXTRACT_INSTRUCTION = `You are a memory curator for an AI coding agent. Read the conversation excerpt below and extract durable knowledge worth keeping across sessions and context compactions.

Output ONLY a JSON array (no prose, no markdown fences) of memory entries. Each entry:
{
  "kind": "fact" | "decision" | "preference" | "knowledge" | "todo" | "note" | "context",
  "title": "short title (<= 60 chars)",
  "content": "self-contained detail (<= 400 chars)",
  "tags": ["up to 4 short tags"],
  "importance": 1-5
}

Include: user preferences and hard constraints; project conventions and naming rules; architecture decisions and their rationale; completed tasks with key results; code layout and build facts; unresolved todos. Exclude: greetings and small talk, task-specific noise, anything already covered by earlier entries in the excerpt, and secrets. If nothing durable, output [].`;

const RECALL_OPEN = "<memory-recall>";
const RECALL_CLOSE = "</memory-recall>";

function blocksToText(blocks) {
  if (!Array.isArray(blocks)) return "";
  return blocks.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
}

/** Extract a JSON array from model output tolerantly. */
export function parseExtractionJson(text) {
  const t = String(text ?? "");
  const start = t.indexOf("[");
  const end = t.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  let body = t.slice(start, end + 1);
  for (let i = 0; i < 3; i += 1) {
    try {
      const parsed = JSON.parse(body);
      if (Array.isArray(parsed)) return parsed;
      return [];
    } catch {
      const cut = body.lastIndexOf(",");
      if (cut <= start) break;
      body = body.slice(0, cut) + "]";
    }
  }
  return [];
}

/** Collect the durable text of a session's events (real user + assistant). */
function sessionText(session, { fromSeq = 0, maxChars = 30000 } = {}) {
  let out = "";
  const push = (text) => {
    if (!text) return;
    const rest = maxChars - out.length;
    if (rest <= 0) return;
    out += text.length <= rest ? text : text.slice(text.length - rest);
  };
  for (const event of session.events ?? []) {
    if (event.seq < fromSeq) continue;
    if (event.type === "user/message") {
      const src = event.data?.source;
      const isRealUser = src?.kind === "user";
      const isCheckpoint = src?.kind === "plugin" && event.data?.content?.some((b) => b.type === "text" && /<compacted-summary>/.test(b.text ?? ""));
      if (isRealUser && !isCheckpoint) push(blocksToText(event.data.content));
    } else if (event.type === "assistant/message") {
      push(blocksToText(event.data.content));
    }
  }
  return out.slice(-maxChars);
}

/** Resolve the provider/model for a background LLM call from the session. */
function extractionTarget(session, cfg) {
  if (cfg.provider && cfg.model) return { provider: cfg.provider, model: cfg.model };
  try {
    const config = session.requestHeader?.()?.config;
    if (config?.provider && config?.model) return { provider: config.provider, model: config.model };
  } catch {
    // ignore
  }
  return null;
}

export class ContextManager {
  /**
   * @param {object} ctx cordis host context (needs llm, sessions)
   * @param {import("./store.js").MemoryStore} store
   * @param {object} cfg resolved context config
   */
  constructor(ctx, store, cfg) {
    this.ctx = ctx;
    this.store = store;
    this.cfg = cfg;
    this.lastExtract = new Map(); // sessionId -> { at, seq }
    this.lastArchiveBySession = new Map(); // sessionId -> archive entry id
    this.extractionCount = 0;
  }

  start() {
    if (!this.cfg.enabled) return;
    this.ctx.on("session/event", (session, event) => {
      try {
        if (event.type === "compaction/summary") {
          if (this.cfg.archive.enabled || this.cfg.extract.enabled) {
            void this.onCompactionSummary(session, event).catch((error) => this.warn("archive", error));
          }
        } else if (event.type === "turn/end" && this.cfg.extract.enabled) {
          void this.maybeExtract(session).catch((error) => this.warn("extract", error));
        }
      } catch (error) {
        this.warn("dispatch", error);
      }
    });
    if (this.cfg.recall.enabled && this.cfg.recall.onSessionStart) {
      this.ctx.on("agent/session-start", (payload) => {
        try {
          this.onSessionStart(payload?.agent);
        } catch (error) {
          this.warn("recall", error);
        }
      });
    }
  }

  warn(kind, error) {
    console.warn(`[self-memorycontrol] context ${kind}: ${error?.message ?? error}`);
  }

  /** Sync recall: pick top entries for the workspace and inject them. */
  onSessionStart(agent) {
    const session = agent?.session;
    if (!session) return;
    if (session.header?.parentSession) return; // subagents are seeded by their parent
    const ws = session.header?.cwd ? normPath(session.header.cwd) : normPath(process.cwd());
    const hits = this.syncRecall(ws, this.cfg.recall.budgetChars, this.cfg.recall.maxEntries);
    if (hits.length === 0) return;
    const text = this.renderRecall(hits);
    agent.inject(createUserMessage({
      content: [{ type: "text", text }],
      source: {
        kind: "plugin",
        plugin: "self-memorycontrol",
        form: "notice",
        summary: `memory recall: ${hits.length} entries`,
      },
    }));
  }

  /** Synchronous recall query (lexical only; never blocks the event). */
  syncRecall(ws, budgetChars, maxEntries) {
    const q = parseQuery("");
    const entries = this.store.all().filter((e) => {
      if (e.kind === "context") return false; // archives are recalled on demand
      if (e.scope === "global") return true;
      return e.scope === "workspace" && e.workspace === ws;
    });
    const ranked = searchEntries({
      entries,
      index: this.store.index,
      q,
      orderBy: "importance",
      limit: entries.length,
      offset: 0,
    }).hits;
    const out = [];
    let chars = 0;
    for (const hit of ranked) {
      const line = `- [${hit.id}] ${hit.kind} ★${hit.importance}${hit.title ? ` · ${hit.title}` : ""}`;
      const snippet = hit.snippet ? `  ${hit.snippet}` : "";
      const cost = line.length + snippet.length + 2;
      if (out.length >= maxEntries || chars + cost > budgetChars) break;
      out.push({ id: hit.id, kind: hit.kind, importance: hit.importance, title: hit.title, snippet: hit.snippet });
      chars += cost;
    }
    return out;
  }

  renderRecall(hits) {
    const lines = [
      `${RECALL_OPEN}`,
      "Relevant persistent memory (searchable with memory_search; request full text with memory_get):",
    ];
    for (const h of hits) {
      lines.push(`- [${h.id}] ${h.kind} ★${h.importance}${h.title ? ` · ${h.title}` : ""}`);
      if (h.snippet) lines.push(`  ${h.snippet}`);
    }
    lines.push(RECALL_CLOSE);
    return lines.join("\n");
  }

  /** Archive a compacted range with full fidelity + extract durable knowledge. */
  async onCompactionSummary(session, event) {
    const data = event.data ?? {};
    const shadowedSeqs = Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs : [];
    const summaryText = blocksToText(data.summary);
    const raw = this.rawRegionText(session, shadowedSeqs, this.cfg.archive.maxChars);
    if (this.cfg.archive.enabled) {
      const prevId = this.lastArchiveBySession.get(session.id) ?? null;
      const ws = session.header?.cwd ? normPath(session.header.cwd) : normPath(process.cwd());
      const date = new Date().toISOString().slice(0, 10);
      const archive = await this.store.save({
        kind: "context",
        title: `会话存档 ${date} · ${String(session.id).slice(0, 8)}`,
        content: raw
          ? `[compacted range ${data.shadowedRange?.start ?? "?"}–${data.shadowedRange?.end ?? "?"}, ~${data.shadowedTokenCount ?? "?"} tokens, archived verbatim from the session log]\n\n${raw}`
          : `[compacted range ${data.shadowedRange?.start ?? "?"}–${data.shadowedRange?.end ?? "?"}, ~${data.shadowedTokenCount ?? "?"} tokens — original text unavailable]\n\n${summaryText}`,
        tags: ["archive", `session:${String(session.id)}`],
        links: prevId ? [prevId] : [],
        scope: "workspace",
        workspace: ws,
        source: { kind: "auto", session: session.id, form: "compaction-archive" },
      });
      this.lastArchiveBySession.set(session.id, archive.id);
    }
    if (this.cfg.extract.enabled && !session.header?.parentSession) {
      const input = `${summaryText}\n\n${raw}`.slice(-this.cfg.extract.maxInputChars);
      await this.extractFromText(session, input, "compaction");
    }
  }

  rawRegionText(session, seqs, maxChars) {
    const set = new Set(seqs);
    const parts = [];
    let total = 0;
    for (const event of session.events ?? []) {
      if (!set.has(event.seq)) continue;
      const text = event.type === "tool/result"
        ? blocksToText(event.data?.content)
        : event.type === "user/message" || event.type === "assistant/message"
          ? blocksToText(event.data?.content)
          : "";
      if (!text) continue;
      const room = maxChars - total;
      if (room <= 0) break;
      const piece = text.length <= room ? text : text.slice(0, room);
      parts.push(`[${event.type} @${event.seq}] ${piece}`);
      total += piece.length;
    }
    return parts.join("\n");
  }

  /** Throttled turn-level extraction. */
  async maybeExtract(session) {
    if (session.header?.parentSession) return; // subagent sessions are covered by their parent
    const last = this.lastExtract.get(session.id);
    const now = Date.now();
    if (last && now - last.at < this.cfg.extract.minIntervalMs) return;
    const fromSeq = last?.seq ?? 0;
    const text = sessionText(session, { fromSeq, maxChars: this.cfg.extract.maxInputChars });
    if (text.length < this.cfg.extract.minNewChars) return;
    await this.extractFromText(session, text, "turn");
  }

  /** One LLM extraction call; saves durable entries; records the checkpoint. */
  async extractFromText(session, text, reason) {
    if (!this.ctx.llm) return 0;
    const target = extractionTarget(session, this.cfg.extract);
    if (!target) {
      this.warn("extract", "no provider/model target available; configure context.extract.provider/model or route a request first");
      return 0;
    }
    const instruction = `${EXTRACT_INSTRUCTION}\n\n<excerpt>\n${text}\n</excerpt>`;
    const messages = [createUserMessage({
      content: [{ type: "text", text: instruction }],
      source: { kind: "plugin", plugin: "self-memorycontrol" },
    })];
    const options = {
      provider: target.provider,
      model: target.model,
      messages,
      maxTokens: this.cfg.extract.maxTokens,
      sessionId: session.id,
      signal: AbortSignal.timeout(60000),
    };
    const assembler = new BlockAssembler();
    for await (const chunk of this.ctx.llm.stream(options)) assembler.push(chunk);
    const output = blocksToText(assembler.blocks());
    const entries = parseExtractionJson(output);
    let saved = 0;
    for (const raw of entries) {
      if (!raw || typeof raw !== "object" || typeof raw.content !== "string" || raw.content.trim() === "") continue;
      const ws = session.header?.cwd ? normPath(session.header.cwd) : normPath(process.cwd());
      await this.store.save({
        kind: raw.kind,
        title: raw.title,
        content: raw.content,
        tags: Array.isArray(raw.tags) ? raw.tags.map(String).slice(0, 4) : [],
        importance: raw.importance,
        scope: raw.scope === "global" ? "global" : "workspace",
        workspace: ws,
        source: { kind: "auto", session: session.id, form: `extract:${reason}` },
      });
      saved += 1;
    }
    this.lastExtract.set(session.id, { at: Date.now(), seq: session.seq });
    this.extractionCount += saved;
    return saved;
  }

  /** Explicit `context_archive`: snapshot the current session into memory. */
  async archiveSession(exec, { summarize = false, maxChars = 60000 } = {}) {
    const session = exec?.agent?.session;
    if (!session) throw new Error("context_archive requires a calling agent session");
    const ws = session.header?.cwd ? normPath(session.header.cwd) : normPath(process.cwd());
    const raw = sessionText(session, { maxChars });
    const prevId = this.lastArchiveBySession.get(session.id) ?? null;
    let summaryText = "";
    if (summarize && this.ctx.llm) {
      const target = extractionTarget(session, this.cfg.extract);
      if (target) {
        const instruction = "Summarize the conversation below in under 400 words, keeping decisions, facts, and open todos. Output only the summary text.\n\n<conversation>\n" + raw.slice(-30000) + "\n</conversation>";
        const messages = [createUserMessage({ content: [{ type: "text", text: instruction }], source: { kind: "plugin", plugin: "self-memorycontrol" } })];
        const assembler = new BlockAssembler();
        for await (const chunk of this.ctx.llm.stream({
          provider: target.provider,
          model: target.model,
          messages,
          maxTokens: this.cfg.extract.maxTokens,
          sessionId: session.id,
          signal: AbortSignal.timeout(60000),
        })) assembler.push(chunk);
        summaryText = blocksToText(assembler.blocks());
      }
    }
    const date = new Date().toISOString().slice(0, 10);
    const archive = await this.store.save({
      kind: "context",
      title: `会话快照 ${date} · ${String(session.id).slice(0, 8)}`,
      content: `${summaryText ? `[summary]\n${summaryText}\n\n` : ""}${raw}`,
      tags: ["archive", `session:${String(session.id)}`],
      links: prevId ? [prevId] : [],
      scope: "workspace",
      workspace: ws,
      source: { kind: "agent", session: session.id, form: "context-archive" },
    });
    this.lastArchiveBySession.set(session.id, archive.id);
    let extracted = 0;
    if (this.cfg.extract.enabled && raw.length >= this.cfg.extract.minNewChars) {
      extracted = await this.extractFromText(session, `${summaryText}\n\n${raw}`.slice(-this.cfg.extract.maxInputChars), "archive");
    }
    return { archiveId: archive.id, chars: raw.length, summarized: Boolean(summaryText), extracted };
  }

  /** `context_status`: conversation size + module telemetry. */
  async status(exec) {
    const session = exec?.agent?.session;
    const surfaceChars = session ? sessionText(session, { maxChars: 100000 }).length : 0;
    const compactions = session ? (session.events ?? []).filter((e) => e.type === "compaction/summary").length : 0;
    let archives = 0;
    try {
      archives = this.store.all().filter((e) => e.kind === "context" && (e.tags ?? []).includes("archive")).length;
    } catch {
      archives = 0;
    }
    const stats = this.store.stats();
    return {
      conversation: {
        session: session?.id ?? null,
        surfaceChars,
        estimatedTokens: Math.round(surfaceChars / 4),
        compactions,
      },
      memory: {
        total: stats.total,
        byKind: stats.byKind,
        byScope: stats.byScope,
        expired: stats.expired,
      },
      context: {
        enabled: this.cfg.enabled,
        extractEnabled: this.cfg.extract.enabled,
        archiveEnabled: this.cfg.archive.enabled,
        recallEnabled: this.cfg.recall.enabled && this.cfg.recall.onSessionStart,
        recallBudgetChars: this.cfg.recall.budgetChars,
        archives,
        extractions: this.extractionCount,
        lastExtractionAt: this.lastExtract.size ? [...this.lastExtract.values()].sort((a, b) => b.at - a.at)[0].at : null,
        root: stats.root,
      },
    };
  }
}
