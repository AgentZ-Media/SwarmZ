use super::*;

#[test]
fn environment_copy_manifest_is_explicit() {
    for allowed in [
        ".env",
        ".env.local",
        ".env.test.local",
        ".npmrc",
        ".tool-versions",
        "setup.local.sh",
    ] {
        assert!(environment_manifest_allows(allowed), "{allowed}");
    }
    for refused in [
        "id_rsa",
        "database.sqlite",
        "archive.zip",
        "config.json",
        "secret.key",
    ] {
        assert!(!environment_manifest_allows(refused), "{refused}");
    }
}

#[test]
#[cfg(unix)]
fn environment_git_listing_obeys_its_own_deadline() {
    use std::os::unix::fs::PermissionsExt as _;

    let root = std::env::temp_dir().join(format!(
        "swarmz-env-deadline-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&root).unwrap();
    let fake = root.join("slow-git");
    fs::write(&fake, "#!/bin/sh\nsleep 5\n").unwrap();
    fs::set_permissions(&fake, fs::Permissions::from_mode(0o700)).unwrap();
    let started = Instant::now();
    let err = run_with_timeout(
        &fake.to_string_lossy(),
        &root,
        &["ls-files"],
        Duration::from_millis(100),
    )
    .unwrap_err();
    assert!(err.contains("timed out"), "{err}");
    assert!(started.elapsed() < Duration::from_secs(2));
    fs::remove_dir_all(root).ok();
}

/// Throwaway repo with one commit, a gitignored .env and a node_modules dir.
fn temp_repo() -> PathBuf {
    // timestamp + counter: parallel tests can start in the same clock
    // tick, and a shared dir makes them destroy each other's fixtures
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "swarmz-wt-test-{}-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
    ));
    fs::create_dir_all(&dir).unwrap();
    // git reports canonical paths (macOS /tmp is a symlink) — match that
    let dir = dir.canonicalize().unwrap();
    let git = |args: &[&str]| run(git_bin(None), &dir, args).unwrap();
    git(&["init", "-q", "-b", "main"]);
    git(&["config", "user.email", "t@t"]);
    git(&["config", "user.name", "t"]);
    fs::write(dir.join("a.txt"), "hi").unwrap();
    fs::write(dir.join(".gitignore"), ".env*\nsetup.local.sh\n").unwrap();
    fs::write(dir.join(".env"), "SECRET=1").unwrap();
    fs::create_dir_all(dir.join("node_modules")).unwrap();
    fs::write(dir.join("node_modules/big.js"), "x").unwrap();
    git(&["add", "a.txt", ".gitignore"]);
    git(&["commit", "-qm", "init"]);
    dir
}

