// Approval request routing for native Codex sessions.
//
// This module is intentionally pure: it classifies the exact request payload
// captured from app-server and never mutates session state.

use serde_json::Value;

// Approval routing classification (pure — unit-tested, FAIL-CLOSED)
// ---------------------------------------------------------------------------
//
// Phase 4, hardened after the double review: every approval request is
// classified into a routing class the event carries as `escalation`:
//   "routine"     — the Conductor MAY decide it (decide_approval)
//   "destructive" — hard-reserved for the human (Rust refuses the Conductor,
//                   see `session_respond_approval` with `require_routine`)
// FAIL-CLOSED by construction: "routine" is restricted to the sanctioned,
// strictly parsed gh CLI surface. Local shell reads and file changes remain
// human-only because classification and execution are separate app-server
// events: a project can swap a checked path/symlink after classification but
// before the approval response. Until execution is bound to an anchored file
// descriptor or immutable snapshot, autonomous approval would be a TOCTOU
// capability escalation. ANY
// shell metasyntax (pipes, chains, redirects, substitution, escapes), ANY
// unknown or path-prefixed head, ANY parse doubt, a foreign request cwd, a
// sensitive path — all classify as destructive ("im Zweifel Mensch"). A
// false destructive costs one human click; a false routine is unacceptable.
// The human's approval card stays authoritative for BOTH classes.

/// Read-only heads that are routine ONLY after two further gates pass:
/// the per-head flag gate (`rg` can execute programs via `--pre`/
/// `--hostname-bin`, audit R2) and the path-operand confinement (every
/// path-bearing operand must stay inside the session cwd, audit R3). NO
/// interpreters, NO `env`, NO `find`/`xargs`, nothing that writes, moves or
/// executes other programs. `echo` is safe only because the tokenizer
/// already rejects every redirect/substitution around it.
const ROUTINE_READ_HEADS: &[&str] = &[
    "ls", "cat", "head", "tail", "grep", "rg", "wc", "pwd", "which", "echo",
];

/// rg flags that make ripgrep EXECUTE other programs or read through
/// decompressors — never routine (audit R2, fail closed): `--pre <cmd>` /
/// `--pre=<cmd>` runs an arbitrary preprocessor per file, `--pre-glob`
/// selects which files it runs on, `--hostname-bin` runs a program for
/// hyperlink rendering, `-z`/`--search-zip` pipes files through external
/// decompression binaries.
fn rg_args_safe(args: &[String]) -> bool {
    args.iter().all(|a| {
        if !a.starts_with('-') {
            return true; // positionals are gated by the operand confinement
        }
        if a.starts_with("--") {
            // exact or `=`-value spelling of the exec-capable flags
            let name = a.split('=').next().unwrap_or(a);
            !matches!(
                name,
                "--pre" | "--pre-glob" | "--hostname-bin" | "--search-zip"
            )
        } else {
            // short flags may combine (`-iz`): any `z` in a short cluster is
            // --search-zip → human
            !a.chars().skip(1).any(|c| c == 'z')
        }
    })
}

/// Short options of the routine read heads whose VALUE names a FILE the
/// command reads — and which may be ATTACHED to the flag itself in one token
/// (`grep -fpatterns`, `-f<value>`). The attached value is extracted and
/// confined exactly like a bare operand (audit C6): before this, an
/// attached value without `/`, `~` or `..` slipped through uncanonicalized,
/// so an in-cwd symlink `patterns -> /outside/secret` stayed routine.
fn short_path_opts(head: &str) -> &'static [char] {
    match head {
        // grep/rg `-f <file>`: read patterns FROM a file
        "grep" | "rg" => &['f'],
        _ => &[],
    }
}

