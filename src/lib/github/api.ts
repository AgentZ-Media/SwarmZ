// GitHub commands — native-only direct `invoke` wrappers, same pattern as
// lib/worktree.ts. All go through the local `gh` CLI in Rust (github.rs);
// the write wrappers are additionally Rust-gated on the integration flag.

import { invoke } from "@tauri-apps/api/core";
import { useSwarm } from "@/store";
import type {
  GhAuthStatus,
  GhOutcome,
  GhPr,
  GhPrCreated,
  GhPrDetail,
  GhRepoInfo,
} from "./types";

/** The Settings gh-binary override (empty = Rust auto-resolves). */
function ghBin(): string | undefined {
  return useSwarm.getState().settings.ghPath?.trim() || undefined;
}

export function fetchGhAuthStatus(): Promise<GhAuthStatus> {
  return invoke<GhAuthStatus>("gh_auth_status", { bin: ghBin() });
}

export function fetchGhRepoInfo(dir: string): Promise<GhOutcome<GhRepoInfo>> {
  return invoke<GhOutcome<GhRepoInfo>>("gh_repo_info", { dir, bin: ghBin() });
}

export function fetchGhPrList(dir: string): Promise<GhOutcome<GhPr[]>> {
  return invoke<GhOutcome<GhPr[]>>("gh_pr_list", { dir, bin: ghBin() });
}

export function fetchGhPrView(
  dir: string,
  number: number,
  includeDiff = true,
): Promise<GhOutcome<GhPrDetail>> {
  return invoke<GhOutcome<GhPrDetail>>("gh_pr_view", {
    dir,
    number,
    includeDiff,
    bin: ghBin(),
  });
}

/** GATED write: push the branch checked out in `dir` + open a PR. */
export function ghCreatePr(args: {
  dir: string;
  title: string;
  body: string;
  base?: string;
  draft?: boolean;
}): Promise<GhOutcome<GhPrCreated>> {
  return invoke<GhOutcome<GhPrCreated>>("gh_pr_create", {
    dir: args.dir,
    title: args.title,
    body: args.body,
    base: args.base,
    draft: args.draft,
    bin: ghBin(),
    gitBin: useSwarm.getState().settings.gitPath?.trim() || undefined,
  });
}

/** GATED write: comment on a PR. */
export function ghCommentPr(
  dir: string,
  number: number,
  body: string,
): Promise<GhOutcome<unknown>> {
  return invoke<GhOutcome<unknown>>("gh_pr_comment", {
    dir,
    number,
    body,
    bin: ghBin(),
  });
}

/** GATED write: submit a PR review. */
export function ghReviewPr(
  dir: string,
  number: number,
  action: "approve" | "request_changes" | "comment",
  body?: string,
): Promise<GhOutcome<unknown>> {
  return invoke<GhOutcome<unknown>>("gh_pr_review", {
    dir,
    number,
    action,
    body,
    bin: ghBin(),
  });
}

/**
 * Mirror the Settings master toggle into the Rust-side gate. DISABLING acks
 * only after Rust drained in-flight writes — callers may await it as "no gh
 * write is running and none can start".
 */
export function setGithubIntegration(enabled: boolean): Promise<void> {
  return invoke<void>("github_set_integration", { enabled });
}

/**
 * Mirror the Settings "Autonomous GitHub actions" toggle into Rust so the
 * server-side gh-write approval classification can consult it (defense in
 * depth with the TS-side `guardOutwardGithub`). Best-effort: the command may
 * not exist on an older backend — callers swallow a missing-command error.
 */
export function setAutonomousGithubWrites(enabled: boolean): Promise<void> {
  return invoke<void>("github_set_autonomous_writes", { enabled });
}

/** Declaratively (re)configure the Rust PR watcher; [] stops polling. */
export function configureGithubWatch(
  repos: { project_id: string; dir: string }[],
  intervalSecs: number,
): Promise<void> {
  return invoke<void>("github_watch_configure", {
    repos,
    intervalSecs,
    bin: ghBin(),
  });
}
