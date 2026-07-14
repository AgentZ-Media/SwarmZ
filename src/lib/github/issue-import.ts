import { normalizeGitHubIssues } from "@/lib/intake/adapters";
import type { IntakeTaskDraft } from "@/lib/intake/task-import";
import type { GhIssue } from "./types";

/** Mission-ready task shape exposed by the GitHub issue picker. */
export type ImportedTask = IntakeTaskDraft;

export interface GitHubIssueImport {
  tasks: ImportedTask[];
  /** Generic task JSON accepted by the existing mission intake parser. */
  json: string;
  warnings: string[];
}

function sourceBody(issue: GhIssue): string {
  const source = issue.url.trim() ? `GitHub issue: ${issue.url.trim()}` : "";
  return [source, issue.body.trim()].filter(Boolean).join("\n\n");
}

/**
 * Convert a stable selection of backend-sanitized issues into mission tasks.
 * Duplicate issue numbers are ignored and closed issues remain importable
 * because the user selected them explicitly in the picker.
 */
export function buildGitHubIssueImport(
  issues: readonly GhIssue[],
  selectedNumbers?: ReadonlySet<number>,
): GitHubIssueImport {
  const seen = new Set<number>();
  const selected = issues
    .filter((issue) => !selectedNumbers || selectedNumbers.has(issue.number))
    .filter((issue) => {
      if (seen.has(issue.number)) return false;
      seen.add(issue.number);
      return true;
    })
    .map((issue) => ({
      number: issue.number,
      title: issue.title,
      body: sourceBody(issue),
      labels: issue.labels,
      state: issue.state,
    }));

  const normalized = normalizeGitHubIssues(selected, { includeClosed: true });
  const json = JSON.stringify(
    normalized.tasks.map((task) => ({
      // `key` preserves the external id while avoiding false detection as a
      // raw Linear export in the generic intake parser (`id` is its signal).
      key: task.externalId,
      title: task.title,
      description: task.description,
      priority: task.priority,
      role: task.role,
      dependencies: task.dependencyRefs,
      acceptanceCriteria: task.acceptanceCriteria,
      labels: task.labels,
    })),
    null,
    2,
  );

  return { tasks: normalized.tasks, json, warnings: normalized.warnings };
}