/// One operand value's confinement (the R3/F4 rules — see
/// `operands_confined`): `~`/`..` refuse, absolute paths must canonicalize
/// into the cwd, relative spellings are cwd-joined and canonicalized
/// (symlink-resolving) and must land back inside.
fn operand_value_confined(val: &str, cwd: &str) -> bool {
    if val.starts_with('~') {
        return false;
    }
    if std::path::Path::new(val)
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return false;
    }
    if val.starts_with('/') {
        return path_within(cwd, val);
    }
    // F4: relative operands resolve against the session cwd — join,
    // canonicalize (symlink-resolving via path_within) and require
    // containment. Non-path tokens (grep patterns, plain words) fold to
    // a missing in-tree leaf and pass; an in-tree symlink pointing out
    // resolves outside and refuses.
    let joined = std::path::Path::new(cwd).join(val);
    path_within(cwd, &joined.to_string_lossy())
}

/// R3 path-operand confinement (fail closed): every operand of an otherwise
/// routine command that CAN address a filesystem path must stay inside the
/// session's cwd (`head` selects the per-command path-bearing short
/// options). Concretely, for each token (flags' `=`-values included):
///   - `~…` (home expansion in the real shell) → human,
///   - any `..` path component → human (traversal is never resolved),
///   - an ABSOLUTE path must canonicalize into the session cwd → else human,
///   - a RELATIVE operand is joined to the session cwd and canonicalized
///     (symlink-resolving) — it must land back inside the cwd (final
///     hardening F4: `cat src/link` with `src/link -> /outside` used to
///     slip through as "relative = safe"; the relative SPELLING of an
///     escaping symlink is exfiltration too).
///
/// Flag tokens themselves (`-la`, `--stat`) pass untouched; a flag's
/// separate value token is checked like any operand, so `grep -f /etc/x`
/// classifies destructive — and an ATTACHED short-option value
/// (`grep -fpatterns`) is extracted and confined the same way (audit C6).
fn operands_confined(head: &str, args: &[String], cwd: &str) -> bool {
    args.iter().all(|tok| {
        // for `--flag=value`, gate the VALUE; bare flags pass
        let val: &str = if let Some(rest) = tok.strip_prefix("--") {
            match rest.split_once('=') {
                Some((_, v)) => v,
                None => return true,
            }
        } else if let Some(body) = tok.strip_prefix('-') {
            // short flags: a path-bearing option char may carry its value
            // ATTACHED in the same token (`-fpatterns`, also inside a
            // cluster: `-if/etc/x`) — extract the remainder and confine it
            // like a bare operand (C6)
            for (i, c) in body.char_indices() {
                if short_path_opts(head).contains(&c) {
                    let attached = &body[i + c.len_utf8()..];
                    if attached.is_empty() {
                        break; // `-f` alone — the next token is checked as an operand
                    }
                    return operand_value_confined(attached, cwd);
                }
            }
            // any other short token smuggling path syntax still refuses
            return !tok.contains('/') && !tok.contains('~') && !tok.contains("..");
        } else {
            tok
        };
        operand_value_confined(val, cwd)
    })
}

/// Substrings that force a command to the human regardless of its head —
/// secrets, credentials and system config are never the Conductor's call.
const SENSITIVE_PATTERNS: &[&str] = &[
    ".env",
    "id_rsa",
    "id_ed25519",
    ".ssh",
    ".aws",
    ".npmrc",
    ".netrc",
    "credentials",
    "secret",
    "keychain",
    "password",
    "token",
    "/etc/",
];

/// Path COMPONENTS that route a fileChange straight to the human (audit C2):
/// VCS control directories — a write into `.git/hooks/…` or `.git/config`
/// arms repository-controlled code execution (git config, hooks, filters,
/// fsmonitor; the backend's own git suppresses the TRIGGER half via
/// `git_command`, this refuses the WRITE half) — plus the Conductor's own
/// `.swarmz` control area (plans are written ONLY through the sanctioned
/// `write_plan` surface). Matched as whole path components, case-insensitive
/// (macOS filesystems are) — `agitator.txt`/`.github` never false-trip.
const PROTECTED_DIR_COMPONENTS: &[&str] = &[".git", ".hg", ".svn", ".swarmz"];

