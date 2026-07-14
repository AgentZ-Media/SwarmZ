use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

use super::process::{integration_enabled, GhOutcome};
use super::reads::{pr_list, ChecksSummary, GhPr};

// ---- PR watcher --------------------------------------------------------------

/// One repo the watcher polls.
#[derive(Debug, Clone, Deserialize)]
pub struct WatchRepo {
    pub project_id: String,
    pub dir: String,
}

/// Comparable signature of one PR — a change in any field is a reportable event.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PrSig {
    pub title: String,
    pub url: String,
    pub is_draft: bool,
    pub mergeable: String,
    pub review_decision: String,
    pub checks: ChecksSummary,
}

impl PrSig {
    pub(crate) fn of(pr: &GhPr) -> Self {
        PrSig {
            title: pr.title.clone(),
            url: pr.url.clone(),
            is_draft: pr.is_draft,
            mergeable: pr.mergeable.clone(),
            review_decision: pr.review_decision.clone(),
            checks: pr.checks.clone(),
        }
    }
}

/// One detected change, emitted in `github://pr-changed`.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PrChange {
    pub number: u64,
    pub title: String,
    pub url: String,
    /// "opened" | "closed" | "checks" | "review" | "draft" | "updated"
    pub kind: String,
    /// short human note ("checks: 1 failing", "review: APPROVED", …)
    pub note: String,
}

/// Diff two PR snapshots into reportable changes (pure, unit-tested).
/// `first_poll` = the repo's FIRST poll — nothing is reported (a baseline,
/// not a change). The flag is EXPLICIT because an empty `old` map is
/// ambiguous: a repo whose baseline had ZERO open PRs must still report the
/// first PR opened after it.
pub(crate) fn diff_pr_sets(
    old: &HashMap<u64, PrSig>,
    new_prs: &[GhPr],
    first_poll: bool,
) -> Vec<PrChange> {
    if first_poll {
        return Vec::new();
    }
    let mut changes = Vec::new();
    for pr in new_prs {
        let Some(prev) = old.get(&pr.number) else {
            changes.push(PrChange {
                number: pr.number,
                title: pr.title.clone(),
                url: pr.url.clone(),
                kind: "opened".into(),
                note: "opened".into(),
            });
            continue;
        };
        let now = PrSig::of(pr);
        if *prev == now {
            continue;
        }
        let (kind, note) = if prev.checks != now.checks {
            (
                "checks",
                format!(
                    "checks: {} passing, {} failing, {} pending",
                    now.checks.passing, now.checks.failing, now.checks.pending
                ),
            )
        } else if prev.review_decision != now.review_decision {
            (
                "review",
                format!(
                    "review: {}",
                    if now.review_decision.is_empty() {
                        "(cleared)"
                    } else {
                        &now.review_decision
                    }
                ),
            )
        } else if prev.is_draft != now.is_draft {
            (
                "draft",
                if now.is_draft {
                    "converted to draft".to_string()
                } else {
                    "marked ready for review".to_string()
                },
            )
        } else if prev.mergeable != now.mergeable {
            ("updated", format!("mergeable: {}", now.mergeable))
        } else {
            ("updated", "updated".to_string())
        };
        changes.push(PrChange {
            number: pr.number,
            title: pr.title.clone(),
            url: pr.url.clone(),
            kind: kind.into(),
            note,
        });
    }
    let live: std::collections::HashSet<u64> = new_prs.iter().map(|p| p.number).collect();
    for (number, sig) in old {
        if !live.contains(number) {
            changes.push(PrChange {
                number: *number,
                title: sig.title.clone(),
                url: sig.url.clone(),
                kind: "closed".into(),
                note: "closed or merged".into(),
            });
        }
    }
    changes.sort_by_key(|c| c.number);
    changes
}

struct WatchState {
    repos: Vec<WatchRepo>,
    interval: Duration,
    bin: Option<String>,
    /// per project id: last seen PR signatures
    sigs: HashMap<String, HashMap<u64, PrSig>>,
    last_poll: HashMap<String, Instant>,
    ticker_running: bool,
    /// bumped on every (re)configure — an in-flight poll from an OLDER config
    /// discards its result (no cache mutation, no event) instead of emitting
    /// for a repo that was just un-watched / disabled
    generation: u64,
}

