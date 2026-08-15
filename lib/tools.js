/**
 * memorycontrol tool definitions (memory_*), registered through
 * @deepseek-ai/dsh-tools. All business logic lives in MemoryStore; these are
 * thin, validated shells that keep results compact so the model's context
 * stays small.
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { KINDS } from "./store.js";
import { normPath } from "./util.js";

const SCOPE_ENUM = ["workspace", "global"];
const ORDER_ENUM = ["relevance", "updated", "created", "importance"];
const MODE_ENUM = ["auto", "keyword", "semantic", "hybrid"];

/** Resolve the calling agent's workspace (session header cwd), with fallback. */
export function workspaceOf(exec) {
  try {
    const cwd = exec?.agent?.session?.header?.cwd;
    if (typeof cwd === "string" && cwd !== "") return normPath(cwd);
  } catch {
    // fall through
  }
  return normPath(process.cwd());
}

const HIT_PROPS = {
  id: { type: "string", required: true },
  kind: { type: "string", required: true },
  title: { type: "string" },
  snippet: { type: "string" },
  tags: { type: "array", items: { type: "string" } },
  importance: { type: "number", required: true },
  scope: { type: "string" },
  createdAt: { type: "string", required: true },
  updatedAt: { type: "string", required: true },
  score: { type: "number", required: true },
};

const HIT_SCHEMA = { type: "object", additionalProperties: true, properties: HIT_PROPS };

const SEARCH_OUTPUT = {
  schema: {
    type: "object",
    additionalProperties: true,
    properties: {
      count: { type: "number", required: true },
      total: { type: "number", required: true },
      offset: { type: "number", required: true },
      limit: { type: "number", required: true },
      mode: { type: "string" },
      usedSemantic: { type: "boolean" },
      hits: { type: "array", items: HIT_SCHEMA },
    },
  },
  render: (_args, value) => {
    const lines = [`memory: ${value.count} shown / ${value.total} total (${value.mode})`];
    for (const h of value.hits ?? []) {
      const title = h.title || "(untitled)";
      const date = (h.updatedAt ?? "").slice(0, 10);
      lines.push(`- [${h.id}] ${h.kind} ★${h.importance} ${date}`);
      lines.push(`  ${title}`);
      if (h.snippet) lines.push(`  ${h.snippet}`);
    }
    return [{ type: "text", text: lines.join("\n") }];
  },
};

const ENTRY_OUTPUT = {
  schema: {
    type: "object",
    additionalProperties: true,
    properties: {
      entries: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: true,
          properties: {
            id: { type: "string", required: true },
            kind: { type: "string" },
            title: { type: "string" },
            content: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            importance: { type: "number" },
            scope: { type: "string" },
            createdAt: { type: "string" },
            updatedAt: { type: "string" },
          },
        },
      },
    },
  },
  render: (_args, value) => {
    const blocks = [];
    for (const e of value.entries ?? []) {
      blocks.push({ type: "text", text: `# [${e.id}] ${e.kind} ★${e.importance} ${e.title}\n${e.content ?? ""}` });
    }
    return blocks.length > 0 ? blocks : [{ type: "text", text: "memory: no entries found" }];
  },
};

const SAVED_OUTPUT = {
  schema: {
    type: "object",
    additionalProperties: true,
    properties: {
      id: { type: "string", required: true },
      kind: { type: "string" },
      title: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
      importance: { type: "number" },
      scope: { type: "string" },
      createdAt: { type: "string" },
      updatedAt: { type: "string" },
    },
  },
  render: (_args, value) => {
    return [{
      type: "text",
      text: `saved memory [${value.id}] (${value.kind}, ★${value.importance})${value.title ? ` — ${value.title}` : ""}`,
    }];
  },
};

const DELETED_OUTPUT = {
  schema: { type: "object", additionalProperties: true, properties: { deleted: { type: "number", required: true } } },
  render: (_args, value) => [{ type: "text", text: `memory: deleted ${value.deleted} entr${value.deleted === 1 ? "y" : "ies"}` }],
};

