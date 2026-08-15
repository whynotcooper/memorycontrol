# memorycontrol

**Plug-and-play structured memory for DeepSeek Harness (DSH).**

Save context out of the conversation, recall it precisely, and search memory
like a database — structured filters, a query DSL, fuzzy matching, and
optional semantic embeddings. Local-first, zero external services, no build
step: install from git or a local folder with one `dsh plugin add`.

- **Saves context** — the agent stores full details out-of-band with
  `memory_save` and keeps only compact summaries in the conversation;
  `memory_search` returns small hits, full text is fetched on demand.
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

| Plugin | External dependency | Structured search | Web UI |
| --- | --- | --- | --- |
| [dsh-mnemon](https://github.com/omdsh-dev/dsh-mnemon) | `mnemon` CLI | partial (spaces/entities) | sidebar workbench |
| [dsh-memoryhub](https://github.com/solknight48/dsh-memoryhub) | `mh` CLI (Python, git) | via mh | Memory tab (iframe of mh ui) |
| [dsh-plugin-meta-memory](https://github.com/YYTbit/dsh-plugin-meta-memory) | none | keyword only | none |
| **memorycontrol** | **none** | **query DSL + facets + fuzzy + optional semantic** | **Memory tab (native)** |

memorycontrol is the only one that needs no external binary or service, ships
a real query language for structured recall, and stays fully local.

## Install

Prerequisites: DSH `0.1.0-rc.6+`, Node ≥ 22.

```sh
# from GitHub (no build step needed)
dsh plugin --profile web add github:whynotcooper/memorycontrol

# or from a local checkout (dev)
dsh plugin --profile web add link:/absolute/path/to/memorycontrol

# or from the npm registry (when published)
dsh plugin --profile web add memorycontrol
```

`dsh plugin add` detects the `dsh.bundle` declaration, installs the package,
and appends it to the profile's bundle list automatically. Restart the profile
(`dsh --profile web`) and the `memory_*` tools plus the Memory tab appear.

Use a different profile name to enable it elsewhere (`headless`, or a custom
profile created with `dsh plugin`).

## Configuration

All settings are optional. Override any key by restating the whole row in the
profile's `cordis.patch.yml`:

```yaml
# $DSH_HOME/profiles/<name>/cordis.patch.yml
- insert:
    - id: memorycontrol
      name: memorycontrol
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

- The web API route (`/plugins/memorycontrol/api`) rejects cross-origin
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
lib/tools.js      the nine memory_* tool definitions
lib/web.js        browser UI JSON API route (web profiles only)
lib/client.js     browser half: Memory tab (web module-loader bundle)
lib/prompt.js     memory guidance system-prompt section
```

## License

MIT © whynotcooper