static WATCH: Lazy<Mutex<WatchState>> = Lazy::new(|| {
    Mutex::new(WatchState {
        repos: Vec::new(),
        interval: Duration::from_secs(120),
        bin: None,
        sigs: HashMap::new(),
        last_poll: HashMap::new(),
        ticker_running: false,
        generation: 0,
    })
});

/// How often the ticker wakes to see whether any repo is due.
const TICK_SECS: u64 = 15;
/// Floor for the poll interval (Settings can't melt the API).
const MIN_INTERVAL_SECS: u64 = 30;

/// Declaratively (re)configure the watcher: the given repos are polled every
/// `interval_secs`; an EMPTY list stops all polling. State of repos no longer
/// in the list is DROPPED — and since the frontend configures an empty list
/// on disable, a re-enable starts from a fresh SILENT baseline (no replayed
/// changes, no phantom "opened" events). Spawns the ticker once.
pub fn watch_configure(
    app: &AppHandle,
    repos: Vec<WatchRepo>,
    interval_secs: u64,
    bin: Option<String>,
) {
    let mut w = WATCH.lock();
    // drop state of repos no longer watched (a re-add starts from a baseline)
    let keep: std::collections::HashSet<&str> =
        repos.iter().map(|r| r.project_id.as_str()).collect();
    w.sigs.retain(|pid, _| keep.contains(pid.as_str()));
    w.last_poll.retain(|pid, _| keep.contains(pid.as_str()));
    w.generation = w.generation.wrapping_add(1);
    w.repos = repos;
    w.interval = Duration::from_secs(interval_secs.max(MIN_INTERVAL_SECS));
    w.bin = bin;
    if !w.ticker_running {
        w.ticker_running = true;
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(TICK_SECS)).await;
                tick(&app).await;
            }
        });
    }
}

/// One watcher tick: poll every repo whose interval elapsed; emit changes.
async fn tick(app: &AppHandle) {
    let (due, config_gen): (Vec<(WatchRepo, Option<String>)>, u64) = {
        let w = WATCH.lock();
        if !integration_enabled() {
            return; // master toggle off — the watcher stays silent
        }
        let now = Instant::now();
        let due = w
            .repos
            .iter()
            .filter(|r| match w.last_poll.get(&r.project_id) {
                Some(at) => now.duration_since(*at) >= w.interval,
                None => true,
            })
            .map(|r| (r.clone(), w.bin.clone()))
            .collect();
        (due, w.generation)
    };
    for (repo, bin) in due {
        // stamp BEFORE the poll so a slow/failing gh doesn't re-poll every tick
        WATCH
            .lock()
            .last_poll
            .insert(repo.project_id.clone(), Instant::now());
        let dir = repo.dir.clone();
        let result = tauri::async_runtime::spawn_blocking(move || pr_list(&dir, bin.as_deref()))
            .await
            .ok();
        let Some(GhOutcome::Ok(prs)) = result else {
            continue; // typed unavailability / transient error — try next round
        };
        let outcome = {
            let mut w = WATCH.lock();
            // re-check AFTER the await: the config changed (project removed,
            // list reconfigured) or the toggle dropped while gh was in flight
            // → discard the stale poll — no cache mutation, no event
            if w.generation != config_gen
                || !integration_enabled()
                || !w.repos.iter().any(|r| r.project_id == repo.project_id)
            {
                None
            } else {
                let old = w.sigs.get(&repo.project_id).cloned().unwrap_or_default();
                let first = !w.sigs.contains_key(&repo.project_id);
                let changes = diff_pr_sets(&old, &prs, first);
                w.sigs.insert(
                    repo.project_id.clone(),
                    prs.iter().map(|p| (p.number, PrSig::of(p))).collect(),
                );
                Some((changes, first))
            }
        };
        let Some((changes, first_poll)) = outcome else {
            continue;
        };
        // the first poll is a baseline; later polls emit only on real change —
        // but the PR snapshot itself always reaches the frontend cache
        if !changes.is_empty() || first_poll {
            let _ = app.emit(
                "github://pr-changed",
                serde_json::json!({
                    "project_id": repo.project_id,
                    "dir": repo.dir,
                    "prs": prs,
                    "changes": changes,
                    "baseline": first_poll && changes.is_empty(),
                }),
            );
        }
    }
}
