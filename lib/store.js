/**
 * MemoryStore: durable, local-first storage for memory entries.
 *
 * Layout: a single JSON document at `<root>/entries.json`:
 *   { "version": 1, "updatedAt": "...", "entries": [ ... ] }
 *
 * Every mutation is persisted atomically (temp file + fsync + rename), so a
 * crash never leaves a half-written file. The in-memory inverted index is
 * maintained incrementally and rebuilt on load.
 *
 * Entry shape:
 *   {
 *     id: string, kind: string, title: string, content: string,
 *     tags: string[], importance: 1..5, scope: 'global'|'workspace',
 *     workspace: string|null, links: string[],
 *     source: { kind: 'agent'|'user'|'tool'|'auto', session?: string } | null,
 *     createdAt: ISO, updatedAt: ISO, expiresAt: ISO|null,
 *     embedding: number[]|undefined   // only when semantic search is enabled
 *   }
 */
import { join } from "node:path";
import { statSync } from "node:fs";
import {
  addToIndex, buildIndex, removeFromIndex, searchEntries, tokenize,
} from "./search.js";
import { parseQuery } from "./query.js";
import { Embedder, cosine } from "./semantic.js";
import {
  atomicWriteJson, clampImportance, isValidDate, memoryRoot, newId,
  normPath, nowIso, readJson,
} from "./util.js";

export const KINDS = [
  "fact", "decision", "preference", "knowledge", "todo", "note",
  "context", "person", "project", "code", "other",
];

function coerceTags(v) {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map(String).filter((t) => t.trim() !== "").map((t) => t.trim()))];
}

function coerceLinks(v) {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((x) => typeof x === "string" && x.trim() !== ""))];
}

function coerceEntry(raw, { preserveId = true } = {}) {
  const id = preserveId && typeof raw?.id === "string" && raw.id !== "" ? raw.id : newId();
  const scope = raw?.scope === "global" ? "global" : "workspace";
  const now = nowIso();
  return {
    id,
    kind: KINDS.includes(raw?.kind) ? raw.kind : "note",
    title: typeof raw?.title === "string" ? raw.title : "",
    content: typeof raw?.content === "string" ? raw.content : "",
    tags: coerceTags(raw?.tags),
    importance: clampImportance(raw?.importance ?? 3),
    scope,
    workspace: scope === "global" ? null : normPath(raw?.workspace ?? process.cwd()),
    links: coerceLinks(raw?.links),
    source: raw?.source ?? null,
    createdAt: isValidDate(raw?.createdAt) ? raw.createdAt : now,
    updatedAt: isValidDate(raw?.updatedAt) ? raw.updatedAt : now,
    expiresAt: isValidDate(raw?.expiresAt) ? raw.expiresAt : null,
    embedding: Embedder.isVector(raw?.embedding) ? raw.embedding : undefined,
  };
}

export class MemoryStore {
  constructor({ root, embedding, maxContentBytes = 65536 } = {}) {
    this.root = memoryRoot(root);
    this.file = join(this.root, "entries.json");
    this.maxContentBytes = maxContentBytes;
    this.embedder = new Embedder(embedding);
    this.entries = new Map();
    this.index = new Map();
    this.load();
  }

  load() {
    const doc = readJson(this.file);
    const list = Array.isArray(doc?.entries) ? doc.entries : [];
    this.entries = new Map();
    for (const raw of list) {
      if (!raw || typeof raw.id !== "string" || raw.id === "") continue;
      this.entries.set(raw.id, coerceEntry(raw));
    }
    this.index = buildIndex([...this.entries.values()]);
  }

  persist() {
    atomicWriteJson(this.file, {
      version: 1,
      updatedAt: nowIso(),
      entries: [...this.entries.values()],
    });
  }

  get(id) {
    return this.entries.get(id);
  }

  has(id) {
    return this.entries.has(id);
  }

  count() {
    return this.entries.size;
  }

  all() {
    return [...this.entries.values()];
  }

