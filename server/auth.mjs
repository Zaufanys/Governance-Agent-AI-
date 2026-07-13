// Authentication: password hashing (scrypt), session tokens + cookies, and
// API-key verification for the ingestion endpoint. All primitives come from
// node:crypto — no external dependencies.
import crypto from "node:crypto";

const SCRYPT_KEYLEN = 64;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(password, stored) {
  if (typeof stored !== "string") return false;
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  let actual;
  try {
    actual = crypto.scryptSync(String(password), salt, expected.length);
  } catch {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export const newToken = () => crypto.randomBytes(32).toString("hex");
export const newId = () => crypto.randomUUID();
export const newApiKey = () => "agk_" + crypto.randomBytes(24).toString("hex");

// --- cookies ---
export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function sessionCookie(token, maxAgeMs) {
  const attrs = [
    `sid=${token}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  return attrs.join("; ");
}

export const clearSessionCookie = () => "sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0";

// --- request helpers ---

// Returns { userId, username, role } for a valid, unexpired session, else null.
// Expired sessions are cleaned up opportunistically.
export function getSessionUser(db, req) {
  const token = parseCookies(req.headers.cookie).sid;
  if (!token) return null;
  const row = db.getSession(token);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.deleteSession(token);
    return null;
  }
  return { userId: row.user_id, username: row.username, role: row.role };
}

// Pull an API key from Authorization: Bearer <key> or the X-API-Key header.
export function getApiKey(req) {
  const auth = req.headers["authorization"];
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "").trim();
  const header = req.headers["x-api-key"];
  return header ? String(header).trim() : null;
}

export function verifyApiKey(db, req) {
  const key = getApiKey(req);
  if (!key) return false;
  return Boolean(db.getApiKey(key));
}
