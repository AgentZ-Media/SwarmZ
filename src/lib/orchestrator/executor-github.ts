import type { VibeSessionEntry } from "@/lib/vibe/session-store";
import { reviewSession } from "@/lib/vibe/controller";
import { listWorktrees } from "@/lib/worktree";
import {
  fetchGhAuthStatus,
  fetchGhPrList,
  fetchGhPrView,
  ghCommentPr,
  ghCreatePr,
  ghReviewPr,
} from "@/lib/github/api";
import { unwrapGh } from "@/lib/github/core";
import { useGithub } from "@/lib/github/store";
import {
  refreshProjectGithub,
  unwatchPr,
  watchPr,
} from "@/lib/github/controller";
import type { ExecutorFamily } from "./executor-types";
import {
  orderedSessions,
  requireProject,
  requireSession,
} from "./executor-agents";
import {
  gitBin,
  githubEnabled,
  guardOutwardGithub,
  requireGithub,
  requirePrNumber,
} from "./executor-guards";

type GithubTool =
  | "github_status"
  | "list_prs"
  | "read_pr"
  | "create_pr"
  | "review_pr"
  | "comment_pr"
  | "watch_pr";

/**
 * Runtime-gated GitHub family. The static Codex registry is intentionally
 * stable; every operation except status refuses while the master toggle is
 * off, and native write commands enforce the same gate again.
 */
