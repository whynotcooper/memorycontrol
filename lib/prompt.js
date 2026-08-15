/**
 * Model-facing guidance for the memory_* tools, injected as a system prompt
 * section (order 116, after the goal tools at 114).
 */
export const PROMPT = `# memorycontrol: persistent structured memory

You have a durable, local-first memory store (JSON under $DSH_HOME/memory, default ~/.dsh/memory). It survives restarts and is shared across sessions of the same workspace, so it is the place to park information you do not want to lose when the conversation is compacted or the session ends.

## Save (memory_save) — when you learn something durable
- User preferences and hard constraints; project conventions and naming rules; architecture decisions and the reasoning behind them; completed tasks with their key results; code layout and build facts; connection/API details without secrets; reference material too long to keep inline.
- Keep entries small and focused. Prefer several linked entries over one giant one; use tags, kind, importance, and links so the structure stays queryable.
- Content is stored out-of-band: save full details, then keep only a compact summary in the conversation. That is how you free context without losing information.
- Never store secrets (API keys, tokens, passwords, private keys).

## Recall — at the start of a task, and whenever context was compacted
- Search memory before re-deriving facts or re-asking the user: memory_search.
- memory_search returns compact hits (id, title, snippet, kind, tags, dates) to keep the result small. Call memory_get with the ids when you need the full text.
- Use memory_stats to see what the store contains and memory_list to browse.

## Structured search (the query language)
Free text plus field filters, e.g.:
  memory_search(query='token refresh', kind='decision', tags=['auth'], importance_min=4, since='2026-01-01', link='mem_...')
Inline DSL also works in the query string:
  kind:decision tag:auth importance:>3 since:7d "exact phrase" +must -without workspace:/abs/path scope:global link:mem_abc updated:>2026-01-01
Filters are ANDed; repeated kind:/tag: values are ORed within that field. Omit scope to search global + the current workspace.

## Hygiene
- memory_delete removes wrong or outdated entries; memory_prune drops expired ones (expires_at).
- memory_export backs up the store; memory_import restores or merges one.

Entry fields: id, kind (fact|decision|preference|knowledge|todo|note|context|person|project|code|other), title, content, tags[], importance 1-5, scope (global|workspace), workspace, links[] (ids of related entries), createdAt, updatedAt, expiresAt?.`;
