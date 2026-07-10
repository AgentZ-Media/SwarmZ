// Orchestrator tool registry — the SINGLE source of truth for the tool
// catalog: names, LLM-facing descriptions, JSON-Schema parameters and
// per-tool timeouts. The catalog is handed to the Codex app-server as
// `dynamicTools`. The frontend mirrors the NAMES only (executor lookup) —
// schemas live here and nowhere else.

use serde::Serialize;
use serde_json::{json, Value};

/// Default roundtrip budget: the webview executors are store lookups plus at
/// most one sensing command — anything slower is a bug.
pub const DEFAULT_TIMEOUT_MS: u64 = 15_000;
/// `create_panes` spawns codex app-server processes (one per session) and
/// submits initial prompts.
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

/// The tool catalog. Built fresh per call (it serializes straight into
/// provider payloads); callers cache if they need to.
pub fn tool_definitions() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition {
            name: "fleet_snapshot",
            description: "Current state of the whole fleet: every native Codex session (project, model, access, exact status working/idle/pending-approval, context usage) and a one-line summary. Cheap — call this first to orient yourself and to learn valid session ids.",
            parameters: empty_params(),
            timeout_ms: DEFAULT_TIMEOUT_MS,
        },
        ToolDefinition {
            name: "read_transcript",
            description: "Read the conversation tail of one session: user/assistant messages and the structured steps ($ command → exit N, file changes +N −M, approvals, plan).",
            parameters: json!({
                "type": "object",
                "properties": {
                    "pane_id": { "type": "string", "description": "session id (from fleet_snapshot)" },
                    "tail_messages": { "type": "integer", "description": "return only the last N items (default: 20)" }
                },
                "required": ["pane_id"]
            }),
            timeout_ms: DEFAULT_TIMEOUT_MS,
        },
        ToolDefinition {
            name: "read_project_docs",
            description: "README.md / AGENTS.md / CLAUDE.md of a project root, content capped. Pass EXACTLY ONE of pane_id (a session id — its project folder is read; worktree paths resolve to their main repo) or path (an absolute folder).",
            parameters: json!({
                "type": "object",
                "properties": {
                    "pane_id": { "type": "string", "description": "session id — reads the docs of that session's project root" },
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
            description: "Live git snapshot of a session's project directory (or any absolute path): branch, inserted/deleted lines, untracked files, derived dirty flag. Pass EXACTLY ONE of pane_id or path. Returns git: null with a note when the folder is not a git repo.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "pane_id": { "type": "string", "description": "session id (from fleet_snapshot)" },
                    "path": { "type": "string", "description": "absolute path of a folder" }
                }
            }),
            timeout_ms: DEFAULT_TIMEOUT_MS,
        },
        ToolDefinition {
            name: "list_projects",
            description: "Discover the user's project folders: Codex session history, folders the app already knows, and a shallow scan of extra roots for git repos. When scan_roots is omitted, the user's configured default scan folders are used. Sorted by last activity, most recent first.",
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
            name: "prompt_pane",
            description: "Send a prompt to a session: submits one turn to it. A busy session refuses — wait for it to finish, then prompt it.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "pane_id": { "type": "string", "description": "session id (from fleet_snapshot)" },
                    "text": { "type": "string", "description": "the prompt text to deliver" }
                },
                "required": ["pane_id", "text"]
            }),
            timeout_ms: DEFAULT_TIMEOUT_MS,
        },
        ToolDefinition {
            name: "create_panes",
            description: "Create 1–8 new native Codex sessions. Each entry gets a working directory, optionally a model override (omit = the user's default configuration), a reasoning effort, a name, and an initial prompt (submitted as the session's first turn). Per-entry errors do not abort the batch.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "panes": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 8,
                        "items": {
                            "type": "object",
                            "properties": {
                                "cwd": { "type": "string", "description": "absolute working directory for the session" },
                                "model": { "type": "string", "description": "codex model id; OMIT for the user's default configuration" },
                                "reasoning": { "type": "string", "enum": ["minimal", "low", "medium", "high", "xhigh"], "description": "model_reasoning_effort — omit unless the user asks for it" },
                                "name": { "type": "string", "description": "session name (default: auto)" },
                                "prompt": { "type": "string", "description": "initial prompt, submitted as the first turn" }
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
            name: "remember",
            description: "Add one durable, user-relevant fact to your persistent memory (a small curated list injected into every future session). Store ONLY things worth keeping across sessions: stable user preferences, corrections you were given, model choices per task type, recurring workflows, and project facts that are NOT written in the repo. Do NOT store ephemeral fleet state (that lives in fleet_snapshot), repo documentation (use read_project_docs), secrets, or whole transcripts. If you are unsure whether a fact is worth remembering, do not call this — propose it to the user first and only store it after they confirm. The memory is capped; when it is full the oldest entry is dropped and the result says so.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "text": { "type": "string", "description": "the single fact to remember, as one concise sentence" }
                },
                "required": ["text"]
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
    fn catalog_has_all_nine_tools_and_serializes() {
        let defs = tool_definitions();
        let names: Vec<&str> = defs.iter().map(|d| d.name).collect();
        for expected in [
            "fleet_snapshot",
            "read_transcript",
            "read_project_docs",
            "read_notes",
            "git_status",
            "list_projects",
            "prompt_pane",
            "create_panes",
            "remember",
        ] {
            assert!(names.contains(&expected), "missing tool {expected}");
        }
        assert_eq!(defs.len(), 9);
        // serializable — this exact shape is handed to Codex dynamicTools
        let json = serde_json::to_value(&defs).expect("serialize");
        for def in json.as_array().unwrap() {
            assert!(def["name"].is_string());
            assert!(def["description"].is_string());
            assert!(def["parameters"]["type"] == "object");
            assert!(def["timeout_ms"].is_u64());
        }
    }

    #[test]
    fn remember_requires_text() {
        let def = find_tool("remember").unwrap();
        let err = validate_args(&def, &json!({})).unwrap_err();
        assert!(err.contains("text"), "unexpected error: {err}");
        assert!(validate_args(&def, &json!({ "text": "reviews get high effort" })).is_ok());
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
        // enum on reasoning
        let err = validate_args(
            &def,
            &json!({ "panes": [{ "cwd": "/tmp/x", "reasoning": "turbo" }] }),
        )
        .unwrap_err();
        assert!(err.contains("one of"), "unexpected error: {err}");
        assert!(validate_args(
            &def,
            &json!({ "panes": [{ "cwd": "/tmp/x", "model": "gpt-5-codex", "reasoning": "high", "prompt": "go" }] })
        )
        .is_ok());
    }

    #[test]
    fn create_panes_is_session_only() {
        let def = find_tool("create_panes").unwrap();
        let item_props = &def.parameters["properties"]["panes"]["items"]["properties"];
        // the pane-era params are gone for good
        for legacy in ["native", "runtime", "profile_id", "worktree", "branch", "beside"] {
            assert!(item_props.get(legacy).is_none(), "legacy param {legacy} present");
        }
        let props = &def.parameters["properties"];
        for legacy in ["workspace", "workspace_id", "arrangement"] {
            assert!(props.get(legacy).is_none(), "legacy param {legacy} present");
        }
        assert!(def.description.contains("session"), "description omits sessions");
    }
}
