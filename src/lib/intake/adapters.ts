import type { IntakeTaskDraft } from "./task-import";

export const MAX_ADAPTER_RECORDS = 500;

export type ExternalIntakeSource = "github_issues" | "jira" | "linear";

export interface AdapterResult {
  source: ExternalIntakeSource;
  tasks: IntakeTaskDraft[];
  warnings: string[];
}

export interface GitHubIssueRecord {
  number: number;
  title: string;
  body?: string | null;
  state: "OPEN" | "CLOSED" | "open" | "closed";
  labels?: Array<string | { name?: string | null }>;
  blockedBy?: number[];
}

export interface JiraIssueRecord {
  key: string;
  fields: {
    summary: string;
    description?: unknown;
    priority?: { name?: string | null } | string | null;
    labels?: string[];
    status?: { statusCategory?: { key?: string | null }; name?: string | null };
    issueType?: { name?: string | null };
    blockedBy?: string[];
  };
}

export interface LinearIssueRecord {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  priority?: number | null;
  state?: { type?: string | null; name?: string | null };
  labels?: Array<string | { name?: string | null }>;
  blockedBy?: string[];
}

export interface AdapterOptions {
  includeClosed?: boolean;
}

function clean(value: unknown, max: number): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function labelsOf(values: Array<string | { name?: string | null }> | undefined): string[] {
  if (!Array.isArray(values)) return [];
  const labels = values
    .map((value) => clean(typeof value === "string" ? value : value.name, 80))
    .filter(Boolean)
    .slice(0, 30);
  return [...new Set(labels)];
}

function dependencyRefs(values: readonly unknown[] | undefined): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => clean(value, 80)).filter(Boolean))].slice(0, 50);
}

function commonPriority(value: unknown): number {
  const normalized = clean(
    value && typeof value === "object" ? (value as { name?: unknown }).name : value,
    40,
  ).toLowerCase();
  if (/highest|critical|blocker|urgent|p0/.test(normalized)) return 100;
  if (/high|major|p1/.test(normalized)) return 80;
  if (/low|minor|trivial|p3|p4/.test(normalized)) return 20;
  return 50;
}

function linearPriority(value: number | null | undefined): number {
  // Linear: 0=no priority, 1=urgent, 2=high, 3=normal, 4=low.
  if (value === 1) return 100;
  if (value === 2) return 80;
  if (value === 4) return 20;
  return 50;
}

function flattenDocument(value: unknown): string {
  if (typeof value === "string") return clean(value, 4_000);
  let visited = 0;
  const pieces: string[] = [];
  const walk = (node: unknown, depth: number) => {
    if (visited >= 1_000 || depth > 20 || !node || typeof node !== "object") return;
    visited += 1;
    const record = node as Record<string, unknown>;
    if (typeof record.text === "string") pieces.push(record.text);
    if (Array.isArray(record.content)) {
      for (const child of record.content) walk(child, depth + 1);
    }
  };
  walk(value, 0);
  return clean(pieces.join(" "), 4_000);
}

function dedupe(tasks: IntakeTaskDraft[], warnings: string[]): IntakeTaskDraft[] {
  const ids = new Set<string>();
  return tasks.filter((task) => {
    if (!task.externalId) return true;
    if (ids.has(task.externalId)) {
      warnings.push(`Duplicate external id ${task.externalId} was skipped.`);
      return false;
    }
    ids.add(task.externalId);
    return true;
  });
}

function cap<T>(records: readonly T[], warnings: string[]): readonly T[] {
  if (records.length > MAX_ADAPTER_RECORDS) warnings.push(`Only the first ${MAX_ADAPTER_RECORDS} records were normalized.`);
  return records.slice(0, MAX_ADAPTER_RECORDS);
}