/// Does any component of `p` name a protected control directory?
fn has_protected_component(p: &std::path::Path) -> bool {
    p.components().any(|c| match c {
        std::path::Component::Normal(n) => {
            let s = n.to_string_lossy();
            PROTECTED_DIR_COMPONENTS
                .iter()
                .any(|d| s.eq_ignore_ascii_case(d))
        }
        _ => false,
    })
}

/// C2, both spellings: the RAW path must not touch a protected component,
/// and neither may its SYMLINK-RESOLVED form relative to the session cwd —
/// `hooks/pre-commit` with `hooks -> .git/hooks` lands in `.git` only after
/// canonicalization. Any resolution doubt → protected (fail closed; the
/// containment check would refuse such a path anyway).
fn touches_protected_dir(cwd: &str, raw_path: &str) -> bool {
    if has_protected_component(std::path::Path::new(raw_path)) {
        return true;
    }
    let (Some(c_cwd), Some(c_target)) = (
        crate::fsx::canonicalize_lenient(std::path::Path::new(cwd)),
        crate::fsx::canonicalize_lenient(std::path::Path::new(raw_path)),
    ) else {
        return true;
    };
    match c_target.strip_prefix(&c_cwd) {
        Ok(rel) => has_protected_component(rel),
        // outside the cwd — path_within refuses it independently; treat as
        // protected here so this gate never opens anything on its own
        Err(_) => true,
    }
}

/// Strict quote-aware tokenizer. Returns None (→ destructive) when the
/// command contains ANY shell metasyntax outside single quotes:
/// `| & ; < > ( ) { } $ \` \\` or a newline, or an unterminated quote.
/// Backslash escapes are rejected outright — an escape is exactly how
/// `r\m -rf` style tricks hide a head. `$`/backtick still expand inside
/// DOUBLE quotes, so they are rejected there too; single-quoted content is
/// literal and safe.
pub(crate) fn tokenize_strict(cmd: &str) -> Option<Vec<String>> {
    #[derive(PartialEq)]
    enum St {
        Plain,
        Single,
        Double,
    }
    let mut tokens = Vec::new();
    let mut cur = String::new();
    let mut has_cur = false;
    let mut st = St::Plain;
    for c in cmd.chars() {
        match st {
            St::Plain => match c {
                '\'' => {
                    st = St::Single;
                    has_cur = true;
                }
                '"' => {
                    st = St::Double;
                    has_cur = true;
                }
                '|' | '&' | ';' | '<' | '>' | '(' | ')' | '{' | '}' | '$' | '`' | '\\' | '\n' => {
                    return None
                }
                c if c.is_whitespace() => {
                    if has_cur {
                        tokens.push(std::mem::take(&mut cur));
                        has_cur = false;
                    }
                }
                c => {
                    cur.push(c);
                    has_cur = true;
                }
            },
            St::Single => match c {
                '\'' => st = St::Plain,
                c => cur.push(c),
            },
            St::Double => match c {
                '"' => st = St::Plain,
                '$' | '`' | '\\' => return None,
                c => cur.push(c),
            },
        }
    }
    if st != St::Plain {
        return None; // unterminated quote → unparseable → human
    }
    if has_cur {
        tokens.push(cur);
    }
    Some(tokens)
}

/// Normalize a head token to its bare binary name. Only bare names (PATH
/// lookup) and the standard system dirs pass; ANY other path prefix —
/// `./x`, `/tmp/x`, `node_modules/.bin/x` — is a locally-controlled binary
/// and returns None (→ destructive).
pub(crate) fn normalized_head(token: &str) -> Option<&str> {
    for prefix in ["/bin/", "/usr/bin/"] {
        if let Some(rest) = token.strip_prefix(prefix) {
            return if rest.is_empty() || rest.contains('/') {
                None
            } else {
                Some(rest)
            };
        }
    }
    if token.contains('/') {
        return None;
    }
    Some(token)
}

