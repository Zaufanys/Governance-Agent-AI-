// AI-agent governance engine.
//
// Deterministic, dependency-free policy engine that scores agent traces for
// governance risk. The SAME module runs in two places:
//   - the browser dashboard (imported by app.js)
//   - the Node test suite (imported by test/governanceEngine.test.js)
// Keeping a single source of truth guarantees the UI and the tests evaluate
// identical logic.

// --- Detection primitives ----------------------------------------------------

// Adversarial instructions that try to override the system prompt, policy, or
// human approval. Used for *direct* injection (found in the user input).
const DIRECT_INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /disregard\s+(all\s+)?(previous|prior|above)\s+(instructions|rules)/i,
  /reveal\s+(the\s+)?(system|hidden|developer)\s+prompt/i,
  /(bypass|override|disable)\s+(the\s+)?(approval|policy|guardrail|safety|filter)/i,
  /without\s+approval/i,
  /you\s+are\s+now\s+(a\s+)?(dan|jailbroken|unrestricted)/i,
  /act\s+as\s+if\s+you\s+have\s+no\s+restrictions/i,
];

// *Indirect* injection is the "poisoned document" class of attack: the same
// adversarial patterns appearing in content the agent RETRIEVED (a document,
// web page, or tool output) rather than in the user's own prompt.
const INDIRECT_INJECTION_PATTERNS = [
  ...DIRECT_INJECTION_PATTERNS,
  /^\s*system\s*:/im,
  /new\s+instructions\s*:/i,
  /assistant\s*,?\s*please\s+(ignore|send|export|delete)/i,
];

// Signals that a request or output touches confidential / personal data.
const SENSITIVE_PATTERNS = [
  /confidential/i,
  /\bpassword\b/i,
  /\bssn\b/i,
  /social\s+security/i,
  /\bpii\b/i,
  /\bsalar(?:y|ies)\b/i,
  /credit\s+card/i,
  /\bapi[_\s-]?key\b/i,
  /\bsecret\b/i,
  /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i, // bare email address
];

export function detectPromptInjection(text) {
  return DIRECT_INJECTION_PATTERNS.some((re) => re.test(String(text || "")));
}

// Pull every string chunk out of a trace's retrieved context, tolerating both
// `retrievedContent: ["...", ...]` and `retrievedContent: [{text: "..."}]`.
function collectRetrievedText(trace) {
  const content = trace && trace.retrievedContent;
  const out = [];
  if (Array.isArray(content)) {
    for (const c of content) {
      if (typeof c === "string") out.push(c);
      else if (c && typeof c.text === "string") out.push(c.text);
    }
  } else if (typeof content === "string") {
    out.push(content);
  }
  return out;
}

export function detectIndirectInjection(trace) {
  return collectRetrievedText(trace).some((chunk) =>
    INDIRECT_INJECTION_PATTERNS.some((re) => re.test(chunk)),
  );
}

export function detectSensitiveData(trace) {
  if (trace && trace.containsSensitiveData) return true;
  return SENSITIVE_PATTERNS.some((re) => re.test(String((trace && trace.input) || "")));
}

export function hasWriteTool(trace) {
  return ((trace && trace.tools) || []).some((t) => t.type === "write");
}

export function toolCount(trace) {
  return ((trace && trace.tools) || []).length;
}