const STATS_OUTPUT = {
  schema: {
    type: "object",
    additionalProperties: true,
    properties: {
      total: { type: "number", required: true },
      byKind: { type: "object", additionalProperties: true },
      byScope: { type: "object", additionalProperties: true },
      topTags: { type: "array", items: { type: "object", additionalProperties: true } },
      expired: { type: "number" },
      withEmbeddings: { type: "number" },
      semanticEnabled: { type: "boolean" },
      root: { type: "string" },
    },
  },
  render: (_args, value) => {
    const lines = [
      `memory: ${value.total} entries (${value.expired} expired) · semantic ${value.semanticEnabled ? "on" : "off"}`,
      `  by kind: ${Object.entries(value.byKind ?? {}).map(([k, n]) => `${k}=${n}`).join(", ") || "—"}`,
      `  by scope: ${Object.entries(value.byScope ?? {}).map(([k, n]) => `${k}=${n}`).join(", ") || "—"}`,
    ];
    if ((value.topTags ?? []).length > 0) {
      lines.push(`  top tags: ${value.topTags.slice(0, 10).map((t) => `${t.tag}(${t.count})`).join(", ")}`);
    }
    lines.push(`  root: ${value.root}`);
    return [{ type: "text", text: lines.join("\n") }];
  },
};

const PRUNE_OUTPUT = {
  schema: {
    type: "object",
    additionalProperties: true,
    properties: {
      removed: { type: "number", required: true },
      expiredIds: { type: "array", items: { type: "string" } },
      dryRun: { type: "boolean" },
    },
  },
  render: (_args, value) => {
    const act = value.dryRun ? "would remove" : "removed";
    return [{ type: "text", text: `memory: ${act} ${value.removed} expired entr${value.removed === 1 ? "y" : "ies"}` }];
  },
};

const TRANSFER_OUTPUT = {
  schema: {
    type: "object",
    additionalProperties: true,
    properties: {
      count: { type: "number", required: true },
      imported: { type: "number" },
      skipped: { type: "number" },
      path: { type: "string" },
    },
  },
  render: (_args, value) => {
    if (value.path) return [{ type: "text", text: `memory: exported ${value.count} entries to ${value.path}` }];
    return [{ type: "text", text: `memory: imported ${value.imported}, skipped ${value.skipped}` }];
  },
};

function present(title, kind = "other", raw) {
  return { card: "generic", title, kind, ...(raw === undefined ? {} : { rawInput: raw }) };
}

/**
 * Build the memory API used by both the model tools and the web UI route.
 */
export function createMemoryApi(store, { defaultLimit = 10, maxRecallBytes = 12000 } = {}) {
  return {
    async save(args, exec) {
      const input = {
        id: args.id,
        kind: args.kind,
        title: args.title,
        content: args.content,
        tags: args.tags,
        importance: args.importance,
        scope: args.scope,
        workspace: args.workspace ?? workspaceOf(exec),
        links: args.links,
        expires_at: args.expires_at,
        source: exec?.agent ? { kind: "agent", session: exec.agent.session?.id ?? null } : { kind: "user" },
      };
      const entry = await store.save(input);
      return {
        id: entry.id,
        kind: entry.kind,
        title: entry.title,
        tags: entry.tags,
        importance: entry.importance,
        scope: entry.scope,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      };
    },

    async search(args, exec) {
      const ws = args.workspace ?? workspaceOf(exec);
      return store.search({
        query: args.query,
        scope: args.scope,
        workspace: ws,
        orderBy: args.order_by,
        limit: clampLimit(args.limit, defaultLimit),
        offset: clampOffset(args.offset),
        mode: args.mode,
      });
    },

    async list(args, exec) {
      const ws = args.workspace ?? workspaceOf(exec);
      const result = await store.search({
        query: "",
        scope: args.scope,
        workspace: ws,
        orderBy: args.order_by ?? "updated",
        limit: clampLimit(args.limit, defaultLimit),
        offset: clampOffset(args.offset),
        mode: "keyword",
      });
      // Re-filter by kind/tags since an empty query has no DSL filters.
      const hits = result.hits.filter((h) => {
        if (args.kind && h.kind !== args.kind) return false;
        if (Array.isArray(args.tags) && args.tags.length > 0 && !args.tags.some((t) => h.tags.includes(t))) return false;
        return true;
      });
      return { count: hits.length, total: hits.length, offset: result.offset, limit: result.limit, mode: "list", usedSemantic: false, hits };
    },

    async get(args) {
      let ids = Array.isArray(args.ids) ? args.ids.filter((x) => typeof x === "string") : [];
      if (ids.length === 0 && args.title) {
        const found = store.findByTitle(args.title);
        if (found) ids = [found.id];
      }
      ids = ids.slice(0, 25);
      const entries = store.getMany(ids, { maxBytes: args.max_bytes ?? maxRecallBytes });
      return { entries };
    },

    async remove(args) {
      const ids = (Array.isArray(args.ids) ? args.ids : []).filter((x) => typeof x === "string");
      const deleted = await store.remove(ids);
      return { deleted };
    },

    async stats() {
      return store.stats();
    },

    async prune(args) {
      const result = await store.pruneExpired({ dryRun: Boolean(args.dry_run) });
      return result;
    },

    async exportEntries(args, exec) {
      const scope = args.scope === "global" || args.scope === "workspace" ? args.scope : "all";
      const { count, entries } = store.exportEntries({ scope, workspace: workspaceOf(exec) });
      let path = args.path;
      if (typeof path !== "string" || path.trim() === "") {
        const stamp = new Date().toISOString().slice(0, 10);
        path = `${store.root}/memory-export-${stamp}.json`;
      }
      const { writeFileSync } = await import("node:fs");
      const { dirname } = await import("node:path");
      const { mkdirSync } = await import("node:fs");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), entries }, null, 2), "utf8");
      return { count, path };
    },

    async importEntries(args) {
      const { readFileSync } = await import("node:fs");
      let data;
      try {
        data = JSON.parse(readFileSync(args.path, "utf8"));
      } catch (error) {
        throw new Error(`cannot read import file ${args.path}: ${error?.message ?? error}`);
      }
      return store.importEntries(data, { replace: Boolean(args.replace) });
    },
  };
}

