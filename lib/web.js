/**
 * Browser UI JSON API: one prefix route under the web server serving the same
 * operations as the memory_* tools. Registered only when a web server exists
 * (i.e. the web profile), so headless compositions never notice it.
 *
 * POST /plugins/memorycontrol/api
 *   { op: 'search'|'list'|'get'|'save'|'delete'|'stats'|'prune', args, sessionId }
 *
 * Cross-origin requests are rejected (same-origin check on the Origin header),
 * and the server is loopback-bound by default — see README security notes.
 */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function writeJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

/**
 * Register the memorycontrol API route.
 * @param {object} ctx cordis context (host)
 * @param {ReturnType<import("./tools.js").createMemoryApi>} api
 * @param {{ resolveWorkspace: (sessionId: string) => string|null }} opts
 * @returns {boolean} whether the route was registered
 */
export function registerWebApi(ctx, api, { resolveWorkspace = () => null } = {}) {
  const webServer = ctx.get("webServer");
  if (webServer === undefined) return false;

  const handler = async (req, res) => {
    try {
      if (req.method !== "POST") {
        writeJson(res, 405, { error: "method not allowed" });
        return;
      }
      const origin = req.headers.origin;
      if (origin) {
        let allowed = false;
        try {
          allowed = new URL(origin).host === req.headers.host;
        } catch {
          allowed = false;
        }
        if (!allowed) {
          writeJson(res, 403, { error: "cross-origin request denied" });
          return;
        }
      }
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch (error) {
        writeJson(res, 400, { error: `bad request: ${error?.message ?? error}` });
        return;
      }
      const op = payload?.op;
      const args = (payload?.args ?? {});
      const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : null;

      const handlers = {
        search: (a) => api.search(a, null),
        list: (a) => api.list(a, null),
        get: (a) => api.get(a, null),
        save: (a) => api.save(a, { agent: null }),
        delete: (a) => api.remove(a),
        stats: () => api.stats(),
        prune: (a) => api.prune(a),
      };
      const fn = handlers[op];
      if (!fn) {
        writeJson(res, 400, { error: `unknown op: ${op}` });
        return;
      }
      // Default the workspace to the session's workspace when not given.
      if (args.workspace === undefined && sessionId) {
        try {
          const cwd = resolveWorkspace(sessionId);
          if (cwd) args.workspace = cwd;
        } catch {
          // keep process cwd fallback
        }
      }
      const result = await fn(args);
      writeJson(res, 200, result);
    } catch (error) {
      writeJson(res, 500, { error: `internal error: ${error?.message ?? error}` });
    }
  };

  const disposer = webServer.register({ kind: "prefix", path: "/plugins/memorycontrol/api", handler });
  ctx.effect(() => disposer);
  return true;
}
