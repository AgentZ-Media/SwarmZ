// Structured agent → Conductor status reports (Phase 5). An `expect_report`
// task rides the codex `outputSchema` param (one-turn-only, live-verified on
// 0.144.1 — it FORCES the turn's final assistant message into this shape), so
// a finished agent hands the Conductor machine-readable status instead of
// free text. Pure module (schema + parser + prompt suffix) plus a tiny
// in-memory expectation registry: the executors mark a session BEFORE the
// schema-constrained send (bound to the turn id after the ack), the
// agent-finished trigger consumes the mark and parses the final message.
// No persistence — a restart mid-turn simply degrades to the free-text path.

/** The parsed report an agent ends an `expect_report` turn with. */
export interface AgentReport {
  done: boolean;
  summary: string;
  filesChanged: string[];
  /** null = no tests were run */
  testsPass: boolean | null;
  needsHuman: boolean;
  question: string | null;
  followups: string[];
}

/**
 * The JSON Schema handed to codex as `outputSchema`. Single source — the
 * Rust spike (`phase5_output_schema_spike`) mirrors it field for field.
 * Every property is required (strict structured output) with nullable types
 * where "not applicable" is a real answer.
 */
export const AGENT_REPORT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    done: { type: "boolean", description: "the task is complete" },
    summary: {
      type: "string",
      description: "what you did and what came out, 1-3 sentences",
    },
    files_changed: {
      type: "array",
      items: { type: "string" },
      description: "paths you created or modified",
    },
    tests_pass: {
      type: ["boolean", "null"],
      description: "test outcome; null when no tests were run",
    },
    needs_human: {
      type: "boolean",
      description:
        "a human decision is required before the task can proceed/finish",
    },
    question: {
      type: ["string", "null"],
      description:
        "the question or decision you need answered, when needs_human is true",
    },
    followups: {
      type: "array",
      items: { type: "string" },
      description: "follow-up tasks you recommend",
    },
  },
  required: [
    "done",
    "summary",
    "files_changed",
    "tests_pass",
    "needs_human",
    "question",
    "followups",
  ],
} as const;

/**
 * Appended to every `expect_report` task/prompt so the agent knows its final
 * message is the report (the schema enforces the shape either way — the
 * sentence keeps the model from burying the answer in commentary).
 */
export const REPORT_PROMPT_SUFFIX =
  "\n\nEnd your work by filling the required status report (your final message is schema-constrained: done, summary, files_changed, tests_pass, needs_human, question, followups).";

// ---- hardening caps (the report is UNTRUSTED agent output that feeds an
// ACTIONABLE autonomous prompt — a hostile/degenerate report must neither
// blow up the Conductor's context (cost bomb across up to 10 retries) nor
// smuggle structural lines into the wire) ----

/** Reject report parsing beyond this input size (free-text path instead). */
export const MAX_REPORT_INPUT_CHARS = 50_000;
/** Per-item cap for files_changed / followups entries. */
export const MAX_REPORT_ITEM_CHARS = 200;
/** Item-count caps (parse-time; render slices further). */
export const MAX_REPORT_FILES = 20;
export const MAX_REPORT_FOLLOWUPS = 8;
/** Hard cap on the rendered wire block. */
export const MAX_REPORT_WIRE_CHARS = 3_000;

/**
 * Flatten one untrusted string field into a single bounded line: control
 * characters (newlines included) collapse to spaces so a report field can
 * never fabricate structural wire lines (fake "[agent finished]" markers).
 */
function inlineField(s: string, max: number): string {
  let out = "";
  let lastSpace = true;
  for (const c of s) {
    const code = c.charCodeAt(0);
    // C0 controls + DEL, the C1 range (0x80–0x9F) and the Unicode line/para
    // separators (U+0085 NEL, U+2028, U+2029) all collapse to a space so a
    // report field can never fabricate a structural wire line
    const ch =
      code < 32 ||
      code === 127 ||
      (code >= 0x80 && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029
        ? " "
        : c;
    if (ch === " ") {
      if (lastSpace) continue;
      lastSpace = true;
    } else {
      lastSpace = false;
    }
    out += ch;
  }
  const t = out.trimEnd();
  return t.length > max ? `${t.slice(0, max).trimEnd()}…` : t;
}

function strArray(v: unknown, maxItems: number): string[] {
  return Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === "string")
        .slice(0, maxItems)
        .map((x) => inlineField(x, MAX_REPORT_ITEM_CHARS))
        .filter(Boolean)
    : [];
}

/**
 * Parse an agent's final message as a status report. Tolerant: code fences
 * are stripped, extra fields ignored; anything that doesn't parse into the
 * three required core fields (done/summary/needs_human) returns null and the
 * caller falls back to the free-text path. Hardened: oversized input is
 * rejected outright, every string field is single-line-normalized and capped
 * at parse time (see the caps above).
 */
