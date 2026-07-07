// Orchestrator tool registry (Phase 2) — the SINGLE source of truth for the
// tool catalog: names, LLM-facing descriptions, JSON-Schema parameters and
// per-tool timeouts. Phase 3 hands `tool_definitions()` to the Codex
// app-server as `dynamicTools`; Phase 6 hands the same list to an OpenRouter
// tool loop. The frontend mirrors the NAMES only (executor lookup) — schemas
// live here and nowhere else.

use serde::Serialize;
use serde_json::{json, Value};

/// Default roundtrip budget: the webview executors are store lookups plus at
/// most one sensing command — anything slower is a bug.
pub const DEFAULT_TIMEOUT_MS: u64 = 15_000;
/// `create_panes` may create git worktrees (subprocesses + env-file copies)
/// and waits for agent CLIs to boot before delivering startup prompts.
const CREATE_PANES_TIMEOUT_MS: u64 = 120_000;

#[derive(Debug, Clone, Serialize)]
pub struct ToolDefinition {
    pub name: &'static str,
    pub description: &'static str,
    /// JSON Schema of the arguments object.
    pub parameters: Value,
    pub timeout_ms: u64,
}

fn empty_params() -> Value {
    json!({ "type": "object", "properties": {} })
}

/// The V1 tool catalog. Built fresh per call (it serializes straight into
/// provider payloads); callers cache if they need to.
pub fn tool_definitions() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition {
            name: "fleet_snapshot",
            description: "Current state of the whole fleet: every workspace with its agent panes (runtime, project, branch, busy/idle/waiting activity, model, context usage) plus a one-line summary. Cheap — call this first to orient yourself and to learn valid pane ids.",
            parameters: empty_params(),
            timeout_ms: DEFAULT_TIMEOUT_MS,
        },
        ToolDefinition {
            name: "read_transcript",
            description: "Read the conversation tail of one agent pane's session: user/assistant messages, one-line tool summaries, compaction summaries, and optionally the session's first user prompt. Fails for shell panes and panes whose session has not been discovered yet.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "pane_id": { "type": "string", "description": "agent pane id (from fleet_snapshot)" },
                    "tail_messages": { "type": "integer", "description": "return only the last N messages (default 20)" },
                    "include_first_user_message": { "type": "boolean", "description": "also return the session's original first user prompt (default true)" }
                },
                "required": ["pane_id"]
            }),
            timeout_ms: DEFAULT_TIMEOUT_MS,
        },
        ToolDefinition {
            name: "read_project_docs",
            description: "README.md / AGENTS.md / CLAUDE.md of a project root, content capped. Pass EXACTLY ONE of pane_id (the pane's project root; worktree panes resolve to their main repo) or path (an absolute folder).",
            parameters: json!({
                "type": "object",
                "properties": {
                    "pane_id": { "type": "string", "description": "agent pane id — reads the docs of that pane's project root" },
                    "path": { "type": "string", "description": "absolute path of a project folder" }
                }
            }),
            timeout_ms: DEFAULT_TIMEOUT_MS,
        },
        ToolDefinition {
            name: "read_notes",
            description: "The user's quick notes (checklists): the global list plus one list per project folder. Items are { text, done }.",
            parameters: empty_params(),
            timeout_ms: DEFAULT_TIMEOUT_MS,
        },
        ToolDefinition {
            name: "git_status",
            description: "Cached git snapshot of one pane's working directory: branch, inserted/deleted lines, untracked files, derived dirty flag. Returns git: null with a note when the folder is not a git repo (or not polled yet).",
            parameters: json!({
                "type": "object",
                "properties": {
                    "pane_id": { "type": "string", "description": "agent pane id (from fleet_snapshot)" }
                },
                "required": ["pane_id"]
            }),
            timeout_ms: DEFAULT_TIMEOUT_MS,
        },
        ToolDefinition {
            name: "list_projects",
            description: "Discover the user's project folders: Claude/Codex session history, folders the app already knows, and a shallow scan of extra roots for git repos. When scan_roots is omitted, the user's configured default scan folders are used. Sorted by last activity, most recent first.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "scan_roots": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "extra folders to shallow-scan for git repositories (absolute paths)"
                    }
                }
            }),
            timeout_ms: DEFAULT_TIMEOUT_MS,
        },
        ToolDefinition {
            name: "list_blueprints",
            description: "Reusable launch blueprints: agent profiles (id, name, runtime, startup command, default folder), workspace presets (id, name, pane templates), plus per-runtime info: the default startup command and recently used model ids (from real usage on this machine — directly usable as create_panes model). Use profile ids / preset shapes / model ids when creating panes.",
            parameters: empty_params(),
            timeout_ms: DEFAULT_TIMEOUT_MS,
        },
        ToolDefinition {
            name: "prompt_pane",
            description: "Type a prompt into an agent pane's terminal (bracketed paste) and optionally submit it with Enter. Works on running panes only. A busy pane still receives the text — it queues in the CLI's input — and the response carries a warning then.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "pane_id": { "type": "string", "description": "agent pane id (from fleet_snapshot)" },
                    "text": { "type": "string", "description": "the prompt/command text to deliver" },
                    "submit": { "type": "boolean", "description": "press Enter after pasting (default true)" }
                },
                "required": ["pane_id", "text"]
            }),
            timeout_ms: DEFAULT_TIMEOUT_MS,
        },
        ToolDefinition {
            name: "create_panes",
            description: "Create 1–8 new agent panes in a workspace. Each pane gets a working directory, optionally a runtime or profile, a model override (omit = the user's default configuration), a name, an initial prompt (delivered once the agent CLI is ready), and optionally a fresh git worktree (own branch + folder under <repo>/.worktrees/). A worktree request on a non-repo folder FAILS for that pane — it is never silently downgraded to a plain pane. Per-pane errors do not abort the batch.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "workspace_id": { "type": "string", "description": "target workspace id (default: the active workspace)" },
                    "panes": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 8,
                        "items": {
                            "type": "object",
                            "properties": {
                                "cwd": { "type": "string", "description": "absolute working directory for the pane" },
                                "runtime": { "type": "string", "enum": ["claude", "codex", "shell"], "description": "agent CLI to launch (default: the app's default runtime)" },
                                "profile_id": { "type": "string", "description": "launch profile id (from list_blueprints) — sets runtime + startup command" },
                                "model": { "type": "string", "description": "model id for the agent CLI (claude: --model, codex: -m). Use ids from list_blueprints runtimes.*.recently_used_models when the user names a model; OMIT for the user's default configuration" },
                                "reasoning": { "type": "string", "enum": ["minimal", "low", "medium", "high", "xhigh"], "description": "codex only: model_reasoning_effort — omit unless the user asks for it" },
                                "name": { "type": "string", "description": "pane name (default: auto)" },
                                "prompt": { "type": "string", "description": "initial prompt, submitted once the agent is ready" },
                                "worktree": { "type": "boolean", "description": "create a fresh git worktree off the repo at cwd and run the pane inside it" },
                                "branch": { "type": "string", "description": "worktree branch name (default: a generated one)" }
                            },
                            "required": ["cwd"]
                        }
                    }
                },
                "required": ["panes"]
            }),
            timeout_ms: CREATE_PANES_TIMEOUT_MS,
        },
        ToolDefinition {
            name: "create_workspace",
            description: "Create a new (empty) workspace tab. Returns its id — use it as workspace_id in create_panes.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "tab name (default: auto-numbered / named after the first project)" },
                    "default_cwd": { "type": "string", "description": "default working directory prefilled for new panes in this workspace" }
                }
            }),
            timeout_ms: DEFAULT_TIMEOUT_MS,
        },
    ]
}

