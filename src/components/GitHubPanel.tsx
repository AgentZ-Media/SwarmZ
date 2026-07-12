import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Bot,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  RefreshCw,
  X,
} from "lucide-react";
import { useSwarm } from "@/store";
import { useProjects } from "@/lib/projects/store";
import { useGithub, projectGithub } from "@/lib/github/store";
import {
  refreshGithubAuth,
  refreshProjectGithub,
} from "@/lib/github/controller";
import { fetchGhPrView } from "@/lib/github/api";
import { spawnPrAgent } from "@/lib/github/agent";
import type { PrAgentMode } from "@/lib/github/core";
import type { GhPr, GhPrDetail } from "@/lib/github/types";
import { splitUnifiedDiff } from "@/lib/vibe/diff";
import { TurnDiffFiles } from "./vibe/DiffCard";
import { openUrl } from "@/lib/transport";
import { Tip } from "./ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * The GitHub panel (Phase 7) — a right-side drawer (Quick-Notes pattern) over
 * the ACTIVE project's GitHub context: repo header with a clickable link and
 * the gh auth chip, the open PRs with status badges (checks / review /
 * draft / conflicts in the signal triad), and a PR detail view whose diff
 * renders through the SAME @pierre/diffs stack as the transcripts
 * (`gh pr diff` → splitUnifiedDiff → TurnDiffFiles). The view is read-only
 * and works with the integration toggle OFF too (local gh state only) — a
 * footer line then points at Settings for the automation. Every PR carries
 * the two agent spawn buttons (Review / Review & merge, `PrAgentButtons`):
 * human-triggered and toggle-independent — the spawned agent's gh calls run
 * through the normal approval classification, so a merge always ends at a
 * human approval click.
 */
export function GitHubPanel() {
  const open = useSwarm((s) => s.githubOpen);
  const setOpen = useSwarm((s) => s.setGithubOpen);
  const activeProjectId = useProjects((s) => s.activeProjectId);
  const [detailNumber, setDetailNumber] = useState<number | null>(null);

  // fresh detection on every open (repo + PRs + auth chip)
  useEffect(() => {
    if (!open) return;
    setDetailNumber(null);
    void refreshGithubAuth();
    if (activeProjectId)
      void refreshProjectGithub(activeProjectId, { force: true });
  }, [open, activeProjectId]);

  // Escape closes (capture, so window-level handlers don't also react) —
  // unless a real dialog is stacked above the drawer
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (
        document.querySelector('[role="dialog"]:not([aria-label="GitHub"])')
      )
        return;
      e.stopPropagation();
      setOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, setOpen]);

  if (!open) return null;

  return (
    <>
      <div
        className="animate-zoverlay fixed inset-0 z-30 bg-[rgba(5,5,8,0.55)] backdrop-blur-[2px]"
        onClick={() => setOpen(false)}
      />
      <div
        role="dialog"
        aria-label="GitHub"
        className="animate-ztoast fixed right-0 top-0 z-40 flex h-full w-[560px] max-w-[92vw] flex-col border-l border-line2 bg-panel shadow-modal outline-none"
      >
        <PanelHeader onClose={() => setOpen(false)} projectId={activeProjectId} />
        {activeProjectId === null ? (
          <EmptyState line="Open a project to see its GitHub context." />
        ) : detailNumber === null ? (
          <PrList projectId={activeProjectId} onSelect={setDetailNumber} />
        ) : (
          <PrDetail
            projectId={activeProjectId}
            number={detailNumber}
            onBack={() => setDetailNumber(null)}
          />
        )}
        <PanelFooter />
      </div>
    </>
  );
}

// ---- header: repo + auth chip ----

