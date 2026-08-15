# self-memorycontrol

**Plug-and-play context management + structured memory for DeepSeek Harness (DSH).**

The harness ships its own built-in `memory_*` tools; **self-memorycontrol**
complements them: it shares the same local store and query DSL, and adds a
browser Memory tab, optional semantic search, and full configuration — plus
an active context engine that keeps long multi-turn conversations lean.

Save context out of the conversation, recall it precisely, and search memory
like a database — structured filters, a query DSL, fuzzy matching, and
optional semantic embeddings. Local-first, zero external services, no build
step: install from git or a local folder with one `dsh plugin add`.

> **Naming.** The repo is `whynotcooper/memorycontrol`; the npm package is
> `self-memorycontrol` — renamed so it is never confused with the memory
> system built into DeepSeek Harness itself.

## vs the harness's built-in memory

| | DSH built-in `memory_*` tools | **self-memorycontrol** |
| --- | --- | --- |
| Tools | memory_save/search/get/list/delete/stats/prune/export/import + context_status/context_archive | registers the same names, **skipped automatically when the harness already provides them** (duplicate guard) |
| Storage | `$DSH_HOME/memory/entries.json` | **same file, same schema** — data is shared both ways |
| Query DSL | `kind: tag: importance:>3 since:7d "phrase" +must -without` | **same DSL** |
| Scoping | workspace (per project) + global | **same** (auto-recall = global + current workspace) |
| Context engine | turn extraction + compaction archiving + `<memory-recall>` | **same design**, driven by the harness's own `compaction/*` session events |
| Browser UI | none | **Memory tab** in the conversation view (search / browse / create / delete) |
| Semantic search | none (lexical only) | **optional embeddings** (`semantic` / `hybrid` ranking) |
| Configuration | none (fixed) | **fully configurable** (root, budgets, toggles, per-feature switches) |
| Portability | tied to DSH releases | **independent open-source package** — install on any profile, extend, publish |

In short: the built-in memory is the core; self-memorycontrol is the
enhanced, configurable, visible side of the same memory. Both write to one
store, so nothing is duplicated.

- **Saves context** — the agent stores full details out-of-band with
  `memory_save` and keeps only compact summaries in the conversation;
  `memory_search` returns small hits, full text is fetched on demand.
- **Manages long conversations (v0.2)** — the context engine keeps long
  multi-turn sessions lean automatically:
  - **Turn-level extraction** — durable knowledge from finished turns is
    distilled into memory (throttled, one small LLM call);
  - **Compaction-aware archiving** — when the harness compacts an old range,
    the full original text is archived verbatim into a searchable memory entry
    and distilled, so nothing is lost (the lossy summary is no longer the only
    trace);
  - **Bounded auto-recall** — at session start (fresh or resumed) the most
    relevant entries for the workspace are injected as a compact
    `<memory-recall>` block;
  - **Explicit controls** — `context_archive` snapshots the conversation now,
    `context_status` reports conversation size / compaction count / telemetry.
- **Structured search** — a database-like query language
  (`kind:decision tag:auth importance:>3 since:7d "exact phrase" -excluded`)
  plus faceted filters, paging, ordering, and fuzzy typo recovery.
- **Durable & local** — one readable JSON document under `$DSH_HOME/memory`
  (default `~/.dsh/memory`), written atomically; survives restarts and is
  shared across sessions of the same workspace.
- **Optional semantic search** — OpenAI-compatible embeddings (e.g. DeepSeek's
  `deepseek-embedding`) for `semantic`/`hybrid` ranking; degrades gracefully
  to lexical search when disabled or missing a key.
- **Web UI** — a Memory tab in the DSH web conversation view for humans:
  search, browse, expand, delete, and create entries without prompting the
  model.
- **Zero deps, zero build** — the browser bundle is hand-written in the web
  module-loader format, so installing from a git URL needs no `prepare` script
  and no pnpm `allowBuilds` dance.

## How it compares to existing DSH memory plugins

