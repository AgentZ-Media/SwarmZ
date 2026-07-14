import {
  normalizeGitHubIssues,
  normalizeJiraIssues,
  normalizeLinearIssues,
} from "./adapters";

export type IntakeSource =
  | "text"
  | "markdown"
  | "csv"
  | "json"
  | "github_issues"
  | "jira"
  | "linear";

export interface IntakeTaskDraft {
  externalId: string | null;
  title: string;
  description: string;
  priority: number;
  role: string;
  dependencyRefs: string[];
  acceptanceCriteria: string[];
  labels: string[];
  /** Repo-relative exact files the task is approved to modify. */
  declaredFiles: string[];
  /** Repo-relative glob scopes used by the conflict scheduler. */
  declaredGlobs: string[];
}

export interface TaskImportResult {
  source: IntakeSource;
  tasks: IntakeTaskDraft[];
  warnings: string[];
}

const MAX_TASKS = 500;
const MAX_INPUT_CHARS = 1_000_000;

function clean(value: unknown, max = 500): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function splitList(value: unknown): string[] {
  return clean(value, 2_000)
    .split(/[;,|]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, 50);
}

function priorityOf(value: unknown): number {
  const text = clean(value, 40).toLowerCase();
  if (!text) return 50;
  if (/^p?0$|critical|urgent/.test(text)) return 100;
  if (/^p?1$|high/.test(text)) return 80;
  if (/^p?2$|medium|normal/.test(text)) return 50;
  if (/^p?3$|low/.test(text)) return 20;
  const numeric = Number(text);
  return Number.isFinite(numeric)
    ? Math.max(0, Math.min(100, Math.round(numeric)))
    : 50;
}

function recordList(record: Record<string, unknown>, keys: readonly string[]): string[] {
  const value = keys.map((key) => record[key]).find((candidate) => candidate !== undefined);
  return Array.isArray(value)
    ? value.map((item) => clean(item, 2_000)).filter(Boolean).slice(0, 1_000)
    : splitList(value);
}

function taskFromRecord(record: Record<string, unknown>): IntakeTaskDraft | null {
  const title = clean(record.title ?? record.name ?? record.task, 300);
  if (!title) return null;
  return {
    externalId: clean(record.id ?? record.key, 80) || null,
    title,
    description: clean(record.description ?? record.body, 4_000),
    priority: priorityOf(record.priority),
    role: clean(record.role, 80) || "implementer",
    dependencyRefs: Array.isArray(record.dependencies)
      ? record.dependencies.map((value) => clean(value, 80)).filter(Boolean)
      : splitList(record.dependencies ?? record.depends_on ?? record.depends),
    acceptanceCriteria: Array.isArray(record.acceptanceCriteria)
      ? record.acceptanceCriteria
          .map((value) => clean(value, 500))
          .filter(Boolean)
          .slice(0, 50)
      : splitList(record.acceptance_criteria ?? record.acceptance ?? record.ac),
    labels: Array.isArray(record.labels)
      ? record.labels.map((value) => clean(value, 80)).filter(Boolean).slice(0, 30)
      : splitList(record.labels),
    declaredFiles: recordList(record, ["files", "declaredFiles", "declared_files", "scopeFiles", "scope_files"]),
    declaredGlobs: recordList(record, ["globs", "declaredGlobs", "declared_globs", "scopeGlobs", "scope_globs"]),
  };
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') quoted = false;
      else cell += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") cell += char;
  }
  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

function parseCsv(text: string): TaskImportResult {
  const warnings: string[] = [];
  const rows = parseCsvRows(text);
  if (rows.length < 2) return { source: "csv", tasks: [], warnings: ["CSV contains no task rows."] };
  const headers = rows[0].map((header) => clean(header, 80).toLowerCase());
  const titleIndex = headers.findIndex((header) =>
    ["title", "name", "task"].includes(header),
  );
  if (titleIndex < 0) {
    return { source: "csv", tasks: [], warnings: ["CSV needs a title, name or task column."] };
  }
  const tasks: IntakeTaskDraft[] = [];
  for (const [index, row] of rows.slice(1).entries()) {
    const record: Record<string, unknown> = {};
    headers.forEach((header, column) => {
      if (header) record[header] = row[column] ?? "";
    });
    const task = taskFromRecord(record);
    if (task) tasks.push(task);
    else warnings.push(`Row ${index + 2} was skipped because its title is empty.`);
    if (tasks.length >= MAX_TASKS) break;
  }
  if (rows.length - 1 > MAX_TASKS) warnings.push(`Only the first ${MAX_TASKS} tasks were imported.`);
  return { source: "csv", tasks, warnings };
}

function parseJson(text: string): TaskImportResult | null {
  if (!/^\s*[\[{]/.test(text)) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    const values = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).tasks)
        ? ((parsed as Record<string, unknown>).tasks as unknown[])
        : null;
    if (!values) return null;
    const tasks = values
      .slice(0, MAX_TASKS)
      .map((value) =>
        value && typeof value === "object"
          ? taskFromRecord(value as Record<string, unknown>)
          : taskFromRecord({ title: value }),
      )
      .filter((task): task is IntakeTaskDraft => task !== null);
    return {
      source: "json",
      tasks,
      warnings:
        values.length > MAX_TASKS
          ? [`Only the first ${MAX_TASKS} tasks were imported.`]
          : [],
    };
  } catch {
    return null;
  }
}