function PanelHeader({
  onClose,
  projectId,
}: {
  onClose: () => void;
  projectId: string | null;
}) {
  const repo = useGithub((s) => projectGithub(s, projectId).repo);
  const login = useGithub((s) => s.auth?.login ?? null);
  const authOk = useGithub(
    (s) => !!s.auth && s.auth.installed && s.auth.authenticated,
  );
  const [refreshing, setRefreshing] = useState(false);

  const refresh = () => {
    if (!projectId || refreshing) return;
    setRefreshing(true);
    void Promise.all([
      refreshGithubAuth(),
      refreshProjectGithub(projectId, { force: true }),
    ]).finally(() => setRefreshing(false));
  };

  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
      <GitPullRequest size={15} className="shrink-0 text-mut" />
      {repo ? (
        <button
          onClick={() => void openUrl(repo.url)}
          title={repo.url}
          className="focus-ring flex min-w-0 items-center gap-1.5 rounded-xs font-mono text-12 font-semibold text-txt hover:text-acc"
        >
          <span className="truncate">{repo.full_name}</span>
          <ExternalLink size={11} className="shrink-0 text-fnt" />
        </button>
      ) : (
        <span className="text-14 font-semibold tracking-[-0.01em] text-txt">
          GitHub
        </span>
      )}
      {repo && (
        <span className="shrink-0 rounded-sm border border-line px-1.5 py-px font-mono text-10 uppercase tracking-[.08em] text-fnt">
          {repo.visibility.toLowerCase()}
        </span>
      )}
      <span className="min-w-0 flex-1" />
      {login && (
        <Tip label={authOk ? `Logged in as ${login} (gh CLI)` : "gh auth problem"}>
          <span
            tabIndex={0}
            className={cn(
              "focus-ring flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-card px-2 py-0.5 font-mono text-10",
              authOk ? "text-mut" : "text-warn",
            )}
          >
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                authOk ? "bg-ok" : "bg-warn",
              )}
            />
            {login}
          </span>
        </Tip>
      )}
      <Tip label="Refresh">
        <button
          onClick={refresh}
          className="focus-ring flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-fnt hover:bg-card hover:text-txt"
        >
          <RefreshCw size={12} className={refreshing ? "animate-spin" : ""} />
        </button>
      </Tip>
      <button
        onClick={onClose}
        title="Close (⎋)"
        className="focus-ring flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-fnt hover:bg-card hover:text-txt"
      >
        <X size={13} />
      </button>
    </div>
  );
}

function PanelFooter() {
  const enabled = useSwarm((s) => !!s.settings.githubIntegration);
  if (enabled) return null;
  return (
    <div className="shrink-0 border-t border-line px-4 py-2 text-11 leading-relaxed text-fnt">
      Read-only view. Enable the GitHub integration in Settings → GitHub to
      give the Conductor its PR tools, the watcher and the Deck indicator.
    </div>
  );
}

function EmptyState({ line, sub }: { line: string; sub?: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1 px-8 text-center">
      <p className="text-12 text-mut">{line}</p>
      {sub && <p className="font-mono text-11 text-fnt">{sub}</p>}
    </div>
  );
}

// ---- PR badges (signal triad: attn = needs a human, ok/err = state) ----

function ChecksBadge({ pr }: { pr: GhPr }) {
  const c = pr.checks;
  if (c.total === 0) return null;
  if (c.failing > 0)
    return (
      <span className="rounded-sm bg-err/15 px-1 font-mono text-10 text-err">
        × {c.failing} failing
      </span>
    );
  if (c.pending > 0)
    return (
      <span className="rounded-sm bg-warn/15 px-1 font-mono text-10 text-warn">
        … {c.pending} pending
      </span>
    );
  return (
    <span className="rounded-sm bg-ok/15 px-1 font-mono text-10 text-ok">
      ✓ checks
    </span>
  );
}

function ReviewBadge({ pr }: { pr: GhPr }) {
  switch (pr.review_decision) {
    case "APPROVED":
      return (
        <span className="rounded-sm bg-ok/15 px-1 font-mono text-10 text-ok">
          approved
        </span>
      );
    case "CHANGES_REQUESTED":
      return (
        <span className="rounded-sm bg-err/15 px-1 font-mono text-10 text-err">
          changes requested
        </span>
      );
    case "REVIEW_REQUIRED":
      return (
        <span className="rounded-sm border border-line px-1 font-mono text-10 text-fnt">
          review required
        </span>
      );
    default:
      return null;
  }
}

function StateBadges({ pr }: { pr: GhPr }) {
  return (
    <>
      {pr.is_draft && (
        <span className="rounded-sm border border-line px-1 font-mono text-10 text-fnt">
          draft
        </span>
      )}
      <ChecksBadge pr={pr} />
      <ReviewBadge pr={pr} />
      {pr.mergeable === "CONFLICTING" && (
        <span className="rounded-sm bg-err/15 px-1 font-mono text-10 text-err">
          conflicts
        </span>
      )}
    </>
  );
}

// ---- PR agent actions (Review / Review & merge spawn buttons) ----