pub fn find_tool(name: &str) -> Option<ToolDefinition> {
    tool_definitions().into_iter().find(|t| t.name == name)
}

pub fn tool_names() -> Vec<&'static str> {
    tool_definitions().iter().map(|t| t.name).collect()
}

// ---- lightweight argument validation ----
//
// Deliberately NOT a JSON-Schema implementation (no jsonschema crate — the
// schemas above are consumed by LLM providers, we only sanity-check what a
// model sends back): required properties, basic `type` tags, `enum` values
// and array `minItems`/`maxItems`/`items`, applied recursively through
// `properties`/`items`. Anything the checker doesn't know is accepted.

fn type_matches(expected: &str, value: &Value) -> bool {
    match expected {
        "string" => value.is_string(),
        "boolean" => value.is_boolean(),
        "integer" => value.is_i64() || value.is_u64(),
        "number" => value.is_number(),
        "array" => value.is_array(),
        "object" => value.is_object(),
        "null" => value.is_null(),
        _ => true,
    }
}

fn validate_value(schema: &Value, value: &Value, path: &str) -> Result<(), String> {
    if let Some(expected) = schema.get("type").and_then(|t| t.as_str()) {
        if !type_matches(expected, value) {
            return Err(format!("{path}: expected {expected}"));
        }
    }
    if let Some(allowed) = schema.get("enum").and_then(|e| e.as_array()) {
        if !allowed.contains(value) {
            return Err(format!("{path}: must be one of {allowed:?}"));
        }
    }
    if let Some(obj) = value.as_object() {
        if let Some(required) = schema.get("required").and_then(|r| r.as_array()) {
            for key in required.iter().filter_map(|k| k.as_str()) {
                if !obj.contains_key(key) {
                    return Err(format!("{path}: missing required property \"{key}\""));
                }
            }
        }
        if let Some(props) = schema.get("properties").and_then(|p| p.as_object()) {
            for (key, sub) in props {
                if let Some(v) = obj.get(key) {
                    validate_value(sub, v, &format!("{path}.{key}"))?;
                }
            }
        }
    }
    if let Some(arr) = value.as_array() {
        if let Some(min) = schema.get("minItems").and_then(|m| m.as_u64()) {
            if (arr.len() as u64) < min {
                return Err(format!("{path}: needs at least {min} item(s)"));
            }
        }
        if let Some(max) = schema.get("maxItems").and_then(|m| m.as_u64()) {
            if (arr.len() as u64) > max {
                return Err(format!("{path}: allows at most {max} item(s)"));
            }
        }
        if let Some(items) = schema.get("items") {
            for (i, v) in arr.iter().enumerate() {
                validate_value(items, v, &format!("{path}[{i}]"))?;
            }
        }
    }
    Ok(())
}