/// Unwrap EXACTLY `sh|bash|zsh -c|-lc '<one script arg>'` (nothing before,
/// nothing after) to the inner script. Anything else — a foreign binary
/// carrying `-c`, extra args, a second script arg, a path-y flag token —
/// returns None and the OUTER command is classified instead (whose head then
/// fails the allowlist). `env`-prefixed forms never unwrap: `env` can rewrite
/// PATH/DYLD_* and thereby subvert even an allowlisted head, so it is
/// rejected wholesale rather than stripped.
pub(crate) fn unwrap_shell_strict(tokens: &[String]) -> Option<&str> {
    if tokens.len() != 3 {
        return None;
    }
    let head = normalized_head(&tokens[0])?;
    if !matches!(head, "sh" | "bash" | "zsh") {
        return None;
    }
    if !matches!(tokens[1].as_str(), "-c" | "-lc") {
        return None;
    }
    Some(tokens[2].as_str())
}

/// Is this one of the two exact, hook-suppressed Git commands SwarmZ grants
/// to an Orchestrator-owned worktree lane? The live worktree/branch claim is
/// checked separately in sessions.rs. Everything else remains human-only.
pub(crate) fn lane_git_action(params: &Value, branch: &str) -> Option<&'static str> {
    fn starts_with(tokens: &[String], prefix: &[&str]) -> bool {
        tokens.len() >= prefix.len()
            && tokens
                .iter()
                .zip(prefix)
                .all(|(token, expected)| token == expected)
    }

    fn tokens_of(raw: &str, depth: u8) -> Option<Vec<String>> {
        if depth > 2 {
            return None;
        }
        let tokens = tokenize_strict(raw)?;
        if let Some(inner) = unwrap_shell_strict(&tokens) {
            return tokens_of(inner, depth + 1);
        }
        Some(tokens)
    }

    let raw = params.get("command")?.as_str()?;
    let tokens = tokens_of(raw, 0)?;
    if normalized_head(tokens.first()?)? != "git" {
        return None;
    }
    let args = &tokens[1..];
    const LOCAL_PREFIX: &[&str] = &[
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.pager=cat",
        "-c",
        "protocol.allow=never",
        "-c",
        "commit.gpgSign=false",
        "commit",
    ];
    const PUSH_PREFIX: &[&str] = &[
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.pager=cat",
        "-c",
        "protocol.ext.allow=never",
        "-c",
        "core.sshCommand=ssh",
        "push",
    ];
    if starts_with(args, LOCAL_PREFIX) {
        let rest = &args[LOCAL_PREFIX.len()..];
        // Positive grammar only: no editor/template/pathspec/config surface.
        // Staging remains a separate approval because `git add` may execute
        // repository-configured clean filters.
        return (rest.len() == 3
            && rest[0] == "--no-verify"
            && matches!(rest[1].as_str(), "-m" | "--message")
            && !rest[2].is_empty()
            && rest[2].len() <= 4_096
            && !rest[2].chars().any(char::is_control))
        .then_some("commit");
    }
    if starts_with(args, PUSH_PREFIX) {
        let mut rest = &args[PUSH_PREFIX.len()..];
        if matches!(
            rest.first().map(String::as_str),
            Some("-u" | "--set-upstream")
        ) {
            rest = &rest[1..];
        }
        if rest.len() != 2 || rest[0] != "origin" {
            return None;
        }
        let refspec = rest[1].as_str();
        return (refspec == branch || refspec == format!("HEAD:{branch}")).then_some("push");
    }
    None
}

/// Is this full command line routine? Pure, fail-closed, recursion-bounded.
/// `cwd` is the session's TRUSTED working directory — every path-bearing
/// operand of a routine candidate must stay inside it (audit R3).
/// `gh_writes` = the Rust-side gh-write gate (Phase 7 master toggle AND the
/// Phase-8/final-hardening autonomous-writes opt-in): with it ON, the two
/// sanctioned gh WRITE forms (`gh pr comment`, `gh pr review`) may be
/// routine; with it OFF every gh write is destructive. Read-only gh commands
/// are routine either way.
pub(crate) fn command_is_routine(raw: &str, cwd: &str, gh_writes: bool) -> bool {
    // secrets/system-config are never the Conductor's call, wrapped or not
    let lower = raw.to_lowercase();
    if SENSITIVE_PATTERNS.iter().any(|p| lower.contains(p)) {
        return false;
    }
    classify_command_str(raw, cwd, 0, gh_writes)
}