| Plugin | External dependency | Structured search | Web UI | Context management |
| --- | --- | --- | --- | --- |
| [dsh-mnemon](https://github.com/omdsh-dev/dsh-mnemon) | `mnemon` CLI | partial (spaces/entities) | sidebar workbench | partial (runtime tier) |
| [dsh-memoryhub](https://github.com/solknight48/dsh-memoryhub) | `mh` CLI (Python, git) | via mh | Memory tab (iframe of mh ui) | partial (checkpoints) |
| [dsh-plugin-meta-memory](https://github.com/YYTbit/dsh-plugin-meta-memory) | none | keyword only | none | brief auto-injection |
| **self-memorycontrol** | **none** | **query DSL + facets + fuzzy + optional semantic** | **Memory tab (native)** | **extract + archive + auto-recall + tools** |

self-memorycontrol is the only one that needs no external binary or service, ships
a real query language for structured recall, and adds an active context engine
on top of the harness's own compaction — so long conversations stay lean and
nothing is lost.

## Install

Prerequisites: DSH `0.1.0-rc.6+`, Node ≥ 22.

```sh
# from GitHub (no build step needed)
dsh plugin --profile web add github:whynotcooper/memorycontrol

# or from a local checkout (dev)
dsh plugin --profile web add link:/absolute/path/to/self-memorycontrol

# or from the npm registry (when published)
dsh plugin --profile web add self-memorycontrol
```

`dsh plugin add` detects the `dsh.bundle` declaration, installs the package,
and appends it to the profile's bundle list automatically. Restart the profile
(`dsh --profile web`) and the Memory tab appears; the `memory_*` tools are
registered only when the harness does not already provide them.

Use a different profile name to enable it elsewhere (`headless`, or a custom
profile created with `dsh plugin`).

## Configuration

All settings are optional. Override any key by restating the whole row in the
profile's `cordis.patch.yml`:

```yaml
# $DSH_HOME/profiles/<name>/cordis.patch.yml
- insert:
    - id: self-memorycontrol
      name: self-memorycontrol
      config:
        root: ''                     # storage root; '' => $DSH_HOME/memory
        registerTools: true          # register the memory_* model tools
        prompt: true                 # memory guidance in the system prompt
        webApi: true                 # browser UI JSON API (web profiles)
        defaultLimit: 10             # default result limit
        maxRecallBytes: 12000        # per-entry cap returned by memory_get
        maxContentBytes: 65536       # per-entry cap accepted by memory_save
        embedding:                   # optional semantic search
          enabled: false
          baseUrl: https://api.deepseek.com
          model: deepseek-embedding
          apiKeyEnv: DEEPSEEK_API_KEY
        context:                     # context-management engine (v0.2)
          enabled: true
          extract:                   # turn-level knowledge extraction
            enabled: true
            minNewChars: 2000        # extract only when >= this much new text
            maxInputChars: 30000     # input cap per extraction call
            minIntervalMs: 60000     # cooldown between extraction calls
            maxTokens: 2048
            provider: ''             # '' = reuse the latest routed request target
            model: ''
          archive:                   # compaction-aware full-fidelity archiving
            enabled: true
            maxChars: 60000          # verbatim text cap per archived range
          recall:                    # bounded auto-recall at session start
            enabled: true
            onSessionStart: true
            budgetChars: 6000        # recall block size cap (≈1500 tokens)
            maxEntries: 8
```

## Tools

| Tool | Purpose |
| --- | --- |
| `memory_save` | Create/update one entry (kind, tags, importance, scope, links, expires_at). |
| `memory_search` | Ranked search with structured filters; returns compact hits. |
| `memory_get` | Fetch full entries by id (or title). |
| `memory_list` | Browse like a table (filters + paging + ordering). |
| `memory_delete` | Delete entries by id. |
| `memory_stats` | Totals by kind/scope, top tags, expiry, semantic status. |
| `memory_prune` | Remove expired entries (`dry_run` to preview). |
| `memory_export` / `memory_import` | Backup and restore/merge JSON files. |
| `context_status` | Conversation size (chars/tokens), compaction count, module telemetry. |
| `context_archive` | Snapshot the whole conversation into a searchable archive now (optionally summarized) + extract durable knowledge. |

### Search query language

```
free terms                  ranked full-text terms
+term  /  -term             must be present / absent
"exact phrase"              phrase must appear (title or content)
kind:decision kind:fact     kind filter (repeatable = OR)
tag:auth  tag:"api design"  tag filter (repeatable = OR)
scope:global|workspace|all  scope filter
workspace:/abs/path         workspace filter (absolute path)
link:mem_abc                entries linking to mem_abc
importance:>3 <2 >=4        importance range
since:2026-01-01            createdAt >= (also 7d / 2w / 3mo / 1y)
until:2026-06-01            createdAt <= (end of day)
created:>x  updated:<x      timestamp ranges
```

Filters are ANDed; repeated `kind:`/`tag:` values are ORed within the field.
`scope:auto` (default) searches global + the current workspace; `scope:all`
searches every workspace.

### Entry shape

```json
{
  "id": "mem_…", "kind": "decision", "title": "…", "content": "…",
  "tags": ["auth"], "importance": 4,
  "scope": "workspace", "workspace": "/abs/path",
  "links": ["mem_…"], "source": {"kind": "agent", "session": "…"},
  "createdAt": "…", "updatedAt": "…", "expiresAt": null
}
```

`kind` ∈ `fact | decision | preference | knowledge | todo | note | context | person | project | code | other`.
Entries are small and linked; the model is guided to prefer many linked
entries over one giant one.

## Storage & data

- Single JSON document: `<root>/entries.json` (`{version, updatedAt, entries}`).
- Every mutation is atomic (temp file + fsync + rename) — a crash never leaves
  a half-written file.
- `memory_export` produces a portable backup; `memory_import` merges one back
  (existing ids skipped unless `replace: true`).
- **Never store secrets** (API keys, tokens, private keys) in memory.

## Security notes

- The web API route (`/plugins/self-memorycontrol/api`) rejects cross-origin
  requests (Origin header check) and is served by the loopback-bound web
  server; only same-origin browser pages can reach it.
- No data ever leaves the machine unless you enable `embedding` (embeddings
  are computed against your configured endpoint with your API key).
- Uninstalling the plugin does not delete `<root>/*.json` — remove them by
  hand if you want the data gone.

## Development

```sh
npm install
npm test          # node --test: store, search, query DSL, tools, web route
```

The package is plain ESM JavaScript — `lib/` is committed as-is, there is no
build step (this is what makes git installs frictionless).

Layout:

```
lib/index.js      host plugin entry (inject, Config, apply)
lib/store.js      MemoryStore: durable JSON store + CRUD + index maintenance
lib/search.js     tokenizer (Latin + CJK bigrams), inverted index, ranking, fuzzy
lib/query.js      structured query DSL parser
lib/semantic.js   optional OpenAI-compatible embeddings client
lib/context.js    ContextManager: turn extraction, compaction archiving, auto-recall
lib/tools.js      the eleven memory_* / context_* tool definitions
lib/web.js        browser UI JSON API route (web profiles only)
lib/client.js     browser half: Memory tab (web module-loader bundle)
lib/prompt.js     memory + context guidance system-prompt section
```

## Design & related work

The context engine builds on established ideas:

- **MemGPT / OS virtual context** ([arXiv:2310.08560](https://arxiv.org/abs/2310.08560)) —
  main context + external memory with paging: we page compacted ranges out to a
  searchable store (full fidelity) and page relevant memory back in at session start.
- **Cognitive architectures (CoALA)** ([arXiv:2309.02427](https://arxiv.org/abs/2309.02427)) —
  working / episodic / semantic memory split: the live surface is working memory,
  archives are episodic, memory entries are semantic.
- **Generative Agents** ([arXiv:2304.03442](https://arxiv.org/abs/2304.03442)) —
  memory stream + recency/importance/relevance retrieval: our auto-recall ranks by
  importance and workspace relevance.
- **MemoryBank** ([arXiv:2305.10250](https://arxiv.org/abs/2305.10250)) and
  **Mem0** ([arXiv:2504.19413](https://arxiv.org/abs/2504.19413)) —
  long-term memory with continuous extraction: our turn-level extraction distills
  durable knowledge before it can be lost to summarization.
- **LLMLingua-style prompt compression** ([arXiv:2310.05736](https://arxiv.org/abs/2310.05736))
  is the direction we deliberately leave to the harness (tool-result pruning,
  `compaction-basic`) and complement instead of reimplement.

Instead of replacing DSH's own compaction, self-memorycontrol observes its durable
`compaction/start|summary|end` session events and adds the two things compaction
cannot do alone: **lossless retention** (the raw shadowed text stays searchable)
and **durable distillation** (knowledge survives the lossy summary).

## License

MIT © whynotcooper
