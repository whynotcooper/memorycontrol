/**
 * Optional semantic search via an OpenAI-compatible embeddings endpoint.
 *
 * Fully optional: when `embedding.enabled` is false or the API key is missing,
 * every method degrades to `null` and the plugin silently falls back to the
 * built-in lexical search. Errors are swallowed and logged once.
 */
export class Embedder {
  constructor(opts = {}) {
    this.enabled = Boolean(opts.enabled);
    this.baseUrl = String(opts.baseUrl || "https://api.deepseek.com").replace(/\/+$/, "");
    this.model = opts.model || "deepseek-embedding";
    this.apiKeyEnv = opts.apiKeyEnv || "DEEPSEEK_API_KEY";
    this.warned = false;
  }

  available() {
    if (!this.enabled) return false;
    const key = process.env[this.apiKeyEnv];
    return typeof key === "string" && key !== "";
  }

  #warn(msg) {
    if (this.warned) return;
    this.warned = true;
    console.warn(`[memorycontrol] semantic search: ${msg}`);
  }

  /**
   * Embed text into a vector, or null when unavailable/failed.
   * @param {string} text
   * @returns {Promise<number[]|null>}
   */
  async embed(text) {
    if (!this.available()) return null;
    const input = String(text ?? "").slice(0, 8000);
    if (input.trim() === "") return null;
    try {
      const res = await fetch(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${process.env[this.apiKeyEnv]}`,
        },
        body: JSON.stringify({ model: this.model, input }),
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) {
        this.#warn(`embeddings endpoint returned HTTP ${res.status}`);
        return null;
      }
      const data = await res.json();
      const vec = data?.data?.[0]?.embedding;
      return Array.isArray(vec) && vec.length > 0 ? vec : null;
    } catch (error) {
      this.#warn(String(error?.message ?? error));
      return null;
    }
  }

  /** Whether a stored value looks like an embedding vector. */
  static isVector(v) {
    return Array.isArray(v) && v.length > 0 && typeof v[0] === "number";
  }
}

/** Cosine similarity between two equal-length vectors. */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