function parseExternalJson(text: string): TaskImportResult | null {
  if (!/^\s*[\[{]/.test(text)) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    const values = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).issues)
        ? (parsed as { issues: unknown[] }).issues
        : null;
    if (!values || values.length === 0) return null;
    const first = values.find((value) => value && typeof value === "object") as Record<string, unknown> | undefined;
    if (!first) return null;
    if (Number.isSafeInteger(first.number) && typeof first.title === "string" && typeof first.state === "string") {
      return normalizeGitHubIssues(values as Parameters<typeof normalizeGitHubIssues>[0]);
    }
    if (typeof first.key === "string" && first.fields && typeof first.fields === "object") {
      return normalizeJiraIssues(values as Parameters<typeof normalizeJiraIssues>[0]);
    }
    if ((typeof first.identifier === "string" || typeof first.id === "string") && typeof first.title === "string") {
      return normalizeLinearIssues(values as Parameters<typeof normalizeLinearIssues>[0]);
    }
    return null;
  } catch {
    return null;
  }
}

const TASK_LINE = /^\s*(?:[-*+]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+)(.+?)\s*$/;

function parseText(text: string): TaskImportResult {
  const lines = text.split(/\r?\n/);
  const markdown = lines.some((line) => TASK_LINE.test(line) || /^\s*#{1,6}\s/.test(line));
  const warnings: string[] = [];
  const tasks: IntakeTaskDraft[] = [];
  let current: IntakeTaskDraft | null = null;
  const push = () => {
    if (!current) return;
    if (current.title) tasks.push(current);
    current = null;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || /^#{1,6}\s+/.test(line)) continue;
    const match = raw.match(TASK_LINE);
    const isTask = !!match || (!markdown && line.length > 0);
    if (isTask) {
      push();
      if (tasks.length >= MAX_TASKS) break;
      let title = clean(match?.[1] ?? line, 300);
      const idMatch = title.match(/^\[([^\]]{1,80})\]\s*/);
      const priorityMatch = title.match(/\b(P[0-3])\b/i);
      const roleMatch = title.match(/(?:^|\s)@([a-z][a-z0-9_-]{1,39})\b/i);
      const dependencyMatch = title.match(/\bdepends?\s*:\s*([^;]+)/i);
      title = title
        .replace(/^\[[^\]]{1,80}\]\s*/, "")
        .replace(/\bP[0-3]\b/gi, "")
        .replace(/(?:^|\s)@[a-z][a-z0-9_-]{1,39}\b/gi, " ")
        .replace(/\bdepends?\s*:\s*([^;]+)/i, "")
        .replace(/\s*;\s*$/, "")
        .replace(/\s+/g, " ")
        .trim();
      current = {
        externalId: idMatch?.[1] ?? null,
        title,
        description: "",
        priority: priorityOf(priorityMatch?.[1]),
        role: roleMatch?.[1]?.toLowerCase() ?? "implementer",
        dependencyRefs: dependencyMatch ? splitList(dependencyMatch[1]) : [],
        acceptanceCriteria: [],
        labels: [],
        declaredFiles: [],
        declaredGlobs: [],
      };
      continue;
    }
    if (!current) continue;
    const acceptance = line.match(/^(?:ac|acceptance|done when)\s*:\s*(.+)$/i);
    if (acceptance) current.acceptanceCriteria.push(clean(acceptance[1], 500));
    else if (/^(?:files?|scope files?)\s*:/i.test(line)) {
      current.declaredFiles.push(...splitList(line.replace(/^(?:files?|scope files?)\s*:\s*/i, "")));
    }
    else if (/^(?:globs?|scope globs?)\s*:/i.test(line)) {
      current.declaredGlobs.push(...splitList(line.replace(/^(?:globs?|scope globs?)\s*:\s*/i, "")));
    }
    else current.description = clean(`${current.description} ${line}`, 4_000);
  }
  push();
  if (tasks.length >= MAX_TASKS && lines.length > MAX_TASKS) {
    warnings.push(`Only the first ${MAX_TASKS} tasks were imported.`);
  }
  return { source: markdown ? "markdown" : "text", tasks, warnings };
}

export function importTasks(input: string): TaskImportResult {
  const text = input.slice(0, MAX_INPUT_CHARS);
  const clipped = input.length > MAX_INPUT_CHARS;
  const external = parseExternalJson(text);
  if (external) {
    if (clipped) external.warnings.unshift("Input was clipped to 1 MB.");
    return external;
  }
  const json = parseJson(text);
  if (json) {
    if (clipped) json.warnings.unshift("Input was clipped to 1 MB.");
    return json;
  }
  const first = text.split(/\r?\n/, 1)[0].toLowerCase();
  const csv = first.includes(",") && /(^|,)(title|name|task)(,|$)/.test(first);
  const result = csv ? parseCsv(text) : parseText(text);
  if (clipped) result.warnings.unshift("Input was clipped to 1 MB.");
  return result;
}
