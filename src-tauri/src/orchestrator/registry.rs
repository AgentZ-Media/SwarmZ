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
            description: "Current state of the whole fleet: every workspace with its agent panes (runtime, project, branch, busy/idle/waiting activity, model, context usage), a `sessions` section listing the native Vibe-Mode Codex sessions (exact status working/idle/pending-approval), `ui_mode` (\"grid\" or \"vibe\" — the view the user is currently in) and a one-line summary. Cheap — call this first to orient yourself and to learn valid pane and session ids.",
            parameters: empty_params(),
            timeout_ms: DEFAULT_TIMEOUT_MS,
        },
        ToolDefinition {
            name: "read_transcript",
            description: "Read the conversation tail of one agent pane's session OR one native Vibe session: user/assistant messages, one-line tool summaries, compaction summaries, and optionally the session's first user prompt. For a native session id it renders the structured steps ($ command → exit N, file changes +N −M, approvals, plan). Fails for shell panes and panes whose session has not been discovered yet.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "pane_id": { "type": "string", "description": "agent pane id or native session id (from fleet_snapshot)" },
                    "tail_messages": { "type": "integer", "description": "return only the last N messages (default 20)" },
                    "include_first_user_message": { "type": "boolean", "description": "also return the session's original first user prompt (default true)" }
                },
                "required": ["pane_id"]
            }),
            timeout_ms: DEFAULT_TIMEOUT_MS,
        },
        ToolDefinition {
            name: "read_project_docs",
            description: "README.md / AGENTS.md / CLAUDE.md of a project root, content capped. Pass EXACTLY ONE of pane_id (a pane's project root — worktree panes resolve to their main repo — OR a native Vibe session id, whose project folder is read) or path (an absolute folder).",
            parameters: json!({
                "type": "object",
                "properties": {
                    "pane_id": { "type": "string", "description": "agent pane id OR native session id — reads the docs of that pane/session's project root" },
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
            name: "list_agents",
            description: "List the user's custom agents — specialists the user built, each with its own persona, memory and knowledge. Returns per agent: slug, name, role, a one-line description, defaultRuntime (\"vibe\" = a native session, else a terminal runtime) and its default model/access when set. Start one with create_panes by passing its `agent` slug (as a terminal pane or, with native:true, a Vibe session). Call this when the user names one of their agents or a task clearly fits a specialist.",
            parameters: empty_params(),
            timeout_ms: DEFAULT_TIMEOUT_MS,
        },
        ToolDefinition {
            name: "prompt_pane",
            description: "Send a prompt to an agent pane OR a native Vibe session (accepts either id — panes are checked first, then sessions). For a pane: bracketed-paste the text into its terminal and optionally submit with Enter (a busy pane still receives the text — it queues in the CLI's input — and the response carries a warning). For a native session: submit one turn to it; a busy session refuses (wait for it to finish).",
            parameters: json!({
                "type": "object",
                "properties": {
                    "pane_id": { "type": "string", "description": "agent pane id or native session id (from fleet_snapshot)" },
                    "text": { "type": "string", "description": "the prompt/command text to deliver" },
                    "submit": { "type": "boolean", "description": "press Enter after pasting (default true)" }
                },
                "required": ["pane_id", "text"]
            }),
            timeout_ms: DEFAULT_TIMEOUT_MS,
        },
        ToolDefinition {
            name: "create_panes",
            description: "Create 1–8 new agents in a workspace. Each entry gets a working directory, optionally a runtime or profile, a model override (omit = the user's default configuration), a name, an initial prompt (delivered once the agent is ready), and optionally a fresh git worktree (own branch + folder under <repo>/.worktrees/). New panes are laid out with EQUAL sizes (the system owns the geometry — no manual sizing) and the system OVERFLOWS into a fresh workspace automatically if the target can't hold them above a readable minimum (~380×240 px), so you never have to compute whether panes fit. Use `workspace` to target a workspace, `arrangement` to shape the new panes, and per-pane `beside` for contextual placement next to an existing pane; consult fleet_snapshot's layout section (grid size + effective pane px) first. Set native:true to create a native Vibe-Mode Codex session instead of a terminal pane (prefer this when the user works in Vibe Mode / ui_mode is \"vibe\"); native sessions ignore runtime/profile/worktree AND all layout params (workspace/arrangement/beside). Set `agent` to a custom-agent slug (from list_agents) to start that specialist — its persona, memory and knowledge are injected and its default model/access prefill the pane; works for terminal panes AND native sessions, and an unknown slug fails only that entry. A worktree request on a non-repo folder FAILS for that pane — it is never silently downgraded to a plain pane. Per-entry errors do not abort the batch.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "workspace": { "type": "string", "description": "where the new terminal panes go: \"current\" (default), \"new\" (a fresh workspace), or the NAME of an existing workspace (case-insensitive; unknown name → error). Ignored for native sessions" },
                    "workspace_id": { "type": "string", "description": "legacy id-based target (used only when `workspace` is omitted; default: the active workspace). Prefer `workspace`. Ignored for native sessions" },
                    "arrangement": { "type": "string", "enum": ["auto", "rows", "columns", "grid"], "description": "how to arrange the NEW panes among themselves: \"auto\" (default — tiles by count and screen shape), \"rows\" (stacked), \"columns\" (side by side), \"grid\". Existing panes keep their layout. Ignored for native sessions and for panes with `beside`" },
                    "panes": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 8,
                        "items": {
                            "type": "object",
                            "properties": {
                                "cwd": { "type": "string", "description": "absolute working directory for the pane / native session" },
                                "native": { "type": "boolean", "description": "create a native Vibe-Mode Codex session instead of a terminal pane. Native sessions have structured transcripts and an exact status, and prompt_pane can prompt them directly by id. runtime/profile/worktree/branch and all layout params do NOT apply to native sessions (V1); cwd, model, reasoning, name and prompt do" },
                                "agent": { "type": "string", "description": "custom-agent slug (from list_agents): starts this specialist with its persona/memory/knowledge injected. Its default model/access prefill the pane unless you override them here. Applies to terminal panes and native sessions; an unknown slug fails only this entry. Do not also pass runtime/profile — the agent decides them" },
                                "runtime": { "type": "string", "enum": ["claude", "codex", "shell"], "description": "agent CLI to launch (default: the app's default runtime). Ignored when native:true (always codex)" },
                                "profile_id": { "type": "string", "description": "launch profile id (from list_blueprints) — sets runtime + startup command. Ignored when native:true" },
                                "model": { "type": "string", "description": "model id for the agent (claude: --model, codex: -m; native: the session model). Use ids from list_blueprints runtimes.*.recently_used_models when the user names a model; OMIT for the user's default configuration" },
                                "reasoning": { "type": "string", "enum": ["minimal", "low", "medium", "high", "xhigh"], "description": "codex only: model_reasoning_effort — omit unless the user asks for it" },
                                "name": { "type": "string", "description": "pane / session name (default: auto)" },
                                "prompt": { "type": "string", "description": "initial prompt, submitted once the agent is ready" },
                                "worktree": { "type": "boolean", "description": "create a fresh git worktree off the repo at cwd and run the pane inside it. NOT applicable to native sessions (V1)" },
                                "branch": { "type": "string", "description": "worktree branch name (default: a generated one)" },
                                "beside": {
                                    "type": "object",
                                    "description": "place this pane next to an existing one (a targeted split; ignores workspace/arrangement distribution and lands in the target pane's workspace). Not applicable to native sessions",
                                    "properties": {
                                        "pane_id": { "type": "string", "description": "id of the existing pane to split off (from fleet_snapshot)" },
                                        "direction": { "type": "string", "enum": ["right", "below"], "description": "which side of the target pane (default: right)" }
                                    },
                                    "required": ["pane_id"]
                                }
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
    fn catalog_has_all_twelve_tools_and_serializes() {
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
            "list_agents",
            "prompt_pane",
            "create_panes",
            "create_workspace",
            "remember",
        ] {
            assert!(names.contains(&expected), "missing tool {expected}");
        }
        assert_eq!(defs.len(), 12);
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
    fn remember_requires_text() {
        let def = find_tool("remember").unwrap();
        let err = validate_args(&def, &json!({})).unwrap_err();
        assert!(err.contains("text"), "unexpected error: {err}");
        assert!(validate_args(&def, &json!({ "text": "reviews go to Opus" })).is_ok());
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
        // native sessions are a first-class per-pane option (Phase 5)
        assert!(validate_args(
            &def,
            &json!({ "panes": [{ "cwd": "/tmp/x", "native": true, "model": "gpt-5-codex" }] })
        )
        .is_ok());
    }

    #[test]
    fn create_panes_exposes_the_native_session_flag() {
        let def = find_tool("create_panes").unwrap();
        let item_props =
            &def.parameters["properties"]["panes"]["items"]["properties"];
        assert_eq!(item_props["native"]["type"], "boolean", "native flag missing");
        assert!(def.description.contains("native"), "description omits native sessions");
    }

    #[test]
    fn create_panes_exposes_the_agent_slug_param() {
        let def = find_tool("create_panes").unwrap();
        let item_props = &def.parameters["properties"]["panes"]["items"]["properties"];
        assert_eq!(item_props["agent"]["type"], "string", "agent slug param missing");
        assert!(
            def.description.contains("agent"),
            "description omits custom agents"
        );
        // a per-pane agent slug validates
        assert!(validate_args(
            &def,
            &json!({ "panes": [{ "cwd": "/tmp/x", "agent": "youtube-coach" }] })
        )
        .is_ok());
    }

    #[test]
    fn create_panes_exposes_layout_params() {
        let def = find_tool("create_panes").unwrap();
        let props = &def.parameters["properties"];
        // top-level workspace + arrangement
        assert_eq!(props["workspace"]["type"], "string", "workspace param missing");
        let arr = props["arrangement"]["enum"].as_array().unwrap();
        for want in ["auto", "rows", "columns", "grid"] {
            assert!(
                arr.iter().any(|v| v == want),
                "arrangement enum missing {want}"
            );
        }
        // per-pane beside { pane_id, direction }
        let beside = &props["panes"]["items"]["properties"]["beside"];
        assert_eq!(beside["type"], "object", "beside param missing");
        assert_eq!(beside["properties"]["pane_id"]["type"], "string");
        let dir = beside["properties"]["direction"]["enum"].as_array().unwrap();
        assert!(dir.iter().any(|v| v == "right") && dir.iter().any(|v| v == "below"));
        assert!(def.description.contains("overflow") || def.description.contains("OVERFLOW"));
    }

    #[test]
    fn create_panes_validates_new_params() {
        let def = find_tool("create_panes").unwrap();
        // arrangement enum enforced
        let err = validate_args(
            &def,
            &json!({ "arrangement": "diagonal", "panes": [{ "cwd": "/tmp/x" }] }),
        )
        .unwrap_err();
        assert!(err.contains("one of"), "unexpected error: {err}");
        // beside requires pane_id
        let err = validate_args(
            &def,
            &json!({ "panes": [{ "cwd": "/tmp/x", "beside": { "direction": "right" } }] }),
        )
        .unwrap_err();
        assert!(err.contains("pane_id"), "unexpected error: {err}");
        // a fully-specified layout call passes
        assert!(validate_args(
            &def,
            &json!({
                "workspace": "current",
                "arrangement": "grid",
                "panes": [{ "cwd": "/tmp/x", "beside": { "pane_id": "abc", "direction": "below" } }]
            })
        )
        .is_ok());
    }
}