fn classify_command_str(raw: &str, cwd: &str, depth: u8, gh_writes: bool) -> bool {
    if depth > 2 {
        return false; // nested wrappers beyond sh -c 'sh -c …' → human
    }
    let Some(tokens) = tokenize_strict(raw) else {
        return false;
    };
    if tokens.is_empty() {
        return false;
    }
    // a genuine shell wrapper is unwrapped and its SCRIPT is classified
    if let Some(inner) = unwrap_shell_strict(&tokens) {
        return classify_command_str(inner, cwd, depth + 1, gh_writes);
    }
    let Some(head) = normalized_head(&tokens[0]) else {
        return false;
    };
    let args = &tokens[1..];
    // R3: every routine candidate EXCEPT gh runs the operand confinement —
    // an absolute/`~`/`..` operand outside the session cwd retargets even a
    // read-only head (`cat /Users/x/Documents/…` is exfiltration). gh has
    // its own strict parser (numeric selectors only, no path flags), and its
    // free-text `--body` values must not false-trip on a path-shaped word.
    if head != "gh" && !operands_confined(head, args, cwd) {
        return false;
    }
    if ROUTINE_READ_HEADS.contains(&head) {
        // R2: rg can execute programs via --pre/--hostname-bin/--search-zip
        return head != "rg" || rg_args_safe(args);
    }
    match head {
        // Even apparently read-only shell git commands can execute
        // repository-controlled config (aliases, textconv/ext-diff, filters,
        // fsmonitor, pager) outside the backend's hardened `git_command`
        // builder. Agent-originated shell git is therefore always a human
        // decision. Read-only status for the Conductor uses the native Rust
        // git surface instead.
        "git" => false,
        // GitHub CLI (Phase 7) — tiny read allowlist + the two gated writes
        "gh" => gh_is_routine(args, gh_writes),
        // Build/test/script runners (`cargo`, `pnpm`, `npm`, `yarn`, `tsc`,
        // `node`, `make`, …) are NEVER routine (final hardening F1). The old
        // rationale ("they run under codex' workspace-write sandbox") was
        // FALSE: under workspace-write + on-request a command approval only
        // exists for a SANDBOX-ESCALATING run (live-verified — see the
        // sessions_spike (b) comment and docs/codex-protocol/inventory.md
        // §5: in-workspace commands run WITHOUT approval). An approved
        // build/test therefore executes UNSANDBOXED — network on, no write
        // confinement — and runs project-controlled code (build.rs, test
        // scripts, compiler plugins). That is arbitrary code execution with
        // host authority and stays a human decision. Only genuinely inert
        // version probes of SYSTEM binaries remain routine.
        "node" => args.len() == 1 && matches!(args[0].as_str(), "--version" | "-v"),
        _ => false,
    }
}

/// Final-hardening F1 defense-in-depth: does the approval request carry a
/// proposed execpolicy amendment? On 0.144.1 that field rides on approvals
/// that ask to ESCALATE past the sandbox (see docs/codex-protocol/
/// inventory.md §5) — an allowlisted read-only head has no business asking
/// for one, so its presence forces the request to the human REGARDLESS of
/// how harmless the command text looks. The gh flows are exempt: gh always
/// needs the network escalation, and they are separately double-opt-in
/// gated (integration master toggle + autonomous-writes opt-in) and
/// strictly parsed.
fn amendment_forces_human(params: &Value, cwd: &str) -> bool {
    let has_amendment = match params.get("proposedExecpolicyAmendment") {
        None | Some(Value::Null) => false,
        Some(Value::Array(a)) => !a.is_empty(),
        Some(_) => true, // unknown shape → treat as present (fail closed)
    };
    if !has_amendment {
        return false;
    }
    // exempt ONLY a command whose (unwrapped) head is gh
    let is_gh = params
        .get("command")
        .and_then(|c| c.as_str())
        .map(|raw| command_head_is_gh(raw, cwd))
        .unwrap_or(false);
    !is_gh
}