/**
 * The two spawn buttons every PR carries (list row + detail): start a fresh
 * workspace agent on the project whose first prompt is the PR brief
 * (`prAgentPrompt`). Spawning focuses the new agent and closes the drawer;
 * a failed start stays here as an inline error. The merge variant only ADDS
 * the merge step to the prompt — the agent's `gh pr merge` still escalates
 * to a human approval click (destructive by classification).
 */
function PrAgentButtons({ projectId, pr }: { projectId: string; pr: GhPr }) {
  const setOpen = useSwarm((s) => s.setGithubOpen);
  const [spawning, setSpawning] = useState<PrAgentMode | null>(null);
  const [error, setError] = useState<string | null>(null);

  const spawn = async (mode: PrAgentMode) => {
    if (spawning) return;
    setSpawning(mode);
    setError(null);
    try {
      await spawnPrAgent(projectId, pr, mode);
      setOpen(false);
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ""));
      setSpawning(null);
    }
  };

  const btn =
    "focus-ring flex h-6 items-center gap-1 rounded-md border border-line px-2 font-mono text-10 text-mut transition-colors hover:border-line2 hover:text-txt disabled:opacity-50";
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <Tip label="Spawn an agent that reviews this PR and reports its findings">
          <button
            onClick={() => void spawn("review")}
            disabled={spawning !== null}
            className={btn}
          >
            <Bot size={11} />
            {spawning === "review" ? "starting…" : "Review"}
          </button>
        </Tip>
        <Tip label="Spawn an agent that reviews this PR and, if it holds up, merges it — the merge command still asks for your approval">
          <button
            onClick={() => void spawn("review_merge")}
            disabled={spawning !== null}
            className={btn}
          >
            <GitMerge size={11} />
            {spawning === "review_merge" ? "starting…" : "Review & merge"}
          </button>
        </Tip>
      </div>
      {error && (
        <p className="break-words font-mono text-10 leading-relaxed text-err">
          {error}
        </p>
      )}
    </div>
  );
}

// ---- PR list ----