/// Validate a tool call's argument object against the tool's schema.
pub fn validate_args(def: &ToolDefinition, args: &Value) -> Result<(), String> {
    if !args.is_object() {
        return Err(format!(
            "invalid arguments for \"{}\": expected a JSON object",
            def.name
        ));
    }
    validate_value(&def.parameters, args, "args")
        .map_err(|e| format!("invalid arguments for \"{}\": {e}", def.name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_has_all_ten_tools_and_serializes() {
        let defs = tool_definitions();
        let names: Vec<&str> = defs.iter().map(|d| d.name).collect();
        for expected in [
            "fleet_snapshot",
            "read_transcript",
            "read_project_docs",
            "read_notes",
            "git_status",
            "list_projects",
            "list_blueprints",
            "prompt_pane",
            "create_panes",
            "create_workspace",
        ] {
            assert!(names.contains(&expected), "missing tool {expected}");
        }
        assert_eq!(defs.len(), 10);
        // serializable — this exact shape is handed to Codex dynamicTools later
        let json = serde_json::to_value(&defs).expect("serialize");
        for def in json.as_array().unwrap() {
            assert!(def["name"].is_string());
            assert!(def["description"].is_string());
            assert!(def["parameters"]["type"] == "object");
            assert!(def["timeout_ms"].is_u64());
        }
    }

    #[test]
    fn required_args_are_enforced() {
        let def = find_tool("prompt_pane").unwrap();
        let err = validate_args(&def, &json!({ "pane_id": "abc" })).unwrap_err();
        assert!(err.contains("text"), "unexpected error: {err}");
        assert!(validate_args(&def, &json!({ "pane_id": "abc", "text": "hi" })).is_ok());
    }

    #[test]
    fn basic_types_are_enforced() {
        let def = find_tool("prompt_pane").unwrap();
        let err = validate_args(&def, &json!({ "pane_id": "abc", "text": 5 })).unwrap_err();
        assert!(err.contains("expected string"), "unexpected error: {err}");
        let err = validate_args(&def, &json!("not an object")).unwrap_err();
        assert!(err.contains("JSON object"), "unexpected error: {err}");
    }

    #[test]
    fn nested_array_items_are_checked() {
        let def = find_tool("create_panes").unwrap();
        // empty batch → minItems
        let err = validate_args(&def, &json!({ "panes": [] })).unwrap_err();
        assert!(err.contains("at least 1"), "unexpected error: {err}");
        // per-item required cwd
        let err = validate_args(&def, &json!({ "panes": [{ "name": "x" }] })).unwrap_err();
        assert!(err.contains("cwd"), "unexpected error: {err}");
        // enum on runtime
        let err = validate_args(
            &def,
            &json!({ "panes": [{ "cwd": "/tmp/x", "runtime": "bash" }] }),
        )
        .unwrap_err();
        assert!(err.contains("one of"), "unexpected error: {err}");
        assert!(validate_args(
            &def,
            &json!({ "panes": [{ "cwd": "/tmp/x", "runtime": "codex", "worktree": true }] })
        )
        .is_ok());
    }
}