/// Does the command line's effective head (after the strict shell unwrap)
/// normalize to `gh`? Pure helper for the amendment exemption above.
fn command_head_is_gh(raw: &str, _cwd: &str) -> bool {
    fn head_of(raw: &str, depth: u8) -> Option<String> {
        if depth > 2 {
            return None;
        }
        let tokens = tokenize_strict(raw)?;
        if tokens.is_empty() {
            return None;
        }
        if let Some(inner) = unwrap_shell_strict(&tokens) {
            return head_of(inner, depth + 1);
        }
        normalized_head(&tokens[0]).map(str::to_string)
    }
    head_of(raw, 0).as_deref() == Some("gh")
}

/// Parse gh tokens after a subcommand against a flag spec `(flag,
/// takes_value)`. Returns `(positionals, seen_flags)` — the positional tokens
/// plus the canonical names of the flags that appeared — or None when ANY
/// dash token is off the allowlist (fail closed). A value-taking flag in its
/// `--flag value` spelling CONSUMES the next token, so flag values are never
/// mistaken for positionals (and a value can never smuggle an action flag).
fn gh_parse_args<'a>(
    rest: &'a [String],
    allowed: &[(&'static str, bool)],
) -> Option<(Vec<&'a str>, Vec<&'static str>)> {
    let mut positionals = Vec::new();
    let mut seen = Vec::new();
    let mut i = 0;
    while i < rest.len() {
        let tok = rest[i].as_str();
        if tok.starts_with('-') {
            let spec = allowed
                .iter()
                .find(|(f, _)| tok == *f || tok.starts_with(&format!("{f}=")));
            let (flag, takes_value) = spec?;
            seen.push(*flag);
            if *takes_value && tok == *flag {
                i += 1; // `--flag value` spelling: skip the value token
            }
        } else {
            positionals.push(tok);
        }
        i += 1;
    }
    Some((positionals, seen))
}

/// A gh selector positional the classification accepts: NOTHING (gh targets
/// the current branch's PR — inside the session repo) or ONE bare NUMBER.
/// gh also accepts URLs and branch names as selectors — a URL RETARGETS the
/// command at an arbitrary foreign repo (`gh pr comment <url>` would post,
/// `gh pr review <url> --approve` would approve, anywhere on the host), so
/// URLs, branches and extra positionals all classify destructive.
fn gh_selector_ok(positionals: &[&str]) -> bool {
    match positionals {
        [] => true,
        [n] => !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()),
        _ => false,
    }
}

/// Read-only formatting/filter flags of the gh read subcommands. NO `--web`
/// (opens a browser), NO `-R/--repo` (retargets to arbitrary repos), NO
/// `--body-file`-style file readers. `true` = the flag takes a value.
const GH_READ_FLAGS: &[(&str, bool)] = &[
    ("--json", true),
    ("--jq", true),
    ("--limit", true),
    ("--state", true),
    ("--comments", false),
];

/// Do the args parse against the read-flag allowlist WITHOUT any positional?
/// (list-style reads take no selector; `gh repo view <owner/repo>` would
/// retarget, so repo view is positional-free too.)
fn gh_read_no_positional(rest: &[String]) -> bool {
    matches!(gh_parse_args(rest, GH_READ_FLAGS), Some((p, _)) if p.is_empty())
}

/// Read-flag allowlist plus at most one bare-number selector.
fn gh_read_numeric_selector(rest: &[String]) -> bool {
    matches!(gh_parse_args(rest, GH_READ_FLAGS), Some((p, _)) if gh_selector_ok(&p))
}