function PrList({
  projectId,
  onSelect,
}: {
  projectId: string;
  onSelect: (n: number) => void;
}) {
  const status = useGithub((s) => projectGithub(s, projectId).repoStatus);
  const repoError = useGithub((s) => projectGithub(s, projectId).repoError);
  const prs = useGithub((s) => projectGithub(s, projectId).prs);
  const prsError = useGithub((s) => projectGithub(s, projectId).prsError);
  const watchedCount = useGithub((s) => (s.watched[projectId] ?? []).length);
  const watched = useGithub((s) => s.watched[projectId]);

  switch (status) {
    case "unknown":
    case "loading":
      return <EmptyState line="Detecting the GitHub context…" />;
    case "not_installed":
      return (
        <EmptyState
          line="The GitHub CLI is not installed."
          sub="brew install gh · then: gh auth login"
        />
      );
    case "not_authenticated":
      return (
        <EmptyState line="gh is not logged in." sub="Run: gh auth login" />
      );
    case "no_remote":
      return (
        <EmptyState
          line="This project has no GitHub remote."
          sub="Nothing to show here."
        />
      );
    case "error":
      return (
        <EmptyState line="GitHub detection failed." sub={repoError ?? undefined} />
      );
  }

  if (prs.length === 0)
    return prsError ? (
      <EmptyState line="Couldn't load the pull requests." sub={prsError} />
    ) : (
      <EmptyState line="No open pull requests." />
    );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
      <div className="px-1 pb-1.5 font-mono text-10 font-medium uppercase tracking-[.08em] text-fnt">
        {prs.length} open pull request{prs.length === 1 ? "" : "s"}
        {watchedCount > 0 && ` · ${watchedCount} watched`}
      </div>
      {prsError && (
        <div className="mx-1 mb-1.5 rounded-sm bg-warn/10 px-2 py-1 font-mono text-10 text-warn">
          List may be stale — the last refresh failed: {prsError}
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        {prs.map((pr) => (
          // a DIV, not a button — the open-detail area and the agent spawn
          // buttons are SIBLINGS inside (no nested interactives, the project
          // tabs' pattern)
          <div
            key={pr.number}
            className="flex flex-col rounded-lg border border-line bg-card transition-colors hover:border-line2"
          >
            <button
              onClick={() => onSelect(pr.number)}
              className="focus-ring flex flex-col gap-1 rounded-t-lg px-3 pb-1 pt-2 text-left"
            >
              <span className="flex items-center gap-2">
                <span className="shrink-0 font-mono text-11 tabular-nums text-fnt">
                  #{pr.number}
                </span>
                <span className="min-w-0 flex-1 truncate text-12 font-medium text-txt">
                  {pr.title}
                </span>
                {(watched ?? []).includes(pr.number) && (
                  <Tip label="The Conductor watches this PR">
                    <span
                      tabIndex={0}
                      className="focus-ring shrink-0 rounded-xs font-mono text-10 text-acc"
                    >
                      ◉
                    </span>
                  </Tip>
                )}
              </span>
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="min-w-0 truncate font-mono text-10 text-fnt">
                  {pr.author} · {pr.head_ref} → {pr.base_ref}
                </span>
                <span className="ml-auto flex shrink-0 items-center gap-1">
                  <StateBadges pr={pr} />
                </span>
              </span>
            </button>
            <div className="px-3 pb-2 pt-0.5">
              <PrAgentButtons projectId={projectId} pr={pr} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- PR detail (diff through the shared @pierre/diffs stack) ----

function PrDetail({
  projectId,
  number,
  onBack,
}: {
  projectId: string;
  number: number;
  onBack: () => void;
}) {
  const dir = useProjects((s) => s.projects[projectId]?.dir ?? "");
  const [detail, setDetail] = useState<GhPrDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    setDetail(null);
    setError(null);
    if (!dir) return;
    fetchGhPrView(dir, number, true).then(
      (outcome) => {
        if (stale) return;
        if (outcome.status === "ok") setDetail(outcome.data);
        else
          setError(
            outcome.status === "error"
              ? outcome.data
              : `gh unavailable (${outcome.status})`,
          );
      },
      (e) => {
        if (!stale) setError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => {
      stale = true;
    };
  }, [dir, number]);

  const files = useMemo(
    () => (detail?.diff ? splitUnifiedDiff(detail.diff) : []),
    [detail?.diff],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
        <button
          onClick={onBack}
          title="Back to the PR list"
          className="focus-ring flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-fnt hover:bg-card hover:text-txt"
        >
          <ArrowLeft size={13} />
        </button>
        <span className="shrink-0 font-mono text-11 tabular-nums text-fnt">
          #{number}
        </span>
        {detail && (
          <>
            <span className="min-w-0 flex-1 truncate text-12 font-semibold text-txt">
              {detail.title}
            </span>
            <button
              onClick={() => void openUrl(detail.url)}
              title="Open on GitHub"
              className="focus-ring flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-fnt hover:bg-card hover:text-txt"
            >
              <ExternalLink size={12} />
            </button>
          </>
        )}
      </div>

      {error ? (
        <EmptyState line="Couldn't load the PR." sub={error} />
      ) : !detail ? (
        <EmptyState line="Loading PR…" />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex flex-col gap-2 border-b border-line px-4 py-3">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-mono text-10 text-fnt">
                {detail.author} · {detail.head_ref} → {detail.base_ref}
              </span>
              <span className="ml-auto flex items-center gap-1">
                <StateBadges pr={detail} />
              </span>
            </div>
            <div className="font-mono text-11 tabular-nums text-mut">
              {detail.changed_files} file{detail.changed_files === 1 ? "" : "s"}{" "}
              <span className="text-add">+{detail.additions}</span>{" "}
              <span className="text-del">−{detail.deletions}</span>
              {detail.reviews.length > 0 && (
                <span className="text-fnt">
                  {" "}
                  · {detail.reviews.length} review
                  {detail.reviews.length === 1 ? "" : "s"}
                </span>
              )}
            </div>
            <PrAgentButtons projectId={projectId} pr={detail} />
            {detail.body && (
              <p className="max-h-40 overflow-y-auto whitespace-pre-wrap text-12 leading-relaxed text-mut">
                {detail.body}
              </p>
            )}
          </div>

          <div className="px-3 py-2">
            {files.length > 0 ? (
              <div className="overflow-hidden rounded-lg border border-line bg-card">
                <TurnDiffFiles files={files} />
                {detail.diff_truncated && (
                  <div className="border-t border-line px-3 py-1 font-mono text-10 text-warn">
                    [truncated] — the PR diff is too large to render in full
                  </div>
                )}
              </div>
            ) : (
              <p className="px-1 py-2 text-11 text-fnt">
                No diff available for this PR.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
