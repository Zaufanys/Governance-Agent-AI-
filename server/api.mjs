// REST API handlers. handleApi() owns every /api/* route and returns true once
// it has produced a response. Dashboard routes require a session; the ingestion
// route requires an API key.
import { summarizeTraces } from "../public/js/governanceEngine.js";
import {
  verifyPassword,
  getSessionUser,
  verifyApiKey,
  newToken,
  sessionCookie,
  clearSessionCookie,
  parseCookies,
} from "./auth.mjs";
import { ingestTrace } from "./traces.mjs";

const DECISION_STATUSES = new Set(["approved", "rejected", "escalated"]);

function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  res.end(payload);
  return true; // signal to the router that the request was handled
}

function readJson(req, limitBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(Object.assign(new Error("Payload too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error("Invalid JSON body"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

export async function handleApi(req, res, url, ctx) {
  const { db, config } = ctx;
  const p = url.pathname;
  const method = req.method;
  if (!p.startsWith("/api/")) return false;

  try {
    // --- auth ---
    if (p === "/api/auth/login" && method === "POST") {
      const body = await readJson(req);
      const user = db.getUserByUsername(String(body.username || ""));
      if (!user || !verifyPassword(String(body.password || ""), user.password_hash)) {
        return sendJson(res, 401, { error: "Invalid username or password" });
      }
      const token = newToken();
      const now = Date.now();
      db.createSession({
        token,
        userId: user.id,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + config.sessionTtlMs).toISOString(),
      });
      return sendJson(
        res,
        200,
        { user: { username: user.username, role: user.role } },
        { "Set-Cookie": sessionCookie(token, config.sessionTtlMs) },
      );
    }

    if (p === "/api/auth/logout" && method === "POST") {
      const token = parseCookies(req.headers.cookie).sid;
      if (token) db.deleteSession(token);
      return sendJson(res, 200, { ok: true }, { "Set-Cookie": clearSessionCookie() });
    }

    if (p === "/api/auth/me" && method === "GET") {
      const user = getSessionUser(db, req);
      if (!user) return sendJson(res, 401, { error: "Not authenticated" });
      return sendJson(res, 200, { user: { username: user.username, role: user.role } });
    }

    // --- ingestion (API key) ---
    if (p === "/api/ingest" && method === "POST") {
      if (!verifyApiKey(db, req)) return sendJson(res, 401, { error: "Missing or invalid API key" });
      const body = await readJson(req);
      const items = Array.isArray(body) ? body : [body];
      if (items.length === 0) return sendJson(res, 400, { error: "No trace supplied" });
      const results = [];
      const errors = [];
      items.forEach((item, i) => {
        try {
          results.push(ingestTrace(db, item));
        } catch (err) {
          errors.push({ index: i, errors: err.details || [err.message] });
        }
      });
      if (!Array.isArray(body)) {
        if (errors.length) return sendJson(res, 400, { error: "Invalid trace", details: errors[0].errors });
        return sendJson(res, 201, results[0]);
      }
      return sendJson(res, errors.length ? 207 : 201, { ingested: results.length, results, errors });
    }

    // --- everything below requires a logged-in reviewer ---
    const user = getSessionUser(db, req);
    if (!user) return sendJson(res, 401, { error: "Not authenticated" });

    if (p === "/api/traces" && method === "GET") {
      // Attach governance server-side so API consumers get scored traces
      // without re-implementing the engine.
      const { scored } = summarizeTraces(db.listTraces());
      return sendJson(res, 200, { traces: scored });
    }

    if (p === "/api/summary" && method === "GET") {
      const summary = summarizeTraces(db.listTraces());
      // Strip the (large) per-trace list; callers wanting traces use /api/traces.
      const { scored, ...counts } = summary;
      return sendJson(res, 200, counts);
    }

    if (p === "/api/decisions" && method === "POST") {
      const body = await readJson(req);
      const traceId = String(body.traceId || "");
      const status = String(body.status || "");
      if (!DECISION_STATUSES.has(status)) {
        return sendJson(res, 400, { error: "status must be approved, rejected, or escalated" });
      }
      if (!db.getTrace(traceId)) return sendJson(res, 404, { error: "Unknown trace" });
      const decision = {
        status,
        note: typeof body.note === "string" ? body.note : "",
        reviewer: user.username,
        timestamp: new Date().toISOString(),
      };
      db.upsertDecision({ traceId, ...decision });
      return sendJson(res, 200, { decision });
    }

    if (p.startsWith("/api/decisions/") && method === "DELETE") {
      const traceId = decodeURIComponent(p.slice("/api/decisions/".length));
      db.deleteDecision(traceId);
      return sendJson(res, 200, { ok: true });
    }

    if (p === "/api/audit" && method === "GET") {
      const summary = summarizeTraces(db.listTraces());
      const { scored, ...counts } = summary;
      return sendJson(
        res,
        200,
        {
          generatedAt: new Date().toISOString(),
          generatedBy: user.username,
          summary: counts,
          traces: scored.map((t) => ({ ...t, decision: t.decision ?? null })),
        },
        { "Content-Disposition": 'attachment; filename="ai_agent_governance_audit.json"' },
      );
    }

    return sendJson(res, 404, { error: "Unknown API route" });
  } catch (err) {
    const status = err.status || 500;
    return sendJson(res, status, { error: err.message || "Server error" });
  }
}
