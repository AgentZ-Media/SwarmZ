//! Auto-detected quick commands for a project folder, shown in floating
//! terminals: package.json scripts (package-manager aware via the lockfile),
//! Cargo targets, Makefile and justfile recipes.
//! Keep the detection rules in sync with `/api/project-commands` in
//! `server/index.mjs` (web backend).

use serde::Serialize;
use std::path::Path;

#[derive(Clone, Serialize)]
pub struct DetectedCommand {
    pub label: String,
    pub command: String,
    /// "package.json" | "cargo" | "make" | "just"
    pub source: String,
}

const MAX_PER_SOURCE: usize = 12;
const MAX_TOTAL: usize = 30;

/// Plain [A-Za-z0-9_-] names only — filters file targets (`build/foo.o`),
/// pattern rules (`%.o`) and special targets (`.PHONY`).
fn is_simple_target(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// package.json script names are arbitrary JSON keys. The detected command
/// is written into the shell verbatim on a button click, so a name with an
/// embedded newline (`"dev\nrm -rf ~"`) would render as a harmless-looking
/// button whose click runs a hidden second line. Allow the characters real
/// script names use; everything else is dropped.
fn is_safe_script_name(name: &str) -> bool {
    !name.is_empty()
        && name.chars().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | ':' | '.' | '@' | '/')
        })
}

pub fn detect(cwd: &str) -> Vec<DetectedCommand> {
    let dir = Path::new(cwd);
    let mut out: Vec<DetectedCommand> = Vec::new();

    // package.json scripts, run with the package manager the lockfile implies
    if let Ok(raw) = std::fs::read_to_string(dir.join("package.json")) {
        if let Ok(pkg) = serde_json::from_str::<serde_json::Value>(&raw) {
            let pm = if dir.join("bun.lockb").exists() || dir.join("bun.lock").exists() {
                "bun"
            } else if dir.join("pnpm-lock.yaml").exists() {
                "pnpm"
            } else if dir.join("yarn.lock").exists() {
                "yarn"
            } else {
                "npm"
            };
            if let Some(scripts) = pkg.get("scripts").and_then(|s| s.as_object()) {
                for (name, _) in scripts
                    .iter()
                    .filter(|(name, _)| is_safe_script_name(name))
                    .take(MAX_PER_SOURCE)
                {
                    let command = if pm == "yarn" {
                        format!("yarn {}", name)
                    } else {
                        format!("{} run {}", pm, name)
                    };
                    out.push(DetectedCommand {
                        label: name.clone(),
                        command,
                        source: "package.json".into(),
                    });
                }
            }
        }
    }

    if dir.join("Cargo.toml").exists() {
        for cmd in ["cargo build", "cargo test", "cargo run"] {
            if cmd == "cargo run" && !dir.join("src/main.rs").exists() {
                continue;
            }
            out.push(DetectedCommand {
                label: cmd.into(),
                command: cmd.into(),
                source: "cargo".into(),
            });
        }
    }

    if let Ok(raw) = std::fs::read_to_string(dir.join("Makefile")) {
        let mut n = 0;
        for line in raw.lines() {
            if n >= MAX_PER_SOURCE {
                break;
            }
            // target lines start at column 0; assignments (`FOO = …`, `FOO := …`)
            // and rule bodies (indented) don't
            if line.starts_with(char::is_whitespace) || line.starts_with('#') {
                continue;
            }
            let Some(colon) = line.find(':') else { continue };
            if line[..colon].contains('=') || line[colon + 1..].starts_with('=') {
                continue;
            }
            let name = line[..colon].trim();
            if is_simple_target(name) {
                out.push(DetectedCommand {
                    label: name.into(),
                    command: format!("make {}", name),
                    source: "make".into(),
                });
                n += 1;
            }
        }
    }

    for just in ["justfile", "Justfile", ".justfile"] {
        let Ok(raw) = std::fs::read_to_string(dir.join(just)) else {
            continue;
        };
        let mut n = 0;
        for line in raw.lines() {
            if n >= MAX_PER_SOURCE {
                break;
            }
            if line.starts_with(char::is_whitespace) || line.starts_with('#') {
                continue;
            }
            let Some(colon) = line.find(':') else { continue };
            // `name := value` assignments and `alias x := y` aren't recipes
            if line[colon + 1..].starts_with('=') {
                continue;
            }
            // recipe name is the first token before the colon (rest = params)
            let name = line[..colon].split_whitespace().next().unwrap_or("");
            // leading '_' marks private recipes by just convention
            if is_simple_target(name) && !name.starts_with('_') {
                out.push(DetectedCommand {
                    label: name.into(),
                    command: format!("just {}", name),
                    source: "just".into(),
                });
                n += 1;
            }
        }
        break; // first existing justfile wins
    }

    out.truncate(MAX_TOTAL);
    out
}