  #indexEntry(entry) {
    addToIndex(this.index, entry);
  }

  #unindexEntry(entry) {
    removeFromIndex(this.index, entry);
  }

  async #maybeEmbed(entry) {
    if (!this.embedder.available()) return;
    const vec = await this.embedder.embed(`${entry.title ?? ""}\n${entry.content ?? ""}`);
    if (vec) entry.embedding = vec;
    else if (entry.embedding !== undefined) delete entry.embedding;
  }

  /**
   * Create or update an entry. Merges provided fields on update (preserving
   * createdAt and unset fields), then persists.
   * @param {object} input
   * @returns {Promise<object>} the stored entry
   */
  async save(input) {
    const now = nowIso();
    const existing = typeof input?.id === "string" ? this.entries.get(input.id) : undefined;
    if (existing) {
      const merged = { ...existing };
      // Unindex with the OLD terms before mutating, then re-index after.
      this.#unindexEntry(merged);
      const textChanged = input.content !== undefined || input.title !== undefined;
      if (input.kind !== undefined) merged.kind = KINDS.includes(input.kind) ? input.kind : existing.kind;
      if (input.title !== undefined) merged.title = String(input.title ?? "");
      if (input.content !== undefined) merged.content = String(input.content ?? "");
      if (input.tags !== undefined) merged.tags = coerceTags(input.tags);
      if (input.importance !== undefined) merged.importance = clampImportance(input.importance);
      if (input.scope !== undefined) {
        merged.scope = input.scope === "global" ? "global" : "workspace";
        merged.workspace = merged.scope === "global" ? null : normPath(input.workspace ?? merged.workspace ?? process.cwd());
      }
      if (input.links !== undefined) merged.links = coerceLinks(input.links);
      if (input.expires_at !== undefined) merged.expiresAt = isValidDate(input.expires_at) ? input.expires_at : null;
      merged.content = merged.content.slice(0, this.maxContentBytes);
      merged.updatedAt = now;
      this.#indexEntry(merged);
      if (textChanged) await this.#maybeEmbed(merged);
      this.persist();
      return merged;
    }
    const entry = coerceEntry({
      id: input?.id,
      kind: input?.kind,
      title: input?.title,
      content: String(input?.content ?? "").slice(0, this.maxContentBytes),
      tags: input?.tags,
      importance: input?.importance,
      scope: input?.scope,
      workspace: input?.workspace,
      links: input?.links,
      source: input?.source,
      expiresAt: input?.expires_at,
    });
    this.entries.set(entry.id, entry);
    this.#indexEntry(entry);
    await this.#maybeEmbed(entry);
    this.persist();
    return entry;
  }

  /** Delete entries by id. Returns the number removed. */
  async remove(ids) {
    let removed = 0;
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (!entry) continue;
      this.#unindexEntry(entry);
      this.entries.delete(id);
      removed += 1;
    }
    if (removed > 0) this.persist();
    return removed;
  }

  /** Delete entries whose expiresAt has passed. */
  async pruneExpired({ dryRun = false } = {}) {
    const now = Date.now();
    const expired = [];
    for (const entry of this.entries.values()) {
      if (entry.expiresAt && Date.parse(entry.expiresAt) <= now) expired.push(entry.id);
    }
    if (dryRun || expired.length === 0) {
      return { removed: 0, expiredIds: expired, dryRun };
    }
    const removed = await this.remove(expired);
    return { removed, expiredIds: expired, dryRun: false };
  }

  /**
   * Search entries. `scopeFilter` is one of 'global' | 'workspace' | 'all',
   * and `workspace` is the absolute normalized workspace path (used when the
   * scope filter or the DSL asks for workspace entries).
   */
  async search({ query = "", scope = "auto", workspace = null, orderBy = "relevance", limit = 10, offset = 0, mode = "auto" } = {}) {
    const q = parseQuery(query);
    const f = q.filters;

    let pool = [...this.entries.values()];
    const effectiveScope = scope === "auto" ? (f.scopes[0] ?? "auto") : scope;
    if (effectiveScope === "global") {
      pool = pool.filter((e) => e.scope === "global");
    } else if (effectiveScope === "workspace") {
      const ws = normPath(f.workspace ?? workspace ?? process.cwd());
      pool = pool.filter((e) => e.scope === "workspace" && e.workspace === ws);
    } else if (effectiveScope === "all") {
      pool = pool.filter((e) => e.scope === "global" || e.scope === "workspace");
    } else {
      const ws = normPath(f.workspace ?? workspace ?? process.cwd());
      pool = pool.filter((e) => e.scope === "global" || (e.scope === "workspace" && e.workspace === ws));
    }

    let usedSemantic = false;
    let semanticNote = null;
    let scores = null;
    const wantSemantic = mode === "semantic" || mode === "hybrid" || (mode === "auto" && q.text.length > 0 && q.phrase === null);
    if (wantSemantic && this.embedder.available()) {
      const vec = await this.embedder.embed(q.text.join(" ") || q.phrase || "");
      if (vec) {
        usedSemantic = true;
        scores = new Map();
        for (const e of pool) {
          if (Embedder.isVector(e.embedding)) scores.set(e.id, cosine(vec, e.embedding));
        }
      } else {
        semanticNote = "semantic search requested but no embedding could be computed; fell back to lexical search";
      }
    } else if (wantSemantic) {
      semanticNote = "semantic search unavailable (embedding.enabled=false or missing API key); using lexical search";
    }

    const base = searchEntries({ entries: pool, index: this.index, q, orderBy, limit, offset, nowMs: Date.now() });

    if (usedSemantic && mode === "semantic") {
      // Rank purely by similarity (still respecting filters/phrase/must).
      const ordered = [...base.hits]
        .map((hit) => ({ hit, sim: scores.get(hit.id) ?? -1 }))
        .sort((a, b) => b.sim - a.sim)
        .map((x) => ({ ...x.hit, score: Math.round(x.sim * 100) / 100 }));
      return {
        count: ordered.length,
        total: base.total,
        offset,
        limit,
        mode: "semantic",
        usedSemantic: true,
        hits: ordered,
        semanticNote: null,
      };
    }

    let hits = base.hits;
    if (usedSemantic && mode === "hybrid") {
      const kwMax = Math.max(1, ...base.hits.map((h) => h.score));
      const hitsWithHybrid = base.hits.map((h) => ({
        ...h,
        score: Math.round((0.6 * (h.score / kwMax) + 0.4 * (scores.get(h.id) ?? 0)) * 100) / 100,
      }));
      hitsWithHybrid.sort((a, b) => b.score - a.score);
      hits = hitsWithHybrid;
    }

    return {
      count: hits.length,
      total: base.total,
      offset,
      limit,
      mode: usedSemantic ? "hybrid" : "lexical",
      usedSemantic,
      semanticNote,
      hits,
    };
  }

  /** Full entry bodies by id (content capped). */
  getMany(ids, { maxBytes = 12000 } = {}) {
    const out = [];
    for (const id of ids) {
      const e = this.entries.get(id);
      if (!e) continue;
      const content = e.content.length > maxBytes ? `${e.content.slice(0, maxBytes)}…[truncated ${e.content.length - maxBytes} chars]` : e.content;
      out.push({
        id: e.id,
        kind: e.kind,
        title: e.title,
        content,
        tags: e.tags ?? [],
        importance: e.importance ?? 3,
        scope: e.scope,
        workspace: e.workspace,
        links: e.links ?? [],
        source: e.source,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
        expiresAt: e.expiresAt ?? null,
      });
    }
    return out;
  }

  /** Entry by exact (case-insensitive) or prefix title match. */
  findByTitle(title) {
    const t = String(title ?? "").toLowerCase().trim();
    if (!t) return null;
    for (const e of this.entries.values()) {
      if ((e.title ?? "").toLowerCase() === t) return e;
    }
    for (const e of this.entries.values()) {
      if ((e.title ?? "").toLowerCase().startsWith(t)) return e;
    }
    return null;
  }

  stats() {
    const byKind = {};
    const byScope = { global: 0, workspace: 0 };
    const tagCounts = new Map();
    let expired = 0;
    let withEmbeddings = 0;
    const now = Date.now();
    for (const e of this.entries.values()) {
      byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
      byScope[e.scope] = (byScope[e.scope] ?? 0) + 1;
      for (const tag of e.tags ?? []) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      if (e.expiresAt && Date.parse(e.expiresAt) <= now) expired += 1;
      if (Embedder.isVector(e.embedding)) withEmbeddings += 1;
    }
    const tags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([tag, count]) => ({ tag, count }));
    let sizeBytes = 0;
    try {
      sizeBytes = statSync(this.file).size;
    } catch {
      sizeBytes = 0;
    }
    return {
      total: this.entries.size,
      byKind,
      byScope,
      topTags: tags,
      expired,
      withEmbeddings,
      semanticEnabled: this.embedder.available(),
      root: this.root,
      file: this.file,
      sizeBytes,
    };
  }

  /** All entries for export (embeddings stripped, mutable copies). */
  exportEntries({ scope = "all", workspace = null } = {}) {
    const ws = normPath(workspace ?? process.cwd());
    const list = [];
    for (const e of this.entries.values()) {
      if (scope === "global" && e.scope !== "global") continue;
      if (scope === "workspace" && !(e.scope === "workspace" && e.workspace === ws)) continue;
      const { embedding, ...rest } = e;
      list.push(rest);
    }
    return { count: list.length, entries: list };
  }

  /** Import entries from an exported document or a bare array. */
  async importEntries(data, { replace = false } = {}) {
    let list = null;
    if (Array.isArray(data)) list = data;
    else if (Array.isArray(data?.entries)) list = data.entries;
    if (!list) throw new Error("import data must be an array of entries or a memorycontrol export document");
    let imported = 0;
    let skipped = 0;
    for (const raw of list) {
      if (!raw || typeof raw !== "object") {
        skipped += 1;
        continue;
      }
      const id = typeof raw.id === "string" && raw.id !== "" ? raw.id : null;
      if (id && this.entries.has(id) && !replace) {
        skipped += 1;
        continue;
      }
      const entry = coerceEntry(raw);
      if (this.entries.has(entry.id)) this.#unindexEntry(this.entries.get(entry.id));
      this.entries.set(entry.id, entry);
      this.#indexEntry(entry);
      imported += 1;
    }
    if (imported > 0) this.persist();
    return { imported, skipped };
  }
}
