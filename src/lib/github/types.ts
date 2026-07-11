// GitHub integration payload types — mirrors of the serde structs in
// src-tauri/src/github.rs (fields arrive snake_case). Phase 7: everything
// comes from the LOCAL `gh` CLI; there is no OAuth and no token handling
// anywhere in the frontend.

/** `gh auth status` digest — never errors, degradation is in the flags. */
export interface GhAuthStatus {
  installed: boolean;
  authenticated: boolean;
  login: string | null;
  scopes: string | null;
  version: string | null;
  error: string | null;
}

/**
 * Typed degradation of every gh command (`GhOutcome` in Rust):
 * `{status:"ok", data}` or a typed unavailable state.
 */
export type GhOutcome<T> =
  | { status: "ok"; data: T }
  | { status: "not_installed" }
  | { status: "not_authenticated" }
  | { status: "no_remote" }
  | { status: "error"; data: string };

/** The GitHub remote of a project folder. */
export interface GhRepoInfo {
  owner: string;
  name: string;
  /** "owner/name" */
  full_name: string;
  url: string;
  default_branch: string;
  /** "PUBLIC" | "PRIVATE" | "INTERNAL" */
  visibility: string;
}

/** Aggregated CI state of one PR (derived Rust-side from statusCheckRollup). */
export interface GhChecksSummary {
  passing: number;
  failing: number;
  pending: number;
  total: number;
}

/** One open PR (list shape). */
export interface GhPr {
  number: number;
  title: string;
  author: string;
  head_ref: string;
  base_ref: string;
  is_draft: boolean;
  /** "MERGEABLE" | "CONFLICTING" | "UNKNOWN" */
  mergeable: string;
  /** "" | "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" */
  review_decision: string;
  url: string;
  updated_at: string;
  checks: GhChecksSummary;
}

export interface GhPrFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface GhPrReview {
  author: string;
  state: string;
}

/** Full PR detail (flattens the GhPr fields + extras). */
export interface GhPrDetail extends GhPr {
  body: string;
  additions: number;
  deletions: number;
  changed_files: number;
  files: GhPrFile[];
  reviews: GhPrReview[];
  /** unified diff, byte-capped on a line boundary; null when skipped/failed */
  diff: string | null;
  diff_truncated: boolean;
}

export interface GhPrCreated {
  url: string;
  branch: string;
}

/** One detected change inside a `github://pr-changed` event. */
export interface PrChange {
  number: number;
  title: string;
  url: string;
  /** "opened" | "closed" | "checks" | "review" | "draft" | "updated" */
  kind: string;
  note: string;
}

/** Payload of the `github://pr-changed` event (Rust watcher). */
export interface PrChangedEvent {
  project_id: string;
  dir: string;
  prs: GhPr[];
  changes: PrChange[];
  /** true = the repo's FIRST poll (a cache seed, not a change) */
  baseline?: boolean;
}