/** Pure normalization of already-fetched GitHub issue records. */
export function normalizeGitHubIssues(
  records: readonly GitHubIssueRecord[],
  options: AdapterOptions = {},
): AdapterResult {
  const warnings: string[] = [];
  const tasks: IntakeTaskDraft[] = [];
  for (const issue of cap(records, warnings)) {
    if (!issue || typeof issue !== "object") {
      warnings.push("An invalid GitHub issue record was skipped.");
      continue;
    }
    if (!Number.isSafeInteger(issue.number) || issue.number < 1) {
      warnings.push("A GitHub issue with an invalid number was skipped.");
      continue;
    }
    if (!options.includeClosed && clean(issue.state, 20).toLowerCase() === "closed") continue;
    const title = clean(issue.title, 300);
    if (!title) {
      warnings.push(`GitHub issue #${issue.number} has no title and was skipped.`);
      continue;
    }
    const labels = labelsOf(issue.labels);
    tasks.push({
      externalId: `GH-${issue.number}`,
      title,
      description: clean(issue.body, 4_000),
      priority: labels.some((label) => /critical|urgent|p0/i.test(label))
        ? 100
        : labels.some((label) => /high|p1/i.test(label))
          ? 80
          : 50,
      role: labels.some((label) => /security/i.test(label)) ? "security" : "implementer",
      dependencyRefs: dependencyRefs(
        Array.isArray(issue.blockedBy)
          ? issue.blockedBy
              .filter((number) => Number.isSafeInteger(number) && number > 0)
              .map((number) => `GH-${number}`)
          : [],
      ),
      acceptanceCriteria: [],
      labels,
      declaredFiles: [],
      declaredGlobs: [],
    });
  }
  return { source: "github_issues", tasks: dedupe(tasks, warnings), warnings };
}

/** Pure normalization of Jira REST/export issue objects, including bounded ADF text. */
export function normalizeJiraIssues(
  records: readonly JiraIssueRecord[],
  options: AdapterOptions = {},
): AdapterResult {
  const warnings: string[] = [];
  const tasks: IntakeTaskDraft[] = [];
  for (const issue of cap(records, warnings)) {
    if (!issue || typeof issue !== "object" || !issue.fields || typeof issue.fields !== "object") {
      warnings.push("An invalid Jira issue record was skipped.");
      continue;
    }
    const key = clean(issue.key, 80);
    const closed = clean(issue.fields.status?.statusCategory?.key, 40).toLowerCase() === "done";
    if (!options.includeClosed && closed) continue;
    const title = clean(issue.fields.summary, 300);
    if (!key || !title) {
      warnings.push("A Jira issue without key or summary was skipped.");
      continue;
    }
    const labels = [
      ...new Set(
        (Array.isArray(issue.fields.labels) ? issue.fields.labels : [])
          .map((label) => clean(label, 80))
          .filter(Boolean),
      ),
    ].slice(0, 30);
    const issueType = clean(issue.fields.issueType?.name, 80);
    if (issueType) labels.push(issueType);
    tasks.push({
      externalId: key,
      title,
      description: flattenDocument(issue.fields.description),
      priority: commonPriority(issue.fields.priority),
      role: labels.some((label) => /security/i.test(label)) ? "security" : "implementer",
      dependencyRefs: dependencyRefs(issue.fields.blockedBy),
      acceptanceCriteria: [],
      labels: [...new Set(labels)].slice(0, 30),
      declaredFiles: [],
      declaredGlobs: [],
    });
  }
  return { source: "jira", tasks: dedupe(tasks, warnings), warnings };
}

/** Pure normalization of Linear export/API records; no SDK, token or network path. */
export function normalizeLinearIssues(
  records: readonly LinearIssueRecord[],
  options: AdapterOptions = {},
): AdapterResult {
  const warnings: string[] = [];
  const tasks: IntakeTaskDraft[] = [];
  for (const issue of cap(records, warnings)) {
    if (!issue || typeof issue !== "object") {
      warnings.push("An invalid Linear issue record was skipped.");
      continue;
    }
    const identifier = clean(issue.identifier || issue.id, 80);
    const stateType = clean(issue.state?.type, 40).toLowerCase();
    if (!options.includeClosed && ["completed", "canceled", "cancelled"].includes(stateType)) continue;
    const title = clean(issue.title, 300);
    if (!identifier || !title) {
      warnings.push("A Linear issue without identifier or title was skipped.");
      continue;
    }
    const labels = labelsOf(issue.labels);
    tasks.push({
      externalId: identifier,
      title,
      description: clean(issue.description, 4_000),
      priority: linearPriority(issue.priority),
      role: labels.some((label) => /security/i.test(label)) ? "security" : "implementer",
      dependencyRefs: dependencyRefs(issue.blockedBy),
      acceptanceCriteria: [],
      labels,
      declaredFiles: [],
      declaredGlobs: [],
    });
  }
  return { source: "linear", tasks: dedupe(tasks, warnings), warnings };
}
