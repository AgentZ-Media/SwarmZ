//! GitHub integration over the user's local `gh` CLI.
//!
//! The module keeps the command surface stable while separating four trust
//! boundaries: process execution and typed degradation, read-only parsing,
//! gated writes, and the asynchronous PR watcher.

mod process;
mod reads;
mod watcher;
mod writes;

#[allow(unused_imports)]
pub use process::{
    agent_gh_writes_allowed, autonomous_gh_writes, integration_enabled, set_autonomous_writes,
    set_integration, writes_in_flight, GhOutcome,
};
#[allow(unused_imports)]
pub(crate) use process::{gh_bin, redact_credentials};
#[allow(unused_imports)]
pub(crate) use reads::summarize_checks;
#[allow(unused_imports)]
pub use reads::{
    auth_status, issue_list, pr_list, pr_view, repo_info, ChecksSummary, GhAuthStatus, GhIssue,
    GhPr, GhPrDetail, GhPrFile, GhPrReview, GhRepoInfo,
};
#[allow(unused_imports)]
pub(crate) use watcher::{diff_pr_sets, PrSig};
#[allow(unused_imports)]
pub use watcher::{watch_configure, PrChange, WatchRepo};
pub use writes::{pr_comment, pr_create, pr_review, GhPrCreated};

#[cfg(test)]
pub(crate) use process::{classify_gh_stderr, require_integration};
#[cfg(test)]
pub(crate) use reads::{
    drain_capped, finish_capped_diff, gh_diff_capped_with_timeout, parse_issue_list_output,
    BODY_CHAR_CAP, ISSUE_JSON_BYTE_CAP, ISSUE_LIST_MAX,
};
#[cfg(test)]
pub(crate) use writes::ensure_lane_branch;

#[cfg(test)]
mod tests;