/// Conservative gh classification (Phase 7, fail-closed like everything here):
/// - read-only queries of the CURRENT repo are routine unconditionally
///   (`gh pr list|view|diff|checks|status`, `gh repo view`, `gh auth status`,
///   `gh issue list|view`, `gh run list|view`)
/// - `gh pr comment --body …` and `gh pr review --approve|--request-changes|
///   --comment [--body …]` are routine ONLY while the GitHub integration is
///   enabled (`gh_writes`)
/// - EVERYTHING else is destructive: merge, close, create, ready, edit,
///   `gh api` (any method), repo/release/secret/workflow/alias mutations,
///   unknown subcommands, unknown flags, `--body-file` (file exfiltration),
///   and ANY non-numeric selector positional — gh accepts `<number>|<url>|
///   <branch>`, and a URL retargets the command at an arbitrary FOREIGN repo
///   (comment/review/read anywhere), so only bare numbers (or absence) pass.
fn gh_is_routine(args: &[String], gh_writes: bool) -> bool {
    let Some(group) = args.first() else {
        return false; // bare `gh` → human
    };
    if group.starts_with('-') {
        return false;
    }
    let rest = &args[1..];
    match group.as_str() {
        "auth" => {
            rest.first().map(|s| s.as_str()) == Some("status")
                && matches!(
                    gh_parse_args(
                        &rest[1..],
                        &[("--json", true), ("--jq", true), ("--active", false), ("-a", false)],
                    ),
                    Some((p, _)) if p.is_empty()
                )
        }
        "pr" => {
            let Some(sub) = rest.first() else {
                return false;
            };
            if sub.starts_with('-') {
                return false;
            }
            let flags = &rest[1..];
            match sub.as_str() {
                // list-style reads take no selector at all
                "list" | "status" => gh_read_no_positional(flags),
                // selector reads: at most one BARE NUMBER (a URL/branch
                // selector reads a foreign repo → human)
                "view" | "diff" | "checks" => gh_read_numeric_selector(flags),
                // gated writes: only with the integration enabled, only the
                // exact sanctioned flag shapes, only a numeric selector —
                // `gh pr comment <url> --body …` would post into ANY repo
                "comment" => {
                    gh_writes
                        && matches!(
                            gh_parse_args(flags, &[("--body", true), ("-b", true)]),
                            Some((p, _)) if gh_selector_ok(&p)
                        )
                }
                "review" => {
                    if !gh_writes {
                        return false;
                    }
                    let Some((positionals, seen)) = gh_parse_args(
                        flags,
                        &[
                            ("--approve", false),
                            ("-a", false),
                            ("--request-changes", false),
                            ("-r", false),
                            ("--comment", false),
                            ("-c", false),
                            ("--body", true),
                            ("-b", true),
                        ],
                    ) else {
                        return false;
                    };
                    let actions = seen
                        .iter()
                        .filter(|f| {
                            matches!(
                                **f,
                                "--approve"
                                    | "-a"
                                    | "--request-changes"
                                    | "-r"
                                    | "--comment"
                                    | "-c"
                            )
                        })
                        .count();
                    actions == 1 && gh_selector_ok(&positionals)
                }
                // merge / close / create / ready / edit / checkout / lock / … → human
                _ => false,
            }
        }
        // `gh repo view <owner/repo>` retargets — positionals are forbidden,
        // only the session repo's own view is routine
        "repo" => {
            rest.first().map(|s| s.as_str()) == Some("view") && gh_read_no_positional(&rest[1..])
        }
        "issue" => match rest.first().map(|s| s.as_str()) {
            Some("list") => gh_read_no_positional(&rest[1..]),
            Some("view") => gh_read_numeric_selector(&rest[1..]),
            _ => false,
        },
        "run" => match rest.first().map(|s| s.as_str()) {
            Some("list") => gh_read_no_positional(&rest[1..]),
            Some("view") => gh_read_numeric_selector(&rest[1..]),
            _ => false,
        },
        // `gh api` (any method — even GET can hit mutating GraphQL), release,
        // gist, secret, workflow, alias, extension, … → human
        _ => false,
    }
}

// Path containment (fold/canonicalize/path_within) lives in `crate::fsx` —
// shared with the worktree confinement (audit R3/R5).
use crate::fsx::path_within;