export function parseAgentReport(text: string | null | undefined): AgentReport | null {
  if (!text) return null;
  if (text.length > MAX_REPORT_INPUT_CHARS) return null; // cost bomb — free-text path
  let body = text.trim();
  // strip a ```json … ``` (or plain ```) fence if the model added one
  const fence = body.match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```$/);
  if (fence) body = fence[1].trim();
  if (!body.startsWith("{")) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.done !== "boolean") return null;
  if (typeof r.summary !== "string") return null;
  if (typeof r.needs_human !== "boolean") return null;
  const question =
    typeof r.question === "string" && r.question.trim()
      ? inlineField(r.question, 400)
      : null;
  return {
    done: r.done,
    summary: inlineField(r.summary, 600),
    filesChanged: strArray(r.files_changed, MAX_REPORT_FILES),
    testsPass: typeof r.tests_pass === "boolean" ? r.tests_pass : null,
    needsHuman: r.needs_human,
    question: question || null,
    followups: strArray(r.followups, MAX_REPORT_FOLLOWUPS),
  };
}

/** Render a report as compact wire lines for the Conductor (English, small).
 * Fields are already single-line + capped from parsing; the final block is
 * capped once more as a belt-and-braces bound. */
export function renderReportLines(report: AgentReport): string {
  const lines: string[] = [];
  const tests =
    report.testsPass === null ? "not run" : report.testsPass ? "pass" : "FAIL";
  lines.push(
    `Report: done=${report.done} · tests=${tests} · needs_human=${report.needsHuman}`,
  );
  if (report.summary.trim())
    lines.push(`Summary: ${inlineField(report.summary, 600)}`);
  if (report.filesChanged.length)
    lines.push(
      `Files changed: ${report.filesChanged
        .slice(0, MAX_REPORT_FILES)
        .map((f) => inlineField(f, MAX_REPORT_ITEM_CHARS))
        .join(", ")}${report.filesChanged.length > MAX_REPORT_FILES ? ", …" : ""}`,
    );
  if (report.question)
    lines.push(`Question: ${inlineField(report.question, 400)}`);
  if (report.followups.length)
    lines.push(
      `Suggested follow-ups: ${report.followups
        .slice(0, MAX_REPORT_FOLLOWUPS)
        .map((f) => inlineField(f, MAX_REPORT_ITEM_CHARS))
        .join(" · ")}`,
    );
  const out = lines.join("\n");
  return out.length > MAX_REPORT_WIRE_CHARS
    ? `${out.slice(0, MAX_REPORT_WIRE_CHARS).trimEnd()}…`
    : out;
}

// ---- expectation registry (in-memory, per app run) ----
//
// Registered BEFORE the schema-constrained send goes out (a very fast
// completion event must never beat the registration — that would lose the
// structured parsing), cleared again when the send fails or degrades to a
// steer, and BOUND to the returned turn id after the turn/start ack: the
// consumption then only matches THAT turn's finish, so a stale completion
// racing the registration can't eat the mark meant for the fresh turn.

interface ReportExpectation {
  token: string;
  turnId: string | null;
}

const expecting = new Map<string, ReportExpectation[]>();
let expectationSequence = 0;

/** Mark a session BEFORE the schema-constrained send: its next finished turn
 * carries a schema-forced report. */
export function noteReportExpected(sessionId: string): string {
  const token = `report-${++expectationSequence}`;
  const entries = expecting.get(sessionId) ?? [];
  expecting.set(sessionId, [...entries, { token, turnId: null }]);
  return token;
}

/** Bind the expectation to the acked turn id (post-send). No-op when the
 * expectation is gone (consumed by a racing finish / cleared). */
export function bindReportExpectation(
  sessionId: string,
  token: string,
  turnId: string | null,
): void {
  if (!turnId) return;
  const entry = expecting.get(sessionId)?.find((value) => value.token === token);
  if (entry) entry.turnId = turnId;
}

/**
 * Consume the expectation mark for one finished turn. `turnId` is the id of
 * the turn that just completed (null = unknown): a bound expectation only
 * matches ITS turn — a definite mismatch leaves the mark in place (it
 * belongs to a turn still to finish) and returns false.
 */
export function takeReportExpectation(
  sessionId: string,
  turnId: string | null = null,
): boolean {
  const entries = expecting.get(sessionId);
  if (!entries?.length) return false;
  const index = turnId === null
    ? 0
    : entries.findIndex((entry) => entry.turnId === turnId);
  // A bound completion can never consume an unbound/newer expectation.
  if (index < 0) return false;
  entries.splice(index, 1);
  if (entries.length === 0) expecting.delete(sessionId);
  return true;
}

/** Drop a session's expectation (session closed / send failed / steered). */
export function clearReportExpectation(sessionId: string, token?: string): void {
  if (!token) {
    expecting.delete(sessionId);
    return;
  }
  const entries = expecting.get(sessionId);
  if (!entries) return;
  const retained = entries.filter((entry) => entry.token !== token);
  if (retained.length > 0) expecting.set(sessionId, retained);
  else expecting.delete(sessionId);
}

/** Test seam. */
export function resetReportExpectations(): void {
  expecting.clear();
  expectationSequence = 0;
}
