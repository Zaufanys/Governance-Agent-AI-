// Validation + normalization for ingested traces, plus governance scoring.
// This is the gate every trace passes through before it reaches the database,
// so the ingestion endpoint can accept data from real agents safely.
import { scoreTrace } from "../public/js/governanceEngine.js";
import { newId } from "./auth.mjs";

const isString = (v) => typeof v === "string";
const truthy = (v) => v === true || v === 1 || v === "true" || v === "1";

function normalizeTool(t) {
  if (isString(t)) return { name: t, type: "read" };
  if (t && typeof t === "object") {
    const type = t.type === "write" ? "write" : "read";
    return { name: isString(t.name) ? t.name : "tool", type };
  }
  return null;
}

// Returns { ok, errors, trace }. `trace` is a clean object ready for storage.
export function normalizeTrace(input) {
  const errors = [];
  const src = input && typeof input === "object" ? input : {};

  if (!isString(src.agent) || !src.agent.trim()) errors.push("`agent` is required");

  let timestamp = src.timestamp;
  if (timestamp == null) {
    timestamp = new Date().toISOString();
  } else if (isNaN(new Date(timestamp).getTime())) {
    errors.push("`timestamp` must be an ISO date string");
  }

  let tools = [];
  if (src.tools != null) {
    if (!Array.isArray(src.tools)) errors.push("`tools` must be an array");
    else tools = src.tools.map(normalizeTool).filter(Boolean);
  }

  let retrievedContent;
  if (src.retrievedContent != null) {
    if (!Array.isArray(src.retrievedContent)) errors.push("`retrievedContent` must be an array");
    else retrievedContent = src.retrievedContent;
  }

  let groundedness;
  if (src.groundedness != null) {
    const g = Number(src.groundedness);
    if (Number.isNaN(g) || g < 0 || g > 1) errors.push("`groundedness` must be a number in 0..1");
    else groundedness = g;
  }

  let latencyMs;
  if (src.latencyMs != null) {
    const l = Number(src.latencyMs);
    if (Number.isNaN(l) || l < 0) errors.push("`latencyMs` must be a non-negative number");
    else latencyMs = l;
  }

  let retrievedSources;
  if (src.retrievedSources != null) {
    const n = Number(src.retrievedSources);
    if (Number.isNaN(n) || n < 0) errors.push("`retrievedSources` must be a non-negative number");
    else retrievedSources = Math.floor(n);
  }

  if (errors.length) return { ok: false, errors, trace: null };

  const trace = {
    id: isString(src.id) && src.id.trim() ? src.id.trim() : `trace_${newId()}`,
    timestamp,
    agent: src.agent.trim(),
    user: isString(src.user) ? src.user : undefined,
    input: isString(src.input) ? src.input : "",
    output: isString(src.output) ? src.output : undefined,
    retrievedSources,
    tools,
    retrievedContent,
    approvalRequired: truthy(src.approvalRequired),
    approved: truthy(src.approved),
    customerFacing: truthy(src.customerFacing),
    containsSensitiveData: truthy(src.containsSensitiveData),
    groundedness,
    latencyMs,
    createdAt: new Date().toISOString(),
  };
  return { ok: true, errors: [], trace };
}

// Normalize + score + persist a single trace. Throws on validation error with
// a `.status` of 400 and a `.details` array the caller can surface.
export function ingestTrace(db, input) {
  const { ok, errors, trace } = normalizeTrace(input);
  if (!ok) {
    const err = new Error("Invalid trace");
    err.status = 400;
    err.details = errors;
    throw err;
  }
  const governance = scoreTrace(trace);
  db.upsertTrace(trace, governance);
  return { id: trace.id, governance };
}
