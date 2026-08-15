/**
 * memorycontrol — plug-and-play structured memory for DeepSeek Harness.
 *
 * Host half: registers the memory_* tools, the memory guidance prompt section,
 * and (in web profiles) the browser UI JSON API. Durable storage is a local
 * JSON document under $DSH_HOME/memory (configurable via `root`).
 *
 * Install:  dsh plugin --profile web add memorycontrol   (or a git/path spec)
 * The package declares `dsh.bundle`, so the install appends this row to the
 * profile automatically.
 */
import z from "@deepseek-ai/schemastery";
import { MemoryStore } from "./store.js";
import { createMemoryApi, registerTools } from "./tools.js";
import { registerWebApi } from "./web.js";
import { ContextManager } from "./context.js";
import { PROMPT } from "./prompt.js";

export const name = "memorycontrol";
export const inject = ["tools", "systemPrompt", "sessions", "llm"];

const EMBEDDING_DEFAULTS = {
  enabled: false,
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-embedding",
  apiKeyEnv: "DEEPSEEK_API_KEY",
};

const EXTRACT_DEFAULTS = {
  enabled: true,
  minNewChars: 2000,
  maxInputChars: 30000,
  minIntervalMs: 60000,
  maxTokens: 2048,
  provider: "",
  model: "",
};

const ARCHIVE_DEFAULTS = {
  enabled: true,
  maxChars: 60000,
};

const RECALL_DEFAULTS = {
  enabled: true,
  onSessionStart: true,
  budgetChars: 6000,
  maxEntries: 8,
};

export const Config = z.object({
  root: z.string().default(""),
  registerTools: z.boolean().default(true),
  prompt: z.boolean().default(true),
  webApi: z.boolean().default(true),
  defaultLimit: z.number().step(1).min(1).max(100).default(10),
  maxRecallBytes: z.number().step(1).min(256).max(1_000_000).default(12000),
  maxContentBytes: z.number().step(1).min(256).max(10_000_000).default(65536),
  embedding: z.object({
    enabled: z.boolean().default(false),
    baseUrl: z.string().default("https://api.deepseek.com"),
    model: z.string().default("deepseek-embedding"),
    apiKeyEnv: z.string().default("DEEPSEEK_API_KEY"),
  }).default({ ...EMBEDDING_DEFAULTS }),
  context: z.object({
    enabled: z.boolean().default(true),
    extract: z.object({
      enabled: z.boolean().default(true),
      minNewChars: z.number().step(1).min(100).max(100000).default(2000),
      maxInputChars: z.number().step(1).min(1000).max(200000).default(30000),
      minIntervalMs: z.number().step(1).min(1000).default(60000),
      maxTokens: z.number().step(1).min(64).max(16000).default(2048),
      provider: z.string().default(""),
      model: z.string().default(""),
    }).default({ ...EXTRACT_DEFAULTS }),
    archive: z.object({
      enabled: z.boolean().default(true),
      maxChars: z.number().step(1).min(1000).max(500000).default(60000),
    }).default({ ...ARCHIVE_DEFAULTS }),
    recall: z.object({
      enabled: z.boolean().default(true),
      onSessionStart: z.boolean().default(true),
      budgetChars: z.number().step(1).min(200).max(100000).default(6000),
      maxEntries: z.number().step(1).min(1).max(50).default(8),
    }).default({ ...RECALL_DEFAULTS }),
  }).default({
    enabled: true,
    extract: { ...EXTRACT_DEFAULTS },
    archive: { ...ARCHIVE_DEFAULTS },
    recall: { ...RECALL_DEFAULTS },
  }),
});

/** Validate/normalize config even when apply is called directly. */
export function resolveConfig(config) {
  const c = config ?? {};
  const embedding = { ...EMBEDDING_DEFAULTS, ...(c.embedding ?? {}) };
  const context = {
    enabled: c.context?.enabled ?? true,
    extract: { ...EXTRACT_DEFAULTS, ...(c.context?.extract ?? {}) },
    archive: { ...ARCHIVE_DEFAULTS, ...(c.context?.archive ?? {}) },
    recall: { ...RECALL_DEFAULTS, ...(c.context?.recall ?? {}) },
  };
  const pick = (v, def) => (v === undefined || v === null ? def : v);
  const num = (v, def, lo, hi) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return def;
    return Math.min(hi, Math.max(lo, n));
  };
  return {
    root: pick(c.root, ""),
    registerTools: pick(c.registerTools, true),
    prompt: pick(c.prompt, true),
    webApi: pick(c.webApi, true),
    defaultLimit: num(c.defaultLimit, 10, 1, 100),
    maxRecallBytes: num(c.maxRecallBytes, 12000, 256, 1_000_000),
    maxContentBytes: num(c.maxContentBytes, 65536, 256, 10_000_000),
    embedding,
    context,
  };
}

export function apply(ctx, config) {
  const cfg = resolveConfig(config);
  const store = new MemoryStore({
    root: cfg.root,
    embedding: cfg.embedding,
    maxContentBytes: cfg.maxContentBytes,
  });
  const api = createMemoryApi(store, {
    defaultLimit: cfg.defaultLimit,
    maxRecallBytes: cfg.maxRecallBytes,
  });
  const cm = new ContextManager(ctx, store, cfg.context);
  cm.start();
  api.context = cm;
  // Debug/diagnostic handle (used by tests; harmless in production).
  ctx.__memorycontrol = { store, api, context: cm };

  // The store is file-backed and synchronous on mutation; nothing to dispose,
  // but keep the effect so future async work (e.g. periodic flush) has a home.
  ctx.effect(() => () => {}, "memorycontrol: store");

  if (cfg.registerTools !== false) {
    registerTools(ctx, api);
  }
  if (cfg.prompt !== false) {
    ctx.systemPrompt.section({ name: "memory:control", order: 116, text: PROMPT });
  }
  if (cfg.webApi !== false) {
    registerWebApi(ctx, api, {
      resolveWorkspace: (sessionId) => {
        try {
          const session = ctx.sessions.get(sessionId);
          return session?.header?.cwd ?? null;
        } catch {
          return null;
        }
      },
    });
  }
}