// --- Policy rules ------------------------------------------------------------
//
// Each rule is a self-contained, testable unit. Adding a governance rule is a
// matter of appending one entry here — score, UI flags, filters, and tests all
// derive from this table. `weight` feeds the risk score; `severity` drives the
// colour treatment in the dashboard.
export const RULES = [
  {
    id: "prompt_injection",
    label: "Direct prompt injection",
    category: "Security",
    weight: 35,
    severity: "high",
    description:
      "User input contains instructions that try to override system rules, policy, or approvals.",
    test: (t) => detectPromptInjection(t.input),
  },
  {
    id: "indirect_injection",
    label: "Indirect (retrieved-content) injection",
    category: "Security",
    weight: 30,
    severity: "high",
    description:
      "Retrieved documents or tool output contain adversarial instructions (poisoned context).",
    test: (t) => detectIndirectInjection(t),
  },
  {
    id: "write_without_approval",
    label: "Write tool without approval",
    category: "Control",
    weight: 30,
    severity: "high",
    description:
      "The agent used or requested a state-changing (write) tool without human approval.",
    test: (t) => hasWriteTool(t) && !t.approved,
  },
  {
    id: "sensitive_data",
    label: "Sensitive data involved",
    category: "Data",
    weight: 25,
    severity: "medium",
    description:
      "The request or output touches confidential, personal, or otherwise sensitive data.",
    test: (t) => detectSensitiveData(t),
  },
  {
    id: "customer_facing_no_review",
    label: "Customer-facing output without review",
    category: "Control",
    weight: 20,
    severity: "medium",
    description:
      "Output is intended for a customer but was not reviewed or approved by a human.",
    test: (t) => Boolean(t.customerFacing) && !t.approved,
  },
  {
    id: "low_groundedness",
    label: "Low groundedness",
    category: "Quality",
    weight: 15,
    severity: "medium",
    description:
      "The answer is weakly supported by the retrieved evidence (hallucination risk).",
    test: (t) => (t.groundedness ?? 1) < 0.75,
  },
  {
    id: "excessive_tools",
    label: "Excessive tool calls",
    category: "Quality",
    weight: 10,
    severity: "low",
    description:
      "The agent invoked an unusually high number of tools in a single run.",
    test: (t) => toolCount(t) > 5,
  },
  {
    id: "high_latency",
    label: "High latency",
    category: "Quality",
    weight: 5,
    severity: "low",
    description: "The run took long enough to affect UX or hint at a loop.",
    test: (t) => (t.latencyMs ?? 0) > 2000,
  },
];

// Risk-score thresholds. Kept as named constants so the UI, docs, and tests
// all refer to the same numbers.
export const THRESHOLDS = { high: 55, medium: 25 };

// --- Scoring -----------------------------------------------------------------

export function scoreTrace(trace) {
  const t = trace || {};
  const flags = [];
  let score = 0;

  for (const rule of RULES) {
    let hit = false;
    try {
      hit = Boolean(rule.test(t));
    } catch {
      hit = false; // a malformed trace must never crash the engine
    }
    if (hit) {
      score += rule.weight;
      flags.push({
        id: rule.id,
        label: rule.label,
        category: rule.category,
        severity: rule.severity,
        weight: rule.weight,
      });
    }
  }

  score = Math.min(100, score);
  const level =
    score >= THRESHOLDS.high ? "High" : score >= THRESHOLDS.medium ? "Medium" : "Low";
  const action = level === "High" ? "Escalate" : level === "Medium" ? "Review" : "Monitor";

  // `categories` is a quick id -> boolean map used by dashboard filters.
  const categories = {};
  for (const rule of RULES) categories[rule.id] = flags.some((f) => f.id === rule.id);

  return {
    score,
    level,
    action,
    reasons: flags.map((f) => f.label), // kept for backward compatibility
    flags,
    categories,
    approvalMissing: Boolean(t.approvalRequired) && !t.approved,
  };
}

// --- Aggregation -------------------------------------------------------------

export function summarizeTraces(traces) {
  const list = Array.isArray(traces) ? traces : [];
  const scored = list.map((t) => ({ ...t, governance: scoreTrace(t) }));
  const count = (pred) => scored.filter(pred).length;
  const byLevel = (lvl) => count((t) => t.governance.level === lvl);
  const byCategory = (id) => count((t) => t.governance.categories[id]);

  return {
    total: scored.length,
    high: byLevel("High"),
    medium: byLevel("Medium"),
    low: byLevel("Low"),
    approvalsRequired: count((t) => t.approvalRequired),
    approvalsMissing: count((t) => t.governance.approvalMissing),
    writeTools: count(hasWriteTool),
    promptInjection: byCategory("prompt_injection") + byCategory("indirect_injection"),
    sensitiveData: byCategory("sensitive_data"),
    lowGroundedness: byCategory("low_groundedness"),
    avgGroundedness:
      scored.reduce((s, t) => s + (t.groundedness || 0), 0) / (scored.length || 1),
    scored,
  };
}

// Filter predicates shared by the dashboard's quick-filter chips. Exported so
// the UI and any future automated report use identical definitions.
export const FILTERS = {
  high_risk: { label: "High risk", test: (t) => t.governance.level === "High" },
  write_tools: { label: "Write tools", test: (t) => hasWriteTool(t) },
  approval_missing: { label: "Approval missing", test: (t) => t.governance.approvalMissing },
  sensitive_data: { label: "Sensitive data", test: (t) => t.governance.categories.sensitive_data },
  prompt_injection: {
    label: "Prompt injection",
    test: (t) =>
      t.governance.categories.prompt_injection || t.governance.categories.indirect_injection,
  },
  low_groundedness: {
    label: "Low groundedness",
    test: (t) => t.governance.categories.low_groundedness,
  },
};