function clampLimit(v, def) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) return def;
  return Math.min(100, Math.floor(n));
}

function clampOffset(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/**
 * Register all memory_* tools on a ctx with a live tools service.
 * @param {import("@deepseek-ai/cordis").Context} ctx
 * @param {ReturnType<typeof createMemoryApi>} api
 */
export function registerTools(ctx, api) {
  const T = (def) => ctx.tools.register(defineTool(def));

  T({
    name: "memory_save",
    description: "Save one durable memory entry (create or update by id). Use for facts, decisions, preferences, conventions, task results, and reference material you want to survive compaction and session end. Content is stored out of the conversation, so keep only a compact summary inline. Never store secrets.",
    parameters: {
      content: { type: "string", required: true, description: "Full content of the memory entry." },
      id: { type: "string", description: "Existing memory id to update; omit to create a new entry." },
      title: { type: "string", description: "Short title (shown in search results)." },
      kind: { type: "string", enum: KINDS, description: "Entry kind. Default note." },
      tags: { type: "array", items: { type: "string" }, description: "Tags for structured filtering." },
      importance: { type: "number", description: "1 (low) to 5 (critical). Default 3." },
      scope: { type: "string", enum: SCOPE_ENUM, description: "workspace (default, tied to this project) or global (any project)." },
      links: { type: "array", items: { type: "string" }, description: "Ids of related memory entries." },
      expires_at: { type: "string", description: "ISO timestamp; entry is pruned after this (use for temporary context)." },
    },
    output: SAVED_OUTPUT,
    execute(args, exec) { return api.save(args, exec); },
    presentCall: (args) => present("Save memory", "other", args.title ?? args.content?.slice(0, 80)),
  });

  T({
    name: "memory_search",
    description: "Search the memory store with structured filters and ranked results. Returns compact hits; call memory_get with ids for full content. Query language: free text plus field filters like kind:decision tag:auth importance:>3 since:7d \"exact phrase\" +must -without link:mem_abc scope:global workspace:/abs/path updated:>2026-01-01. Filters are ANDed; repeated kind:/tag: are ORed within the field. Use mode semantic or hybrid for embedding-based ranking when enabled.",
    parameters: {
      query: { type: "string", description: "Free text plus optional inline field filters (see description)." },
      kind: { type: "string", enum: KINDS, description: "Restrict to one kind." },
      tags: { type: "array", items: { type: "string" }, description: "Entries must have at least one of these tags." },
      scope: { type: "string", enum: ["auto", "global", "workspace", "all"], description: "auto (default): global + current workspace; all: every workspace." },
      workspace: { type: "string", description: "Absolute workspace path to search (defaults to the calling session's workspace)." },
      importance_min: { type: "number", description: "Minimum importance 1-5." },
      since: { type: "string", description: "Only entries created after this (ISO date, or relative like 7d/2w/3mo/1y)." },
      until: { type: "string", description: "Only entries created before this." },
      link: { type: "string", description: "Only entries linking to this memory id." },
      order_by: { type: "string", enum: ORDER_ENUM, description: "Default relevance." },
      limit: { type: "number", description: "Max hits (default 10)." },
      offset: { type: "number", description: "Paging offset." },
      mode: { type: "string", enum: MODE_ENUM, description: "auto (default): semantic when enabled and a query is present, else lexical; keyword/semantic/hybrid force a mode." },
    },
    output: SEARCH_OUTPUT,
    execute(args, exec) { return api.search(args, exec); },
    presentCall: (args) => present("Search memory", "search", args.query ?? ""),
    presentResult: (args, value) => ({
      card: "search",
      shape: "matches",
      title: `memory: ${value.total} hits`,
      truncated: false,
      total: value.total,
    }),
  });

  T({
    name: "memory_get",
    description: "Fetch full memory entries by id (or by exact/prefix title). Use after memory_search to read the complete content of chosen hits. Content is capped to keep the response small.",
    parameters: {
      ids: { type: "array", items: { type: "string" }, description: "Memory ids to fetch (1-25)." },
      title: { type: "string", description: "Fetch by exact (or prefix) title when ids are not given." },
      max_bytes: { type: "number", description: "Per-entry content cap." },
    },
    output: ENTRY_OUTPUT,
    execute(args) { return api.get(args); },
    presentCall: (args) => present("Read memory", "read", args.ids?.join(", ") ?? args.title),
  });

  T({
    name: "memory_list",
    description: "Browse the memory store like a table: newest-first listing with optional kind/tag/scope filters and paging. Use memory_stats first to see what exists.",
    parameters: {
      kind: { type: "string", enum: KINDS, description: "Restrict to one kind." },
      tags: { type: "array", items: { type: "string" }, description: "Entries must have at least one of these tags." },
      scope: { type: "string", enum: ["auto", "global", "workspace", "all"], description: "Default auto (global + current workspace)." },
      workspace: { type: "string", description: "Absolute workspace path (defaults to the calling session's workspace)." },
      order_by: { type: "string", enum: ORDER_ENUM, description: "Default updated (newest first)." },
      limit: { type: "number", description: "Max rows." },
      offset: { type: "number", description: "Paging offset." },
    },
    output: SEARCH_OUTPUT,
    execute(args, exec) { return api.list(args, exec); },
    presentCall: (args) => present("List memory", "list", args.kind ?? ""),
  });

  T({
    name: "memory_delete",
    description: "Delete memory entries by id. Returns the number deleted.",
    parameters: {
      ids: { type: "array", items: { type: "string" }, required: true, description: "Memory ids to delete." },
    },
    output: DELETED_OUTPUT,
    execute(args) { return api.remove(args); },
    presentCall: (args) => present("Delete memory", "other", args.ids?.join(", ")),
  });

  T({
    name: "memory_stats",
    description: "Memory store statistics: totals by kind/scope, top tags, expired count, semantic status, and storage location. Call this to understand what the store contains before searching or cleaning.",
    parameters: {},
    output: STATS_OUTPUT,
    execute() { return api.stats(); },
    presentCall: () => present("Memory stats", "read"),
  });

  T({
    name: "memory_prune",
    description: "Remove expired entries (expires_at in the past). Use dry_run=true to preview what would be removed.",
    parameters: {
      expired: { type: "boolean", description: "Prune expired entries (always true in this version)." },
      dry_run: { type: "boolean", description: "Only report, do not delete." },
    },
    output: PRUNE_OUTPUT,
    execute(args) { return api.prune(args); },
    presentCall: (args) => present(args?.dry_run ? "Preview memory prune" : "Prune memory", "other"),
  });

  T({
    name: "memory_export",
    description: "Export the memory store (or one scope) to a JSON file for backup or migration. Returns the written path.",
    parameters: {
      path: { type: "string", description: "Target file path; defaults to <root>/memory-export-<date>.json." },
      scope: { type: "string", enum: ["all", "global", "workspace"], description: "Which entries to export. Default all." },
    },
    output: TRANSFER_OUTPUT,
    execute(args, exec) { return api.exportEntries(args, exec); },
    presentCall: (args) => present("Export memory", "other"),
  });

  T({
    name: "memory_import",
    description: "Import memory entries from a memorycontrol export file (or a bare array of entries). Existing ids are skipped unless replace=true.",
    parameters: {
      path: { type: "string", required: true, description: "Path to the import JSON file." },
      replace: { type: "boolean", description: "Overwrite entries that already exist (default false = skip)." },
    },
    output: TRANSFER_OUTPUT,
    execute(args) { return api.importEntries(args); },
    presentCall: (args) => present("Import memory", "other", args.path),
  });
}