#[test]
fn add_status_remove_roundtrip() {
    let repo = temp_repo();
    let cwd = repo.to_string_lossy().into_owned();

    let info = add(&cwd, "test/brave-falcon-7341", true, None, None).unwrap();
    assert_eq!(info.root, cwd);
    assert!(info.path.ends_with(".worktrees/brave-falcon-7341"));
    // env copied, heavyweights skipped
    assert!(Path::new(&info.path).join(".env").exists());
    assert!(!Path::new(&info.path).join("node_modules").exists());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        assert_eq!(
            fs::metadata(Path::new(&info.path).join(".env"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    // .worktrees is excluded locally, main repo stays clean
    assert!(fs::read_to_string(repo.join(".git/info/exclude"))
        .unwrap()
        .contains("/.worktrees/"));

    // fresh worktree: nothing to lose (the copied .env is gitignored)
    let st = status(&info.path, None);
    assert!(st.exists && !st.dirty && st.ahead == 0);

    // dirty tracked file → dirty; own commit → ahead
    fs::write(Path::new(&info.path).join("a.txt"), "changed").unwrap();
    assert!(status(&info.path, None).dirty);
    run(
        git_bin(None),
        Path::new(&info.path),
        &["commit", "-qam", "wt"],
    )
    .unwrap();
    let st = status(&info.path, None);
    assert!(!st.dirty && st.ahead == 1);

    // list finds it under the repo root and reports the root as scanned
    let scan = list(std::slice::from_ref(&cwd), None);
    assert_eq!(scan.scanned, vec![cwd.clone()]);
    assert_eq!(scan.entries.len(), 1);
    assert_eq!(scan.entries[0].branch, "test/brave-falcon-7341");
    assert_eq!(scan.entries[0].ahead, 1);

    // the GATED removal refuses local-only work…
    let err = remove(&cwd, &info.path, &info.branch, false, None).unwrap_err();
    assert!(err.contains("local-only commit"), "{err}");
    assert!(Path::new(&info.path).exists());
    // …force deletes folder + branch even with local-only work
    remove(&cwd, &info.path, &info.branch, true, None).unwrap();
    assert!(!Path::new(&info.path).exists());
    assert!(run(
        git_bin(None),
        &repo,
        &["rev-parse", "--verify", "refs/heads/test/brave-falcon-7341"],
    )
    .is_err());
    assert!(list(&[cwd], None).entries.is_empty());

    fs::remove_dir_all(&repo).ok();
}

#[test]
fn add_can_bind_a_durable_exact_base_sha_instead_of_mutable_head() {
    let repo = temp_repo();
    let cwd = repo.to_string_lossy().into_owned();
    let base = run(git_bin(None), &repo, &["rev-parse", "HEAD"]).unwrap();
    fs::write(repo.join("later.txt"), "later").unwrap();
    run(git_bin(None), &repo, &["add", "later.txt"]).unwrap();
    run(git_bin(None), &repo, &["commit", "-qm", "later"]).unwrap();
    let mutable_head = run(git_bin(None), &repo, &["rev-parse", "HEAD"]).unwrap();
    assert_ne!(base, mutable_head);

    let info = add(&cwd, "test/exact-base", false, Some(&base), None).unwrap();
    let observed = run(git_bin(None), Path::new(&info.path), &["rev-parse", "HEAD"]).unwrap();
    assert_eq!(observed, base);
    assert!(add(&cwd, "test/short-base", false, Some(&base[..12]), None)
        .unwrap_err()
        .contains("base SHA"));
    remove(&info.root, &info.path, &info.branch, false, None).unwrap();
    fs::remove_dir_all(repo).ok();
}

#[test]
fn oversized_manifest_file_is_never_partially_materialized() {
    let repo = temp_repo();
    fs::write(
        repo.join(".env"),
        vec![b'x'; ENV_COPY_MAX_FILE_BYTES as usize + 1],
    )
    .unwrap();
    let cwd = repo.to_string_lossy().into_owned();
    let info = add(&cwd, "test/oversized-env", true, None, None).unwrap();
    assert!(!Path::new(&info.path).join(".env").exists());
    assert_eq!(info.copied, 0);
    fs::remove_dir_all(repo).ok();
}

#[test]
fn gated_remove_refuses_dirt_and_unknown_state() {
    let repo = temp_repo();
    let cwd = repo.to_string_lossy().into_owned();
    let info = add(&cwd, "test/gated", true, None, None).unwrap();

    // dirty tracked file → the gated removal refuses, force succeeds
    fs::write(Path::new(&info.path).join("a.txt"), "changed").unwrap();
    let err = remove(&cwd, &info.path, &info.branch, false, None).unwrap_err();
    assert!(err.contains("uncommitted"), "{err}");
    assert!(Path::new(&info.path).exists());

    // clean again → the gated removal passes (the copied gitignored .env
    // does NOT block a non-force `git worktree remove`)
    fs::write(Path::new(&info.path).join("a.txt"), "hi").unwrap();
    assert!(Path::new(&info.path).join(".env").exists());
    remove(&cwd, &info.path, &info.branch, false, None).unwrap();
    assert!(!Path::new(&info.path).exists());

    // hand-deleted folder + local-only commits → gated refuses branch -D
    let info2 = add(&cwd, "test/gated2", false, None, None).unwrap();
    fs::write(Path::new(&info2.path).join("a.txt"), "wt").unwrap();
    run(
        git_bin(None),
        Path::new(&info2.path),
        &["commit", "-qam", "wt"],
    )
    .unwrap();
    fs::remove_dir_all(&info2.path).unwrap();
    let err = remove(&cwd, &info2.path, &info2.branch, false, None).unwrap_err();
    assert!(err.contains("local-only"), "{err}");
    assert!(
        run(
            git_bin(None),
            &repo,
            &["rev-parse", "--verify", "refs/heads/test/gated2"],
        )
        .is_ok(),
        "the branch must survive the refused gated cleanup"
    );

    fs::remove_dir_all(&repo).ok();
}

#[test]
fn status_marks_uncomputable_ahead_as_unknown() {
    // a plain directory that is NOT a git repo: dirty (can't read) and
    // ahead unknown — the gates must refuse, never treat this as clean
    let dir = std::env::temp_dir().join(format!("swarmz-wt-nogit-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let st = status(&dir.to_string_lossy(), None);
    assert!(st.exists);
    assert!(st.dirty, "unreadable state must count as dirty");
    assert!(st.ahead_unknown, "uncomputable ahead must be flagged");
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn unscannable_root_is_not_reported_as_scanned() {
    let scan = list(&["/nonexistent/swarmz-test-root".into()], None);
    assert!(scan.entries.is_empty());
    assert!(scan.scanned.is_empty());
}

#[test]
fn missing_folder_still_reports_local_only_commits_as_ahead() {
    let repo = temp_repo();
    let cwd = repo.to_string_lossy().into_owned();
    let info = add(&cwd, "test/orphan", false, None, None).unwrap();
    // commit in the worktree, then delete the folder by hand — the
    // branch now holds a commit nothing else reaches
    fs::write(Path::new(&info.path).join("a.txt"), "wt change").unwrap();
    run(
        git_bin(None),
        Path::new(&info.path),
        &["commit", "-qam", "wt"],
    )
    .unwrap();
    fs::remove_dir_all(&info.path).unwrap();

    let scan = list(std::slice::from_ref(&cwd), None);
    assert_eq!(scan.entries.len(), 1);
    let entry = &scan.entries[0];
    assert!(entry.missing);
    // the panel uses ahead > 0 as its "risky, two-step confirm" gate —
    // a hand-deleted folder must not turn branch deletion into one click
    assert_eq!(entry.ahead, 1);

    fs::remove_dir_all(&repo).ok();
}

#[test]
fn add_from_inside_a_worktree_targets_the_main_repo() {
    let repo = temp_repo();
    let cwd = repo.to_string_lossy().into_owned();
    let first = add(&cwd, "test/one", false, None, None).unwrap();
    // splitting from a worktree pane passes the root, but be safe anyway
    let second = add(&first.path, "test/two", false, None, None).unwrap();
    assert_eq!(second.root, cwd);
    assert!(second.path.starts_with(&cwd));
    fs::remove_dir_all(&repo).ok();
}

/// Audit R5 (frozen): the raw remove surface cannot be steered at
/// foreign paths or branches — confinement to `<root>/.worktrees`, git
/// as the identity source, caller branch cross-checked.
#[test]
fn remove_refuses_foreign_paths_and_branch_spoofing() {
    let repo = temp_repo();
    let cwd = repo.to_string_lossy().into_owned();
    let info = add(&cwd, "test/confined", false, None, None).unwrap();

    // (a) paths outside .worktrees refuse — even with force
    for target in [
        cwd.as_str(), // the repo itself
        "/tmp",       // arbitrary host folder
        "/",          // root
        repo.join("src").to_string_lossy().as_ref(),
    ] {
        let err = remove(&cwd, target, "whatever", true, None).unwrap_err();
        assert!(err.contains("refused"), "{target}: {err}");
    }
    // traversal out of .worktrees refuses too
    let sneaky = format!("{}/.worktrees/../..", cwd);
    assert!(remove(&cwd, &sneaky, "x", true, None).is_err());

    // (b) an in-container path git does NOT list refuses
    let fake = repo.join(".worktrees/never-created");
    let err = remove(&cwd, &fake.to_string_lossy(), "x", true, None).unwrap_err();
    assert!(err.contains("no worktree"), "{err}");

    // (c) branch spoofing: the caller naming a FOREIGN branch refuses,
    //     and `main` survives untouched
    let err = remove(&cwd, &info.path, "main", true, None).unwrap_err();
    assert!(err.contains("branch mismatch"), "{err}");
    assert!(run(
        git_bin(None),
        &repo,
        &["rev-parse", "--verify", "refs/heads/main"]
    )
    .is_ok());
    assert!(
        Path::new(&info.path).exists(),
        "the worktree must survive the refusals"
    );

    // (d) the honest call (matching or empty branch) still works
    remove(&cwd, &info.path, "", true, None).unwrap();
    assert!(!Path::new(&info.path).exists());
    assert!(
        run(
            git_bin(None),
            &repo,
            &["rev-parse", "--verify", "refs/heads/test/confined"]
        )
        .is_err(),
        "the derived branch is deleted with the worktree"
    );

    fs::remove_dir_all(&repo).ok();
}

/// The env copy is fd-anchored and manifest-only: escaping symlinks and
/// unrelated untracked files are skipped; an approved regular file is
/// copied with private permissions.
#[test]
#[cfg(unix)]
fn env_copy_is_anchored_and_never_follows_symlinks() {
    let repo = temp_repo();
    let cwd = repo.to_string_lossy().into_owned();
    // an out-of-tree secret and an in-tree UNTRACKED symlink to it
    let outside = std::env::temp_dir().join(format!("swarmz-c7-out-{}", std::process::id()));
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("secret"), "s3cr3t").unwrap();
    std::os::unix::fs::symlink(outside.join("secret"), repo.join("link-to-secret")).unwrap();
    // a normal untracked (gitignored) env file — must copy
    fs::write(repo.join(".env.local"), "TOKEN=xyz").unwrap();
    fs::write(repo.join("setup.local.sh"), "#!/bin/sh\necho ready\n").unwrap();
    use std::os::unix::fs::PermissionsExt as _;
    fs::set_permissions(
        repo.join("setup.local.sh"),
        fs::Permissions::from_mode(0o755),
    )
    .unwrap();

    let info = add(&cwd, "test/c7-anchored", true, None, None).unwrap();
    let dest = Path::new(&info.path);
    // The unrelated symlink is outside the manifest and never appears.
    let copied_link = dest.join("link-to-secret");
    assert!(
        !copied_link.exists(),
        "non-manifest symlinks must not cross into a worktree"
    );
    // the regular untracked file copied through
    assert_eq!(
        fs::read_to_string(dest.join(".env.local")).unwrap(),
        "TOKEN=xyz"
    );
    assert_eq!(
        fs::metadata(dest.join("setup.local.sh"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700,
        "a user-executable runtime file keeps execute, without group/world bits"
    );
    fs::remove_dir_all(&repo).ok();
    fs::remove_dir_all(&outside).ok();
}

/// Audit R4 (frozen): a symlinked `.worktrees` container refuses the add
/// — the checkout and env copy must never be redirected to a host folder.
#[test]
fn add_refuses_a_symlinked_worktrees_container() {
    let repo = temp_repo();
    let cwd = repo.to_string_lossy().into_owned();
    let outside = std::env::temp_dir().join(format!("swarmz-wt-out-{}", std::process::id()));
    fs::create_dir_all(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, repo.join(".worktrees")).unwrap();
    let err = add(&cwd, "test/redirected", true, None, None).unwrap_err();
    assert!(err.contains("symlink"), "{err}");
    fs::remove_dir_all(&repo).ok();
    fs::remove_dir_all(&outside).ok();
}

/// Audits C5+C7 (frozen): the concurrent-attacker simulation. A git
/// wrapper swaps `.worktrees` for a symlink to a foreign folder right
/// AFTER `git worktree add` succeeded — and lands a racing commit on the
/// fresh branch. The add must refuse (the post-add identity
/// re-verification against the ANCHORED container handle catches the
/// swap — the pathname now resolves into the evil target), NO env file
/// may have crossed the swapped path, and the rollback's branch deletion
/// is transactional — the racing commit survives (C5).
#[test]
#[cfg(unix)]
fn add_refuses_swap_after_checkout_and_rollback_is_transactional() {
    use std::os::unix::fs::PermissionsExt;
    let repo = temp_repo();
    let cwd = repo.to_string_lossy().into_owned();
    let root = repo.to_string_lossy().into_owned();
    let scratch = std::env::temp_dir().join(format!(
        "swarmz-c7-swap-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&scratch).unwrap();
    let evil = scratch.join("evil-target");
    fs::create_dir_all(&evil).unwrap();
    // a would-be exfil sink inside evil — if any env copy crossed the
    // swapped path it would land here
    let marker = scratch.join("swapped");
    let real = git_bin(None);
    let branch = "test/swapped";
    let evil_s = evil.to_string_lossy().into_owned();
    let marker_s = marker.to_string_lossy().into_owned();
    // an untracked env file the copy WOULD move if the add didn't refuse
    fs::write(repo.join(".env.local"), "TOKEN=xyz").unwrap();
    let wrapper = scratch.join("git-wrapper.sh");
    // the wrapper passes everything through to real git; on the FIRST
    // `worktree add` it runs it, then swaps `.worktrees` for a symlink to
    // `evil` and lands a racing commit on the new branch (moving its tip)
    let script = format!(
        "#!/bin/sh\n\
             REAL='{real}'\n\
             for a in \"$@\"; do\n\
             \x20 if [ \"$a\" = add ]; then IS_ADD=1; fi\n\
             done\n\
             \"$REAL\" \"$@\"\n\
             RC=$?\n\
             if [ \"$IS_ADD\" = 1 ] && [ ! -f '{marker_s}' ]; then\n\
             \x20 : > '{marker_s}'\n\
             \x20 mv '{root}/.worktrees' '{root}/.wt-moved'\n\
             \x20 ln -s '{evil_s}' '{root}/.worktrees'\n\
             \x20 WT='{root}/.wt-moved/swapped'\n\
             \x20 echo racing > \"$WT/a.txt\"\n\
             \x20 \"$REAL\" -C \"$WT\" commit -qam racing\n\
             fi\n\
             exit $RC\n"
    );
    fs::write(&wrapper, script).unwrap();
    let mut perm = fs::metadata(&wrapper).unwrap().permissions();
    perm.set_mode(0o755);
    fs::set_permissions(&wrapper, perm).unwrap();

    let err = add(&cwd, branch, true, None, Some(&wrapper.to_string_lossy())).unwrap_err();
    assert!(err.contains("redirected"), "{err}");
    // C7: no env file crossed into the evil target
    assert!(
        !evil.join("swapped/.env.local").exists() && !evil.join(".env.local").exists(),
        "an env file was copied through the swapped path"
    );
    // C5: the racing commit survives — the transactional rollback delete
    // (expected-OID = HEAD before the add) refused because the branch tip
    // moved. The branch still exists and holds the racing commit.
    let tip = branch_oid(real, &repo, branch);
    assert!(
        tip.is_some(),
        "the rollback must not delete a branch whose tip moved (racing commit lost)"
    );
    // restore a sane .worktrees for cleanup, then drop everything
    let _ = fs::remove_file(repo.join(".worktrees"));
    fs::remove_dir_all(&repo).ok();
    fs::remove_dir_all(&scratch).ok();
}

/// Final hardening F3 (frozen): the branch deletion is transactional —
/// a tip that MOVED after the OID capture (the race: another process
/// lands a commit between the ahead re-check and the delete) survives;
/// only the expected OID deletes.
#[test]
fn branch_delete_is_transactional_against_oid_movement() {
    let repo = temp_repo();
    let bin = git_bin(None);
    let g = |args: &[&str]| run(bin, &repo, args).unwrap();
    g(&["branch", "swarm/txn"]);
    let oid_a = branch_oid(bin, &repo, "swarm/txn").expect("branch tip");
    // the race: a fresh commit moves the branch tip after the capture
    fs::write(repo.join("a.txt"), "moved").unwrap();
    g(&["add", "a.txt"]);
    g(&["commit", "-qm", "race commit"]);
    g(&["branch", "-f", "swarm/txn", "HEAD"]);
    let oid_b = branch_oid(bin, &repo, "swarm/txn").expect("moved tip");
    assert_ne!(oid_a, oid_b, "the tip must have moved");
    // deleting against the STALE oid fails — the branch (and the new
    // commit) survive
    assert!(
        delete_branch_transactional(bin, &repo, "swarm/txn", &oid_a).is_err(),
        "a moved tip must refuse the delete"
    );
    assert_eq!(
        branch_oid(bin, &repo, "swarm/txn").as_deref(),
        Some(oid_b.as_str()),
        "the branch with the racing commit must survive"
    );
    // against the CURRENT oid the delete goes through
    delete_branch_transactional(bin, &repo, "swarm/txn", &oid_b).unwrap();
    assert!(branch_oid(bin, &repo, "swarm/txn").is_none());
    fs::remove_dir_all(&repo).ok();
}

/// F3 companion: a branch checked out ANYWHERE (worktree or the main
/// checkout) is never deleted — `update-ref -d` would not protect that
/// the way `branch -D` did, so the transactional path re-checks it.
#[test]
fn branch_delete_refuses_checked_out_branches() {
    let repo = temp_repo();
    let bin = git_bin(None);
    let cwd = repo.to_string_lossy().into_owned();
    let info = add(&cwd, "test/checkedout", false, None, None).unwrap();
    let oid = branch_oid(bin, &repo, &info.branch).expect("worktree branch tip");
    let err = delete_branch_transactional(bin, &repo, &info.branch, &oid).unwrap_err();
    assert!(err.contains("checked out"), "{err}");
    assert!(
        branch_oid(bin, &repo, &info.branch).is_some(),
        "branch survives"
    );
    // the main checkout's branch refuses too
    let main_oid = branch_oid(bin, &repo, "main").expect("main tip");
    assert!(delete_branch_transactional(bin, &repo, "main", &main_oid).is_err());
    assert!(branch_oid(bin, &repo, "main").is_some());
    fs::remove_dir_all(&repo).ok();
}

/// Final hardening F9 (frozen): an exclude file beyond the bounded-read
/// cap refuses the rewrite — a truncated-prefix rewrite would silently
/// drop later exclude rules (potentially exposing ignored secrets).
#[test]
fn oversized_exclude_refuses_rewrite() {
    let repo = temp_repo();
    let cwd = repo.to_string_lossy().into_owned();
    // an entry-less exclude just beyond 1 MiB
    let big = format!("# padding\n{}\n", "x".repeat(1024 * 1024));
    fs::write(repo.join(".git/info/exclude"), &big).unwrap();
    let err = add(&cwd, "test/too-big", false, None, None).unwrap_err();
    assert!(err.contains("refusing to rewrite"), "{err}");
    // the exclude file was NOT truncated
    assert_eq!(
        fs::metadata(repo.join(".git/info/exclude")).unwrap().len(),
        big.len() as u64,
        "the oversized exclude must stay untouched"
    );
    // an oversized exclude that ALREADY has the entry needs no rewrite —
    // the add passes
    let big_with_entry = format!("/.worktrees/\n{}\n", "x".repeat(1024 * 1024));
    fs::write(repo.join(".git/info/exclude"), &big_with_entry).unwrap();
    add(&cwd, "test/big-but-present", false, None, None).unwrap();
    fs::remove_dir_all(&repo).ok();
}

/// Audit C1 (frozen): the backend's own git NEVER executes repository-
/// controlled code. The chain this closes: a repo sets `core.hooksPath`
/// at a TRACKED folder (husky style), a workspace agent edits the hook
/// body (a plain sandbox-permitted file edit), and an autonomous
/// `create_worktree` would then run `post-checkout` UNSANDBOXED in the
/// Tauri backend; `git status` would run a configured `core.fsmonitor`
/// hook; the branch cleanup would run `reference-transaction`. With the
/// `git_command` suppressions none of them ever fires.
#[test]
#[cfg(unix)]
fn backend_git_never_fires_repo_hooks() {
    use std::os::unix::fs::PermissionsExt;
    let repo = temp_repo();
    let cwd = repo.to_string_lossy().into_owned();
    let marker = repo.join("HOOK_FIRED");
    let hook_body = format!("#!/bin/sh\n: > \"{}\"\n", marker.display());
    // hooks in BOTH the default dir and a husky-style tracked hooksPath
    let tracked_hooks = repo.join("hooks");
    for dir in [repo.join(".git/hooks"), tracked_hooks.clone()] {
        fs::create_dir_all(&dir).unwrap();
        for name in [
            "post-checkout",
            "post-commit",
            "pre-push",
            "reference-transaction",
            "post-index-change",
        ] {
            let p = dir.join(name);
            fs::write(&p, &hook_body).unwrap();
            let mut perm = fs::metadata(&p).unwrap().permissions();
            perm.set_mode(0o755);
            fs::set_permissions(&p, perm).unwrap();
        }
    }
    let git_raw = |args: &[&str]| {
        // RAW git, deliberately WITHOUT the suppressions — the positive
        // control and the config setup
        let out = std::process::Command::new(git_bin(None))
            .arg("-C")
            .arg(&repo)
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "raw git {args:?} failed");
    };
    git_raw(&["config", "core.hooksPath", "hooks"]);
    // positive control: without suppression the fixture DOES fire —
    // otherwise this test would prove nothing
    git_raw(&["commit", "--allow-empty", "-qm", "control"]);
    assert!(
        marker.exists(),
        "fixture broken: the raw-git positive control did not fire the hook"
    );
    fs::remove_file(&marker).unwrap();
    // a repo-config fsmonitor "hook" (the `git status` execution vector)
    git_raw(&[
        "config",
        "core.fsmonitor",
        &tracked_hooks.join("post-checkout").to_string_lossy(),
    ]);

    // the suppressed surface: worktree add (post-checkout), status
    // (fsmonitor), gated remove incl. transactional branch delete
    // (reference-transaction) — none may fire a hook. copy_env=false so
    // the untracked `hooks/` fixture doesn't dirty the worktree; the
    // status query still exercises the fsmonitor vector.
    let info = add(&cwd, "test/hooks-suppressed", false, None, None).unwrap();
    let st = status(&info.path, None);
    assert!(st.exists && st.ahead == 0, "{st:?}");
    remove(&cwd, &info.path, &info.branch, false, None).unwrap();
    assert!(
        !marker.exists(),
        "a repository-controlled hook ran inside the unsandboxed backend"
    );
    fs::remove_dir_all(&repo).ok();
}

#[test]
fn invalid_branch_and_duplicate_folder_are_rejected() {
    let repo = temp_repo();
    let cwd = repo.to_string_lossy().into_owned();
    assert!(add(&cwd, "bad..name", false, None, None).is_err());
    add(&cwd, "test/dup", false, None, None).unwrap();
    // same slug → same folder → must refuse, not clobber
    assert!(add(&cwd, "other/dup", false, None, None).is_err());
    fs::remove_dir_all(&repo).ok();
}
