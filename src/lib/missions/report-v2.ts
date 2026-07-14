export const MISSION_REPORT_V2_MAX_INPUT = 100_000;
const SHA = /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/;
const SHA256 = /^[a-fA-F0-9]{64}$/;

export type MissionReportStatus =
  | "succeeded"
  | "failed"
  | "blocked"
  | "needs_human"
  | "cancelled";

export interface MissionReportCommand {
  command: string;
  exitCode: number;
  durationMs: number | null;
}

export interface MissionReportArtifact {
  kind: string;
  label: string;
  uri: string | null;
  sha256: string | null;
}

export interface MissionReportV2 {
  version: 2;
  missionId: string;
  taskId: string;
  attemptId: string;
  status: MissionReportStatus;
  summary: string;
  evidence: {
    baseSha: string | null;
    headSha: string;
    diffSha256: string | null;
  };
  filesChanged: string[];
  commands: MissionReportCommand[];
  artifacts: MissionReportArtifact[];
  question: string | null;
}

export const MISSION_REPORT_V2_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    version: { type: "integer", const: 2 },
    mission_id: { type: "string" },
    task_id: { type: "string" },
    attempt_id: { type: "string" },
    status: {
      type: "string",
      enum: ["succeeded", "failed", "blocked", "needs_human", "cancelled"],
    },
    summary: { type: "string" },
    evidence: {
      type: "object",
      additionalProperties: false,
      properties: {
        base_sha: { type: ["string", "null"] },
        head_sha: { type: "string" },
        diff_sha256: { type: ["string", "null"] },
      },
      required: ["base_sha", "head_sha", "diff_sha256"],
    },
    files_changed: { type: "array", items: { type: "string" } },
    commands: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          command: { type: "string" },
          exit_code: { type: "integer" },
          duration_ms: { type: ["integer", "null"] },
        },
        required: ["command", "exit_code", "duration_ms"],
      },
    },
    artifacts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string" },
          label: { type: "string" },
          uri: { type: ["string", "null"] },
          sha256: { type: ["string", "null"] },
        },
        required: ["kind", "label", "uri", "sha256"],
      },
    },
    question: { type: ["string", "null"] },
  },
  required: [
    "version",
    "mission_id",
    "task_id",
    "attempt_id",
    "status",
    "summary",
    "evidence",
    "files_changed",
    "commands",
    "artifacts",
    "question",
  ],
} as const;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedLine(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const flattened = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  if (!flattened || flattened.length > max) return null;
  return flattened;
}

function nullableLine(value: unknown, max: number): string | null | undefined {
  if (value === null) return null;
  return boundedLine(value, max) ?? undefined;
}