export const githubExecutors: ExecutorFamily<GithubTool> = {
  github_status: async (_args, ctx) => {
    if (!githubEnabled()) {
      return {
        integration_enabled: false,
        note: "The GitHub integration is disabled (Settings → GitHub). Every other github tool refuses while it is off — if the user asks for GitHub work, tell them to enable it there.",
      };
    }
    const { id: projectId, dir } = requireProject(ctx);
    const auth = await fetchGhAuthStatus();
    if (!auth.installed || !auth.authenticated) {
      return {
        integration_enabled: true,
        auth,
        note: auth.installed
          ? "gh is installed but not logged in — the user must run `gh auth login`"
          : "the GitHub CLI (gh) is not installed on this machine",
      };
    }
    await refreshProjectGithub(projectId, { force: true });
    const github = useGithub.getState();
    const project = github.byProject[projectId];
    if (!project || project.repoStatus !== "ok" || !project.repo) {
      return {
        integration_enabled: true,
        auth: { login: auth.login },
        repo: null,
        note:
          project?.repoStatus === "no_remote"
            ? `this project (${dir}) has no GitHub remote`
            : `GitHub repo detection failed: ${project?.repoError ?? project?.repoStatus ?? "unknown"}`,
      };
    }
    const watched = github.watched[projectId] ?? [];
    return {
      integration_enabled: true,
      auth: { login: auth.login },
      repo: project.repo,
      open_prs: project.prs.map((pr) => ({
        number: pr.number,
        title: pr.title,
        head: pr.head_ref,
        draft: pr.is_draft,
        checks: pr.checks,
        review_decision: pr.review_decision,
        watched: watched.includes(pr.number),
      })),
    };
  },

  list_prs: async (_args, ctx) => {
    requireGithub();
    const { id: projectId, dir } = requireProject(ctx);
    const prs = unwrapGh(await fetchGhPrList(dir), "list PRs");
    useGithub.getState().patchProject(projectId, {
      repoStatus: "ok",
      prs,
      prsFetchedAt: Date.now(),
      prsError: null,
    });
    const watched = useGithub.getState().watched[projectId] ?? [];
    return {
      prs: prs.map((pr) => ({
        number: pr.number,
        title: pr.title,
        author: pr.author,
        head: pr.head_ref,
        base: pr.base_ref,
        draft: pr.is_draft,
        mergeable: pr.mergeable,
        review_decision: pr.review_decision,
        checks: pr.checks,
        url: pr.url,
        watched: watched.includes(pr.number),
      })),
    };
  },

  read_pr: async (args, ctx) => {
    requireGithub();
    const { dir } = requireProject(ctx);
    const number = requirePrNumber(args.number);
    const includeDiff = args.include_diff !== false;
    const detail = unwrapGh(
      await fetchGhPrView(dir, number, includeDiff),
      `read PR #${number}`,
    );
    return {
      number: detail.number,
      title: detail.title,
      author: detail.author,
      head: detail.head_ref,
      base: detail.base_ref,
      draft: detail.is_draft,
      mergeable: detail.mergeable,
      review_decision: detail.review_decision,
      checks: detail.checks,
      url: detail.url,
      body: detail.body,
      stats: {
        additions: detail.additions,
        deletions: detail.deletions,
        changed_files: detail.changed_files,
      },
      files: detail.files,
      reviews: detail.reviews,
      ...(includeDiff
        ? {
            diff: detail.diff ?? "(diff unavailable)",
            ...(detail.diff_truncated ? { diff_truncated: true } : {}),
          }
        : {}),
    };
  },

  create_pr: async (args, ctx) => {
    requireGithub();
    guardOutwardGithub(ctx, "open a pull request");
    const { id: projectId } = requireProject(ctx);
    const title = String(args.title ?? "").trim();
    const body = String(args.body ?? "").trim();
    if (!title) throw new Error("title must not be empty");
    if (!body)
      throw new Error("body must not be empty — describe what changed and why");
    const hasAgent = typeof args.agent === "string" && args.agent.trim();
    const wantedBranch =
      typeof args.branch === "string" ? args.branch.trim() : "";
    if (!!hasAgent === !!wantedBranch)
      throw new Error('exactly one of "agent" or "branch" is required');

    let checkoutDir: string;
    let branch: string;
    if (hasAgent) {
      const entry = requireSession(args.agent, ctx);
      if (!entry.session.worktree)
        throw new Error(
          `agent "${entry.session.name}" works directly in the project folder — a PR comes from a worktree branch (place the agent in one first)`,
        );
      checkoutDir = entry.session.projectDir;
      branch = entry.session.worktree.branch;
    } else {
      const { dir } = requireProject(ctx);
      const scan = await listWorktrees([dir], gitBin());
      const worktree = scan.entries.find(
        (entry) => entry.branch === wantedBranch && !entry.missing,
      );
      if (!worktree)
        throw new Error(
          `no worktree on branch "${wantedBranch}" in this project — worktree_status lists the valid branches`,
        );
      checkoutDir = worktree.path;
      branch = worktree.branch;
    }
    const created = unwrapGh(
      await ghCreatePr({
        dir: checkoutDir,
        title,
        body,
        base:
          typeof args.base === "string" && args.base.trim()
            ? args.base.trim()
            : undefined,
        draft: args.draft === true,
      }),
      "create PR",
    );
    void refreshProjectGithub(projectId, { force: true });
    return {
      created: true,
      url: created.url,
      branch,
      note: "the branch was pushed to origin (plain push) and the PR opened — merging stays with the user",
    };
  },

  review_pr: async (args, ctx) => {
    requireGithub();
    const { dir } = requireProject(ctx);
    const number = requirePrNumber(args.number);
    const detail = unwrapGh(
      await fetchGhPrView(dir, number, false),
      `read PR #${number}`,
    );
    let entry: VibeSessionEntry;
    if (typeof args.agent === "string" && args.agent.trim()) {
      entry = requireSession(args.agent, ctx);
    } else {
      const onBranch = orderedSessions(ctx.projectId).filter(
        (candidate) => candidate.session.worktree?.branch === detail.head_ref,
      );
      if (onBranch.length === 0)
        throw new Error(
          `no agent of this project works on the PR's head branch "${detail.head_ref}" — spawn/assign one into a worktree on that branch (or read_pr ${number} and judge the diff yourself)`,
        );
      if (onBranch.length > 1)
        throw new Error(
          `several agents work on "${detail.head_ref}" (${onBranch
            .map((candidate) => candidate.session.name)
            .join(", ")}) — pass one explicitly as "agent"`,
        );
      entry = onBranch[0];
    }
    if (entry.session.worktree?.branch !== detail.head_ref)
      throw new Error(
        `agent "${entry.session.name}" is not on the PR's head branch "${detail.head_ref}" — the review must run in a checkout of that branch`,
      );
    const base = detail.base_ref || "main";
    const result = await reviewSession(entry.session.id, `branch:${base}`, {
      requireWorkspace: true,
    });
    const reviewText =
      result.review ?? "(the review returned no findings text)";
    const post = args.post === true;
    if (post) guardOutwardGithub(ctx, "post a review to");
    let posted = false;
    let postError: string | null = null;
    if (post) {
      const action =
        args.action === "approve" || args.action === "request_changes"
          ? args.action
          : "comment";
      try {
        unwrapGh(
          await ghReviewPr(
            dir,
            number,
            action,
            reviewText.length > 60_000
              ? `${reviewText.slice(0, 60_000)}\n\n…(truncated)`
              : reviewText,
          ),
          "post the review",
        );
        posted = true;
      } catch (error) {
        postError = error instanceof Error ? error.message : String(error);
      }
    }
    return {
      number,
      agent: { id: entry.session.id, name: entry.session.name },
      target: `branch:${base}`,
      status: result.status,
      review: reviewText,
      posted,
      ...(postError ? { post_error: postError } : {}),
    };
  },

  comment_pr: async (args, ctx) => {
    requireGithub();
    guardOutwardGithub(ctx, "comment on a pull request");
    const { dir } = requireProject(ctx);
    const number = requirePrNumber(args.number);
    const body = String(args.body ?? "").trim();
    if (!body) throw new Error("body must not be empty");
    const result = unwrapGh(
      await ghCommentPr(dir, number, body),
      `comment on PR #${number}`,
    );
    return { commented: true, number, ...(result as object) };
  },

  watch_pr: async (args, ctx) => {
    requireGithub();
    const { id: projectId, dir } = requireProject(ctx);
    const number = requirePrNumber(args.number);
    if (args.action === "unwatch") {
      const removed = unwatchPr(projectId, number);
      return {
        watching: false,
        number,
        note: removed
          ? `PR #${number} is no longer watched`
          : `PR #${number} was not watched`,
      };
    }
    const prs = unwrapGh(await fetchGhPrList(dir), "list PRs");
    if (!prs.some((pr) => pr.number === number))
      throw new Error(
        `PR #${number} is not an open PR of this repo — list_prs shows the valid numbers`,
      );
    watchPr(projectId, number);
    return {
      watching: true,
      number,
      note: "every real change (checks, reviews, draft/ready, close/merge) wakes you with an autonomous [pr update] turn. The watch lasts for this app run — set a timer for follow-ups that must survive a restart.",
    };
  },
};