/// Are all of a fileChange approval's changes routine? Routine requires EVERY
/// change to be (a) a pure create (`add` of a not-yet-existing path) or an
/// in-place edit (`update` without a rename/move), AND (b) strictly inside
/// the session's canonicalized cwd, AND (c) free of sensitive path parts,
/// AND (d) free of protected control-dir components (`.git`/`.hg`/`.svn`/
/// `.swarmz` — audit C2: a create of `.git/hooks/pre-commit` or an edit of
/// `.git/config` arms repo-controlled execution and is never autonomous).
/// Deletes, renames, overwriting adds, unknown kinds, traversal, symlinks
/// out of the tree → human.
pub(crate) fn file_changes_within(params: &Value, cwd: &str) -> bool {
    let Some(changes) = params.get("changes").and_then(|c| c.as_array()) else {
        return false; // no paths to judge → human
    };
    if changes.is_empty() {
        return false;
    }
    changes.iter().all(|c| {
        let Some(path) = c.get("path").and_then(|p| p.as_str()) else {
            return false;
        };
        let kind_ok = match c
            .get("kind")
            .and_then(|k| k.get("type"))
            .and_then(|t| t.as_str())
        {
            // a pure create — an `add` over an EXISTING file is an overwrite
            Some("add") => !std::path::Path::new(path).exists(),
            // an in-place edit — an update carrying a move/rename target is
            // a rename (both wire spellings checked, fail closed)
            Some("update") => {
                let mv = c
                    .get("kind")
                    .and_then(|k| k.get("movePath").or_else(|| k.get("move_path")));
                matches!(mv, None | Some(Value::Null))
            }
            _ => false, // delete / unknown / missing kind → human
        };
        let lower = path.to_lowercase();
        let sensitive = SENSITIVE_PATTERNS.iter().any(|s| lower.contains(s));
        kind_ok && !sensitive && !touches_protected_dir(cwd, path) && path_within(cwd, path)
    })
}

/// Classify one approval request for Conductor routing. `kind` is the
/// approval flavor from `approval_kind`, `params` the raw request params,
/// `cwd` the session's working directory (the trusted profile value, not
/// anything model-supplied). `gh_writes` = the Rust-side gh-write gate
/// (integration master toggle AND autonomous-writes opt-in) — with it OFF,
/// gh write commands are always destructive.
pub fn classify_approval(kind: &str, params: &Value, cwd: &str, gh_writes: bool) -> &'static str {
    let routine = match kind {
        "command" => {
            // Security boundary: only the sanctioned gh surface remains
            // autonomous. Even read-only local commands are human-only until
            // app-server offers execution binding for the classified request;
            // cwd/path canonicalization alone cannot close the check/use race.
            let is_gh = params
                .get("command")
                .and_then(|c| c.as_str())
                .map(|c| command_head_is_gh(c, cwd))
                .unwrap_or(false);
            if !is_gh {
                return "destructive";
            }
            // F1 defense-in-depth: a proposed execpolicy amendment marks a
            // sandbox-escalation request — human-only for every non-gh head,
            // whatever the command text claims to be
            if amendment_forces_human(params, cwd) {
                return "destructive";
            }
            let cmd_ok = params
                .get("command")
                .and_then(|c| c.as_str())
                .map(|c| command_is_routine(c, cwd, gh_writes))
                .unwrap_or(false);
            // the REQUEST's cwd (when present) must sit inside the session's
            // assigned directory — a foreign cwd retargets even a read-only
            // command ({command:"touch owned", cwd:"/etc"} stays human)
            let cwd_ok = match params.get("cwd") {
                None | Some(Value::Null) => true,
                Some(Value::String(c)) => path_within(cwd, c),
                Some(_) => false,
            };
            cmd_ok && cwd_ok
        }
        // The target can be replaced with a symlink between this check and
        // execution. Keep the strict parser for tests/diagnostics, but never
        // grant autonomous authority from this preflight result.
        "fileChange" => {
            let _ = file_changes_within(params, cwd);
            false
        }
        _ => false,
    };
    if routine {
        "routine"
    } else {
        "destructive"
    }
}