function parseJson(text: string): unknown {
  let body = text.trim();
  const fence = body.match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```$/);
  if (fence) body = fence[1].trim();
  return JSON.parse(body);
}

/** Tolerant framing, strict identities/evidence and hard size/count bounds. */
export function parseMissionReportV2(text: string | null | undefined): MissionReportV2 | null {
  if (!text || text.length > MISSION_REPORT_V2_MAX_INPUT) return null;
  let raw: unknown;
  try {
    raw = parseJson(text);
  } catch {
    return null;
  }
  const value = object(raw);
  const evidence = object(value?.evidence);
  if (!value || !evidence || value.version !== 2) return null;
  const missionId = boundedLine(value.mission_id, 128);
  const taskId = boundedLine(value.task_id, 128);
  const attemptId = boundedLine(value.attempt_id, 128);
  const summary = boundedLine(value.summary, 2_000);
  const status = value.status;
  if (!missionId || !taskId || !attemptId || !summary ||
    !["succeeded", "failed", "blocked", "needs_human", "cancelled"].includes(String(status))) {
    return null;
  }
  const headSha = boundedLine(evidence.head_sha, 64);
  const baseSha = nullableLine(evidence.base_sha, 64);
  const diffSha256 = nullableLine(evidence.diff_sha256, 64);
  if (!headSha || !SHA.test(headSha) || baseSha === undefined ||
    (baseSha !== null && !SHA.test(baseSha)) || diffSha256 === undefined ||
    (diffSha256 !== null && !SHA256.test(diffSha256))) {
    return null;
  }
  if (!Array.isArray(value.files_changed) || value.files_changed.length > 200 ||
    !Array.isArray(value.commands) || value.commands.length > 50 ||
    !Array.isArray(value.artifacts) || value.artifacts.length > 50) {
    return null;
  }
  const filesChanged: string[] = [];
  for (const file of value.files_changed) {
    const parsed = boundedLine(file, 2_000);
    if (!parsed) return null;
    filesChanged.push(parsed);
  }
  const commands: MissionReportCommand[] = [];
  for (const item of value.commands) {
    const command = object(item);
    const textCommand = boundedLine(command?.command, 2_000);
    if (!command || !textCommand || !Number.isInteger(command.exit_code) ||
      (command.duration_ms !== null &&
        (!Number.isInteger(command.duration_ms) || Number(command.duration_ms) < 0))) {
      return null;
    }
    commands.push({
      command: textCommand,
      exitCode: Number(command.exit_code),
      durationMs: command.duration_ms === null ? null : Number(command.duration_ms),
    });
  }
  const artifacts: MissionReportArtifact[] = [];
  for (const item of value.artifacts) {
    const artifact = object(item);
    const kind = boundedLine(artifact?.kind, 80);
    const label = boundedLine(artifact?.label, 300);
    const uri = nullableLine(artifact?.uri, 4_000);
    const sha256 = nullableLine(artifact?.sha256, 64);
    if (!artifact || !kind || !label || uri === undefined || sha256 === undefined ||
      (sha256 !== null && !SHA256.test(sha256))) return null;
    artifacts.push({ kind, label, uri, sha256 });
  }
  const question = nullableLine(value.question, 1_000);
  if (question === undefined || (status === "needs_human" && !question)) return null;
  return {
    version: 2,
    missionId,
    taskId,
    attemptId,
    status: status as MissionReportStatus,
    summary,
    evidence: { baseSha, headSha, diffSha256 },
    filesChanged,
    commands,
    artifacts,
    question,
  };
}

export interface MissionReportBinding {
  missionId: string;
  taskId: string;
  attemptId: string;
}

export interface MissionReportObservation {
  headSha: string;
  baseSha?: string | null;
  diffSha256?: string | null;
  filesChanged?: readonly string[];
  /** Independently observed process outcomes, never agent assertions. */
  commands: Readonly<Record<string, number>>;
  requiredCommands?: readonly string[];
  artifactSha256?: ReadonlySet<string>;
}

export interface MissionReportAssessment {
  bound: boolean;
  verifiedSuccess: boolean;
  issues: string[];
}

/**
 * A report is evidence to verify, never authority. `status=succeeded` (and any
 * ignored legacy `tests_pass` field) cannot settle a task without independent
 * SHA and command observations.
 */
export function assessMissionReportV2(
  report: MissionReportV2,
  binding: MissionReportBinding,
  observation: MissionReportObservation | null,
): MissionReportAssessment {
  const issues: string[] = [];
  const bound =
    report.missionId === binding.missionId &&
    report.taskId === binding.taskId &&
    report.attemptId === binding.attemptId;
  if (!bound) issues.push("report identity does not match the active attempt");
  if (report.status !== "succeeded") {
    return { bound, verifiedSuccess: false, issues };
  }
  if (!observation) {
    issues.push("independent runtime evidence is missing");
    return { bound, verifiedSuccess: false, issues };
  }
  if (!SHA.test(observation.headSha) || observation.headSha.toLowerCase() !== report.evidence.headSha.toLowerCase()) {
    issues.push("observed HEAD does not match the report");
  }
  if (report.evidence.baseSha !== null &&
    (!observation.baseSha || observation.baseSha.toLowerCase() !== report.evidence.baseSha.toLowerCase())) {
    issues.push("observed base SHA does not match the report");
  }
  if (report.filesChanged.length > 0) {
    if (!report.evidence.diffSha256 ||
      !observation.diffSha256 ||
      observation.diffSha256.toLowerCase() !== report.evidence.diffSha256.toLowerCase()) {
      issues.push("changed files require matching observed diff evidence");
    }
  }
  if (observation.filesChanged) {
    const reported = [...new Set(report.filesChanged)].sort();
    const observed = [...new Set(observation.filesChanged)].sort();
    if (reported.length !== observed.length ||
      reported.some((file, index) => file !== observed[index])) {
      issues.push("reported changed files do not match independent Git evidence");
    }
  }
  for (const command of report.commands) {
    const observed = observation.commands[command.command];
    if (observed === undefined || observed !== command.exitCode) {
      issues.push(`command result is not independently corroborated: ${command.command}`);
    }
  }
  for (const required of observation.requiredCommands ?? []) {
    if (observation.commands[required] !== 0) {
      issues.push(`required command did not pass independently: ${required}`);
    }
  }
  for (const artifact of report.artifacts) {
    if (artifact.sha256 && !observation.artifactSha256?.has(artifact.sha256.toLowerCase())) {
      issues.push(`artifact hash is not independently observed: ${artifact.label}`);
    }
  }
  return { bound, verifiedSuccess: bound && issues.length === 0, issues };
}
