import { useEffect, useId, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  CircleDot,
  GitBranch,
  RefreshCw,
  Search,
} from "lucide-react";
import { fetchGhIssueList } from "@/lib/github/api";
import { describeGhUnavailable } from "@/lib/github/core";
import {
  buildGitHubIssueImport,
  type ImportedTask,
} from "@/lib/github/issue-import";
import type { GhIssue } from "@/lib/github/types";
import { useProjects } from "@/lib/projects/store";
import { cn } from "@/lib/utils";

type IssueFilter = "all" | "open" | "closed";

export interface GitHubIssueImportPanelProps {
  /** Defaults to the active project, so the panel can be embedded directly. */
  projectDir?: string;
  onImport: (tasks: ImportedTask[], json: string) => void;
  className?: string;
}

/**
 * Read-only GitHub issue picker for mission intake. It is intentionally
 * standalone: the mission dialog decides when and where to consume the JSON.
 */
export function GitHubIssueImportPanel({
  projectDir,
  onImport,
  className,
}: GitHubIssueImportPanelProps) {
  const titleId = useId();
  const searchId = useId();
  const activeDir = useProjects((state) => {
    const activeId = state.activeProjectId;
    return activeId ? (state.projects[activeId]?.dir ?? "") : "";
  });
  const dir = projectDir?.trim() || activeDir;
  const [issues, setIssues] = useState<GhIssue[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<IssueFilter>("open");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setSelected(new Set());
    setIssues([]);
    setError(null);
    if (!dir) {
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }

    setLoading(true);
    void fetchGhIssueList(dir)
      .then((outcome) => {
        if (cancelled) return;
        if (outcome.status === "ok") {
          setIssues(outcome.data);
          return;
        }
        if (outcome.status === "error") {
          setError(`GitHub issues could not be loaded: ${outcome.data}`);
          return;
        }
        setError(`GitHub issues are unavailable: ${describeGhUnavailable(outcome.status)}.`);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(
            cause instanceof Error
              ? cause.message
              : "GitHub issues could not be loaded.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [dir, refreshKey]);

  const visibleIssues = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return issues.filter((issue) => {
      if (filter !== "all" && issue.state.toLowerCase() !== filter) return false;
      if (!needle) return true;
      return (
        `#${issue.number} ${issue.title} ${issue.body} ${issue.labels.join(" ")}`
          .toLowerCase()
          .includes(needle)
      );
    });
  }, [filter, issues, query]);

  const visibleNumbers = useMemo(
    () => [...new Set(visibleIssues.map((issue) => issue.number))],
    [visibleIssues],
  );
  const allVisibleSelected =
    visibleNumbers.length > 0 && visibleNumbers.every((number) => selected.has(number));

  const toggleIssue = (number: number) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(number)) next.delete(number);
      else next.add(number);
      return next;
    });
  };

  const toggleVisible = () => {
    setSelected((current) => {
      const next = new Set(current);
      for (const number of visibleNumbers) {
        if (allVisibleSelected) next.delete(number);
        else next.add(number);
      }
      return next;
    });
  };

  const importSelection = () => {
    const result = buildGitHubIssueImport(issues, selected);
    if (result.tasks.length > 0) onImport(result.tasks, result.json);
  };

  return (
    <section
      aria-labelledby={titleId}
      className={cn(
        "flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-line bg-card",
        className,
      )}
    >
      <header className="flex min-h-14 items-center gap-3 border-b border-line px-4 py-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line2 bg-panel text-mut">
          <GitBranch size={16} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-14 font-semibold tracking-[-0.01em] text-txt">
            Import GitHub issues
          </h2>
          <p className="mt-0.5 text-10 text-fnt">
            Read-only intake from the active repository
          </p>
        </div>
        <span className="rounded-sm border border-line2 bg-panel px-2 py-1 font-mono text-10 tabular-nums text-mut">
          {issues.length} issues
        </span>
        <button
          type="button"
          onClick={() => setRefreshKey((value) => value + 1)}
          disabled={!dir || loading}
          aria-label="Refresh GitHub issues"
          className="focus-ring flex h-8 w-8 items-center justify-center rounded-md text-mut hover:bg-pop hover:text-txt disabled:cursor-not-allowed disabled:opacity-40"
        >
          <RefreshCw size={13} className={cn(loading && "animate-spin")} aria-hidden />
        </button>
      </header>

      {!dir ? (
        <EmptyState
          icon={<GitBranch size={20} aria-hidden />}
          title="Open a project first"
          detail="Issue intake uses the GitHub repository of the active project."
        />
      ) : loading ? (
        <IssueLoading />
      ) : error ? (
        <div role="alert" className="m-3 rounded-lg border border-err/40 bg-err/10 p-3">
          <div className="flex items-center gap-2 text-12 font-medium text-err">
            <AlertTriangle size={14} aria-hidden /> Issue import unavailable
          </div>
          <p className="mt-1.5 break-words text-11 leading-relaxed text-mut">{error}</p>
          <button
            type="button"
            onClick={() => setRefreshKey((value) => value + 1)}
            className="focus-ring mt-3 flex h-7 items-center gap-1.5 rounded-md border border-line2 px-2.5 text-10 text-mut hover:bg-card hover:text-txt"
          >
            <RefreshCw size={11} aria-hidden /> Try again
          </button>
        </div>
      ) : issues.length === 0 ? (
        <EmptyState
          icon={<Check size={20} aria-hidden />}
          title="No issues in this repository"
          detail="New open or closed GitHub issues will appear here after a refresh."
          tone="ok"
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5">
            <label htmlFor={searchId} className="relative min-w-44 flex-1">
              <Search
                size={12}
                aria-hidden
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fnt"
              />
              <input
                id={searchId}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search issues or labels"
                className="focus-ring h-8 w-full rounded-md border border-line2 bg-bg pl-8 pr-3 text-11 text-txt placeholder:text-fnt"
              />
            </label>
            <div className="flex rounded-md border border-line2 bg-panel p-0.5" aria-label="Issue state filter">
              {(["open", "closed", "all"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setFilter(value)}
                  aria-pressed={filter === value}
                  className={cn(
                    "focus-ring h-7 rounded px-2.5 font-mono text-10 capitalize transition-colors",
                    filter === value ? "bg-card text-txt shadow-sm" : "text-fnt hover:text-mut",
                  )}
                >
                  {value}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2 border-b border-line bg-panel/40 px-4 py-2">
            <button
              type="button"
              onClick={toggleVisible}
              disabled={visibleNumbers.length === 0}
              className="focus-ring text-10 font-medium text-mut hover:text-txt disabled:cursor-not-allowed disabled:opacity-40"
            >
              {allVisibleSelected ? "Clear visible" : "Select visible"}
            </button>
            <span className="font-mono text-10 tabular-nums text-fnt">
              {visibleIssues.length} shown
            </span>
            <span className="ml-auto font-mono text-10 tabular-nums text-acc">
              {selected.size} selected
            </span>
          </div>

          {visibleIssues.length === 0 ? (
            <EmptyState
              icon={<Search size={18} aria-hidden />}
              title="No matching issues"
              detail="Try another search or issue state."
            />
          ) : (
            <div role="list" aria-label="GitHub issues" className="min-h-0 flex-1 overflow-y-auto">
              {visibleIssues.map((issue) => (
                <IssueRow
                  key={issue.number}
                  issue={issue}
                  checked={selected.has(issue.number)}
                  onToggle={() => toggleIssue(issue.number)}
                />
              ))}
            </div>
          )}

          <footer className="flex min-h-12 items-center gap-3 border-t border-line px-4 py-2">
            <p className="min-w-0 flex-1 text-10 leading-normal text-fnt">
              Creates editable mission tasks. GitHub stays unchanged.
            </p>
            <button
              type="button"
              onClick={importSelection}
              disabled={selected.size === 0}
              className="focus-ring h-8 shrink-0 rounded-md bg-acc px-3.5 text-11 font-semibold text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Import {selected.size || "selected"}
            </button>
          </footer>
        </>
      )}
    </section>
  );
}

function IssueRow({
  issue,
  checked,
  onToggle,
}: {
  issue: GhIssue;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <label
      role="listitem"
      className={cn(
        "group flex cursor-pointer items-start gap-3 border-b border-line px-4 py-3 transition-colors last:border-b-0 hover:bg-pop",
        checked && "bg-acc/[0.06] hover:bg-acc/[0.09]",
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="peer sr-only"
        aria-label={`Select issue #${issue.number}: ${issue.title}`}
      />
      <span
        aria-hidden
        className={cn(
          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border peer-focus-visible:ring-2 peer-focus-visible:ring-acc/80",
          checked ? "border-acc bg-acc text-white" : "border-line2 bg-bg text-transparent",
        )}
      >
        <Check size={11} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-start gap-2">
          <span className="shrink-0 font-mono text-10 tabular-nums text-fnt">#{issue.number}</span>
          <p className="min-w-0 flex-1 text-12 font-medium leading-snug text-txt">{issue.title}</p>
          <span
            className={cn(
              "flex shrink-0 items-center gap-1 rounded-sm border px-1.5 py-0.5 font-mono text-10 uppercase",
              issue.state === "OPEN"
                ? "border-ok/30 bg-ok/10 text-ok"
                : "border-line2 bg-panel text-fnt",
            )}
          >
            <CircleDot size={8} aria-hidden /> {issue.state.toLowerCase()}
          </span>
        </div>
        {issue.body && (
          <p className="mt-1 line-clamp-2 text-10 leading-relaxed text-mut">{issue.body}</p>
        )}
        {issue.labels.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {issue.labels.slice(0, 8).map((label) => (
              <span
                key={label}
                className="max-w-36 truncate rounded-sm border border-line2 bg-panel px-1.5 py-0.5 font-mono text-10 text-fnt"
              >
                {label}
              </span>
            ))}
            {issue.labels.length > 8 && (
              <span className="font-mono text-10 text-fnt">+{issue.labels.length - 8}</span>
            )}
          </div>
        )}
      </div>
    </label>
  );
}

function IssueLoading() {
  return (
    <div role="status" aria-live="polite" aria-label="Loading GitHub issues" className="p-3">
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="flex animate-pulse gap-3 border-b border-line px-1 py-3 last:border-0">
          <div className="h-4 w-4 rounded border border-line2 bg-panel" />
          <div className="min-w-0 flex-1">
            <div className="h-3 w-2/3 rounded-sm bg-panel" />
            <div className="mt-2 h-2.5 w-full rounded-sm bg-panel" />
            <div className="mt-2 h-4 w-16 rounded-sm bg-panel" />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({
  icon,
  title,
  detail,
  tone = "muted",
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
  tone?: "muted" | "ok";
}) {
  return (
    <div className="flex min-h-44 flex-1 flex-col items-center justify-center px-6 py-8 text-center">
      <span className={tone === "ok" ? "text-ok" : "text-fnt"}>{icon}</span>
      <p className="mt-2 text-12 font-medium text-txt">{title}</p>
      <p className="mt-1 max-w-[42ch] text-10 leading-relaxed text-mut">{detail}</p>
    </div>
  );
}
