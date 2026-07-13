// Persistence layer backed by SQLite (Node's built-in node:sqlite).
// createDb(path) opens/creates the database, ensures the schema, and returns a
// small typed API. Each caller owns its own connection, which keeps the tests
// isolated (they pass a temp path) and the server simple.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS traces (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  agent TEXT NOT NULL,
  user TEXT,
  input TEXT,
  output TEXT,
  retrieved_sources INTEGER,
  tools TEXT,
  retrieved_content TEXT,
  approval_required INTEGER DEFAULT 0,
  approved INTEGER DEFAULT 0,
  customer_facing INTEGER DEFAULT 0,
  contains_sensitive_data INTEGER DEFAULT 0,
  groundedness REAL,
  latency_ms INTEGER,
  score INTEGER,
  level TEXT,
  action TEXT,
  flags TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS decisions (
  trace_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  note TEXT,
  reviewer TEXT,
  timestamp TEXT NOT NULL,
  FOREIGN KEY (trace_id) REFERENCES traces(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'reviewer',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS api_keys (
  key TEXT PRIMARY KEY,
  label TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_traces_timestamp ON traces(timestamp);
`;

const b = (v) => (v ? 1 : 0); // JS boolean -> SQLite integer
const j = (v) => (v == null ? null : JSON.stringify(v));
const parse = (v, dflt) => {
  if (v == null) return dflt;
  try {
    return JSON.parse(v);
  } catch {
    return dflt;
  }
};

// DB row -> API trace object (shape the frontend and engine expect).
function rowToTrace(row) {
  if (!row) return null;
  const trace = {
    id: row.id,
    timestamp: row.timestamp,
    agent: row.agent,
    user: row.user ?? undefined,
    input: row.input ?? undefined,
    output: row.output ?? undefined,
    retrievedSources: row.retrieved_sources ?? undefined,
    tools: parse(row.tools, []),
    retrievedContent: parse(row.retrieved_content, undefined),
    approvalRequired: !!row.approval_required,
    approved: !!row.approved,
    customerFacing: !!row.customer_facing,
    containsSensitiveData: !!row.contains_sensitive_data,
    groundedness: row.groundedness ?? undefined,
    latencyMs: row.latency_ms ?? undefined,
    createdAt: row.created_at,
  };
  if (row.retrievedContent === undefined && trace.retrievedContent === undefined) {
    delete trace.retrievedContent;
  }
  if (row.d_status) {
    trace.decision = {
      status: row.d_status,
      note: row.d_note ?? "",
      reviewer: row.d_reviewer ?? "",
      timestamp: row.d_timestamp,
    };
  } else {
    trace.decision = null;
  }
  return trace;
}

export function createDb(dbPath) {
  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);

  const stmt = {
    upsertTrace: db.prepare(`
      INSERT INTO traces (id, timestamp, agent, user, input, output, retrieved_sources,
        tools, retrieved_content, approval_required, approved, customer_facing,
        contains_sensitive_data, groundedness, latency_ms, score, level, action, flags, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        timestamp=excluded.timestamp, agent=excluded.agent, user=excluded.user,
        input=excluded.input, output=excluded.output, retrieved_sources=excluded.retrieved_sources,
        tools=excluded.tools, retrieved_content=excluded.retrieved_content,
        approval_required=excluded.approval_required, approved=excluded.approved,
        customer_facing=excluded.customer_facing, contains_sensitive_data=excluded.contains_sensitive_data,
        groundedness=excluded.groundedness, latency_ms=excluded.latency_ms,
        score=excluded.score, level=excluded.level, action=excluded.action, flags=excluded.flags
    `),
    listTraces: db.prepare(`
      SELECT t.*, d.status AS d_status, d.note AS d_note, d.reviewer AS d_reviewer, d.timestamp AS d_timestamp
      FROM traces t LEFT JOIN decisions d ON d.trace_id = t.id
      ORDER BY t.timestamp DESC
    `),
    getTrace: db.prepare(`
      SELECT t.*, d.status AS d_status, d.note AS d_note, d.reviewer AS d_reviewer, d.timestamp AS d_timestamp
      FROM traces t LEFT JOIN decisions d ON d.trace_id = t.id
      WHERE t.id = ?
    `),
    countTraces: db.prepare(`SELECT COUNT(*) AS n FROM traces`),
    upsertDecision: db.prepare(`
      INSERT INTO decisions (trace_id, status, note, reviewer, timestamp)
      VALUES (?,?,?,?,?)
      ON CONFLICT(trace_id) DO UPDATE SET
        status=excluded.status, note=excluded.note, reviewer=excluded.reviewer, timestamp=excluded.timestamp
    `),
    deleteDecision: db.prepare(`DELETE FROM decisions WHERE trace_id = ?`),
    createUser: db.prepare(`INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?,?,?,?,?)`),
    getUserByUsername: db.prepare(`SELECT * FROM users WHERE username = ?`),
    getUserById: db.prepare(`SELECT * FROM users WHERE id = ?`),
    countUsers: db.prepare(`SELECT COUNT(*) AS n FROM users`),
    createSession: db.prepare(`INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)`),
    getSession: db.prepare(`
      SELECT s.token, s.expires_at, u.id AS user_id, u.username, u.role
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ?
    `),
    deleteSession: db.prepare(`DELETE FROM sessions WHERE token = ?`),
    deleteExpiredSessions: db.prepare(`DELETE FROM sessions WHERE expires_at < ?`),
    createApiKey: db.prepare(`INSERT INTO api_keys (key, label, created_at) VALUES (?,?,?)`),
    getApiKey: db.prepare(`SELECT * FROM api_keys WHERE key = ?`),
    countApiKeys: db.prepare(`SELECT COUNT(*) AS n FROM api_keys`),
  };

  return {
    raw: db,
    close: () => db.close(),

    // --- traces ---
    upsertTrace(trace, gov) {
      stmt.upsertTrace.run(
        trace.id,
        trace.timestamp,
        trace.agent,
        trace.user ?? null,
        trace.input ?? null,
        trace.output ?? null,
        trace.retrievedSources ?? null,
        j(trace.tools ?? []),
        j(trace.retrievedContent ?? null),
        b(trace.approvalRequired),
        b(trace.approved),
        b(trace.customerFacing),
        b(trace.containsSensitiveData),
        trace.groundedness ?? null,
        trace.latencyMs ?? null,
        gov?.score ?? null,
        gov?.level ?? null,
        gov?.action ?? null,
        j(gov?.flags ?? null),
        trace.createdAt || new Date().toISOString(),
      );
      return this.getTrace(trace.id);
    },
    listTraces: () => stmt.listTraces.all().map(rowToTrace),
    getTrace: (id) => rowToTrace(stmt.getTrace.get(id)),
    countTraces: () => stmt.countTraces.get().n,

    // --- decisions ---
    upsertDecision: (d) =>
      stmt.upsertDecision.run(d.traceId, d.status, d.note ?? null, d.reviewer ?? null, d.timestamp),
    deleteDecision: (traceId) => stmt.deleteDecision.run(traceId),

    // --- users ---
    createUser: (u) => stmt.createUser.run(u.id, u.username, u.passwordHash, u.role || "reviewer", u.createdAt),
    getUserByUsername: (username) => stmt.getUserByUsername.get(username) || null,
    getUserById: (id) => stmt.getUserById.get(id) || null,
    countUsers: () => stmt.countUsers.get().n,

    // --- sessions ---
    createSession: (s) => stmt.createSession.run(s.token, s.userId, s.createdAt, s.expiresAt),
    getSession: (token) => stmt.getSession.get(token) || null,
    deleteSession: (token) => stmt.deleteSession.run(token),
    deleteExpiredSessions: (nowIso) => stmt.deleteExpiredSessions.run(nowIso),

    // --- api keys ---
    createApiKey: (k) => stmt.createApiKey.run(k.key, k.label ?? null, k.createdAt),
    getApiKey: (key) => stmt.getApiKey.get(key) || null,
    countApiKeys: () => stmt.countApiKeys.get().n,
  };
}
