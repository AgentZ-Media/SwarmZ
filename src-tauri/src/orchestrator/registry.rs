// Orchestrator tool registry — the SINGLE source of truth for the tool
// catalog: names, LLM-facing descriptions, JSON-Schema parameters and
// per-tool timeouts. The catalog is handed to the Codex app-server as
// `dynamicTools`. The frontend mirrors the NAMES only (executor lookup) —
// schemas live here and nowhere else.
//
// Phase 4 "tool arsenal v2": the Conductor is a fully capable engineering
// lead now — agents (spawn/prompt-with-steer/interrupt/close/configure/
// review), worktrees, timers, approval routing (routine decisions),
// plan documents. Every tool stays SESSION-only and project-scoped through
// the chat_id → project_id line the bus carries.

use serde::Serialize;
use serde_json::{json, Value};

/// Default roundtrip budget: the webview executors are store lookups plus at
/// most one sensing command — anything slower is a bug.
pub const DEFAULT_TIMEOUT_MS: u64 = 15_000;
/// `spawn_agents` creates worktrees (a full checkout each) and spawns codex
/// app-server processes (one per agent) plus initial prompts — an 8-agent
/// batch on a big repo can legitimately take minutes. The bus timeout does
/// NOT cancel the webview executor, so a timeout mid-batch would leave the
/// batch running while the model retries into duplicate agents; the generous
/// deadline (plus the batch's case-insensitive name reservation) is what
/// keeps that from happening.
const SPAWN_AGENTS_TIMEOUT_MS: u64 = 600_000;
/// Worktree creation checks out a whole tree and copies the environment.
const WORKTREE_TIMEOUT_MS: u64 = 150_000;
/// `review_agent` runs a full detached codex review turn.
const REVIEW_TIMEOUT_MS: u64 = 600_000;
/// `prompt_agent` may steer a running turn (an extra app-server roundtrip).
const PROMPT_TIMEOUT_MS: u64 = 30_000;

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

/// Schema fragment for the `agent` argument (used by every per-agent tool).
fn agent_param() -> Value {
    json!({ "type": "string", "description": "agent session id, or the agent's unique name within this project (from fleet_snapshot)" })
}

/// The tool catalog. Built fresh per call (it serializes straight into
/// provider payloads); callers cache if they need to.
pub fn tool_definitions() -> Vec<ToolDefinition> {
    vec![
        // ---- sensing ----
        ToolDefinition {
            name: "fleet_snapshot",
            description: "Current state of YOUR project's fleet: every agent (name, model, access, exact status working/idle/pending-approval, context usage, worktree), the project's worktrees (who works where, shared or not), your active timers, and the pending-approval situation incl. each approval's routing class (routine = you may decide, destructive = human only). Cheap — call this first to orient yourself and to learn valid agent names/ids.",
            parameters: empty_params(),
            timeout_ms: DEFAULT_TIMEOUT_MS,
        },
        ToolDefinition {
            name: "read_agent",
            description: "Read the conversation tail of one agent in this project: user/assistant messages and the structured steps ($ command → exit N, file changes +N −M, approvals, plan).",
            parameters: json!({
                "type": "object",
                "properties": {
                    "agent": agent_param(),
                    "tail_messages": { "type": "integer", "description": "return only the last N items (default: 20)" }
                },
                "required": ["agent"]
            }),
            timeout_ms: DEFAULT_TIMEOUT_MS,
        },
        ToolDefinition {
            name: "read_project_docs",
            description: "README.md / AGENTS.md / CLAUDE.md of a project root, content capped. Pass EXACTLY ONE of agent (an agent id/name — its working root is read; worktree paths resolve to their main repo) or path (an absolute folder).",
            parameters: json!({
                "type": "object",
                "properties": {
                    "agent": agent_param(),
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
            description: "Live git snapshot of an agent's working directory (or any absolute path — worktrees included): branch, inserted/deleted lines, untracked files, derived dirty flag. Pass EXACTLY ONE of agent or path. Returns git: null with a note when the folder is not a git repo.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "agent": agent_param(),
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
        // ---- agents ----
        ToolDefinition {
            name: "spawn_agents",
            description: "Bring in 1–8 new agents for this project. Each entry: a task (submitted as the agent's first order — write it self-contained), a worktree placement (\"new\" = a fresh git worktree on an own branch, \"shared:<agentName>\" = work in an EXISTING agent's worktree, \"none\" = directly in the project folder — for read/analysis tasks), and optional model/effort/access/name overrides. Names are picked automatically (collision-free); the result returns each agent's name, id and worktree path. Per-entry errors do not abort the batch.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "agents": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 8,
                        "items": {
                            "type": "object",
                            "properties": {
                                "task": { "type": "string", "description": "the agent's first order — self-contained: context + goal + boundaries" },
                                "worktree": { "type": "string", "description": "\"new\" | \"shared:<agentName>\" | \"none\" — where the agent works" },
                                "model": { "type": "string", "description": "codex model id; OMIT for the default (gpt-5.6-sol)" },
                                "effort": { "type": "string", "description": "reasoning effort (e.g. low, medium, high, xhigh); OMIT for medium" },
                                "access": { "type": "string", "enum": ["workspace", "full"], "description": "sandbox level — omit for workspace (recommended)" },
                                "name": { "type": "string", "description": "agent name (default: auto from the pool)" }
                            },
                            "required": ["task", "worktree"]
                        }
                    }
                },
                "required": ["agents"]
            }),
            timeout_ms: SPAWN_AGENTS_TIMEOUT_MS,
        },
        ToolDefinition {
            name: "prompt_agent",
            description: "Send a prompt to an agent in this project. An idle agent gets it as its next turn; a BUSY agent is STEERED — the text is injected into its running turn and absorbed immediately (use this to correct course mid-flight). The result says which of the two happened.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "agent": agent_param(),
                    "text": { "type": "string", "description": "the prompt text to deliver" }
                },
                "required": ["agent", "text"]
            }),
            timeout_ms: PROMPT_TIMEOUT_MS,
        },
        ToolDefinition {
            name: "interrupt_agent",
            description: "Stop an agent's running turn (its turn resolves as interrupted; the agent keeps its context and can be re-prompted).",
            parameters: json!({
                "type": "object",
                "properties": { "agent": agent_param() },
                "required": ["agent"]
            }),
            timeout_ms: DEFAULT_TIMEOUT_MS,
        },
        ToolDefinition {
            name: "close_agent",
            description: "Close an agent session for good: its running turn is interrupted, pending approvals are cancelled and the session disappears from the fleet. Its worktree stays (clean it separately via cleanup_worktree when the work is merged or discarded).",
            parameters: json!({
                "type": "object",
                "properties": { "agent": agent_param() },
                "required": ["agent"]
            }),
            timeout_ms: DEFAULT_TIMEOUT_MS,
        },
        ToolDefinition {
            name: "set_agent_config",
            description: "Retune an agent mid-session: model, reasoning effort and/or access level. Takes effect from the agent's next turn. Pass only the fields to change; an empty string clears model/effort back to the default.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "agent": agent_param(),
                    "model": { "type": "string", "description": "codex model id (\"\" clears the override)" },
                    "effort": { "type": "string", "description": "reasoning effort (\"\" clears the override)" },
                    "access": { "type": "string", "enum": ["workspace", "full"], "description": "sandbox level" }
                },
                "required": ["agent"]
            }),
            timeout_ms: DEFAULT_TIMEOUT_MS,
        },
        ToolDefinition {
            name: "review_agent",
            description: "Run a native codex code review over an agent's work (a detached review thread — the agent itself is not disturbed). target: \"uncommitted\" (default — the agent's working tree) | \"branch:<base>\" (diff against a base branch) | \"commit:<sha>\". Returns the structured review report (prioritized findings with file:line references). Use it before reporting an agent's work as done.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "agent": agent_param(),
                    "target": { "type": "string", "description": "\"uncommitted\" (default) | \"branch:<base>\" | \"commit:<sha>\"" }
                },
                "required": ["agent"]
            }),
            timeout_ms: REVIEW_TIMEOUT_MS,
        },
        ToolDefinition {
            name: "decide_approval",
            description: "Decide one of an agent's PENDING approvals (a command or file change waiting for permission). Only approvals classified \"routine\" may be decided here — \"destructive\" ones are hard-reserved for the human and this tool refuses them. decision: accept | decline. Omit approval_id to decide the agent's oldest pending approval.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "agent": agent_param(),
                    "decision": { "type": "string", "enum": ["accept", "decline"] },
                    "approval_id": { "type": "string", "description": "a specific approval id (from fleet_snapshot) — omit for the oldest pending" }
                },
                "required": ["agent", "decision"]
            }),
            timeout_ms: DEFAULT_TIMEOUT_MS,
        },
        // ---- worktrees ----
        ToolDefinition {
            name: "create_worktree",
            description: "Create a fresh git worktree of this project under <repo>/.worktrees/ on a new branch (environment files like .env are copied over). Returns root, path and branch. Assign it to an agent with assign_worktree, or spawn directly into a new worktree via spawn_agents worktree:\"new\".",
            parameters: json!({
                "type": "object",
                "properties": {
                    "branch": { "type": "string", "description": "branch name — omit for an auto-generated swarm/<slug> name" }
                }
            }),
            timeout_ms: WORKTREE_TIMEOUT_MS,
        },
        ToolDefinition {
            name: "assign_worktree",
            description: "Move an agent into a worktree: the agent's working directory switches to the worktree path from its next turn on. Multiple agents may share one worktree — one WRITER at a time is the rule; the fleet marks it shared.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "agent": agent_param(),
                    "path": { "type": "string", "description": "absolute worktree path (from create_worktree / worktree_status)" }
                },
                "required": ["agent", "path"]
            }),
            timeout_ms: DEFAULT_TIMEOUT_MS,
        },
        ToolDefinition {
            name: "worktree_status",
            description: "All worktrees of this project with live state: path, branch, dirty (uncommitted changes), ahead (commits only this branch holds), and which agents work in each.",
            parameters: empty_params(),
            timeout_ms: WORKTREE_TIMEOUT_MS,
        },
        ToolDefinition {
            name: "cleanup_worktree",
            description: "Remove one worktree (folder + branch) — SAFE-GATED: the state is re-checked at execution time and the removal is refused when the worktree holds uncommitted changes or commits no other branch has, or when an agent still works in it. A refused cleanup returns the reason — merge/commit the work first or ask the user.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "absolute worktree path" }
                },
                "required": ["path"]
            }),
            timeout_ms: WORKTREE_TIMEOUT_MS,
        },
        // ---- timers ----
        ToolDefinition {
            name: "set_timer",
            description: "Set yourself a follow-up timer for this project. When it fires, YOU get an autonomous turn with the note as context — use it to check on agents, nudge stalled work, or follow up on promises. Pass exactly one of delay_seconds or at_iso. Timers persist across app restarts; missed ones fire at the next launch.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "delay_seconds": { "type": "integer", "description": "fire after N seconds from now" },
                    "at_iso": { "type": "string", "description": "fire at an absolute time (ISO 8601, e.g. 2026-07-10T18:30:00)" },
                    "note": { "type": "string", "description": "what to do when the timer fires — written to future-you" }
                },
                "required": ["note"]
            }),
            timeout_ms: DEFAULT_TIMEOUT_MS,
        },
        ToolDefinition {
            name: "list_timers",
            description: "Your pending timers for this project: id, note, fire time, remaining seconds.",
            parameters: empty_params(),
            timeout_ms: DEFAULT_TIMEOUT_MS,
        },
        ToolDefinition {
            name: "cancel_timer",
            description: "Cancel one of your pending timers by id (from list_timers).",
            parameters: json!({
                "type": "object",
                "properties": {
                    "timer_id": { "type": "string" }
                },
                "required": ["timer_id"]
            }),
            timeout_ms: DEFAULT_TIMEOUT_MS,
        },
        // ---- plans ----
        ToolDefinition {
            name: "write_plan",
            description: "Write one of YOUR OWN plan/analysis documents (Markdown) into this project's dedicated plans area (<project>/.swarmz/plans/<slug>.md) — the ONLY place you may write files. Use it for decompositions, architecture notes, task briefs agents should read (point them at the returned path). Same title = the document is replaced.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": "document title — becomes the file slug" },
                    "markdown": { "type": "string", "description": "the full document content (Markdown)" }
                },
                "required": ["title", "markdown"]
            }),
            timeout_ms: DEFAULT_TIMEOUT_MS,
        },
        ToolDefinition {
            name: "list_plans",
            description: "Your plan documents in this project's plans area: slug, title, last modified, size.",
            parameters: empty_params(),
            timeout_ms: DEFAULT_TIMEOUT_MS,
        },
        ToolDefinition {
            name: "read_plan",
            description: "Read one of your plan documents by slug (from list_plans).",
            parameters: json!({
                "type": "object",
                "properties": {
                    "slug": { "type": "string" }
                },
                "required": ["slug"]
            }),
            timeout_ms: DEFAULT_TIMEOUT_MS,
        },
        // ---- memory ----
        ToolDefinition {
            name: "remember",
            description: "Add one durable, user-relevant fact to your persistent memory (small curated lists injected into every future session). Scope \"project\" (the default) stores it for THIS project only; scope \"global\" stores it for every project — use global only for cross-project user preferences. Store things worth keeping across sessions: stable user preferences, corrections you were given, model choices per task type, recurring workflows, observed working style, and project facts that are NOT written in the repo. Do NOT store ephemeral fleet state (that lives in fleet_snapshot), repo documentation (use read_project_docs), secrets, or whole transcripts. Preference OBSERVATIONS you are confident about may be stored proactively; uncertain FACTS you propose to the user first and store after they confirm. Each memory is capped; when it is full the oldest entry is dropped and the result says so.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "text": { "type": "string", "description": "the single fact to remember, as one concise sentence" },
                    "scope": { "type": "string", "enum": ["project", "global"], "description": "where to store it — omit for \"project\" (this project)" }
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

    /// The frozen Phase-4 catalog — a missing or extra tool fails loudly.
    pub const EXPECTED_TOOLS: [&str; 23] = [
        "fleet_snapshot",
        "read_agent",
        "read_project_docs",
        "read_notes",
        "git_status",
        "list_projects",
        "spawn_agents",
        "prompt_agent",
        "interrupt_agent",
        "close_agent",
        "set_agent_config",
        "review_agent",
        "decide_approval",
        "create_worktree",
        "assign_worktree",
        "worktree_status",
        "cleanup_worktree",
        "set_timer",
        "list_timers",
        "cancel_timer",
        "write_plan",
        "list_plans",
        "read_plan",
    ];

    #[test]
    fn catalog_is_the_frozen_phase4_arsenal_and_serializes() {
        let defs = tool_definitions();
        let names: Vec<&str> = defs.iter().map(|d| d.name).collect();
        for expected in EXPECTED_TOOLS {
            assert!(names.contains(&expected), "missing tool {expected}");
        }
        assert!(names.contains(&"remember"));
        assert_eq!(defs.len(), EXPECTED_TOOLS.len() + 1, "unexpected tool count");
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
    fn pane_era_tool_names_are_gone() {
        for legacy in ["create_panes", "prompt_pane", "read_transcript"] {
            assert!(find_tool(legacy).is_none(), "legacy tool {legacy} still present");
        }
    }

    #[test]
    fn remember_requires_text_and_validates_scope() {
        let def = find_tool("remember").unwrap();
        let err = validate_args(&def, &json!({})).unwrap_err();
        assert!(err.contains("text"), "unexpected error: {err}");
        assert!(validate_args(&def, &json!({ "text": "reviews get high effort" })).is_ok());
        assert!(validate_args(&def, &json!({ "text": "x", "scope": "global" })).is_ok());
        assert!(validate_args(&def, &json!({ "text": "x", "scope": "project" })).is_ok());
        let err = validate_args(&def, &json!({ "text": "x", "scope": "everywhere" })).unwrap_err();
        assert!(err.contains("one of"), "unexpected error: {err}");
    }

    #[test]
    fn required_args_are_enforced() {
        let def = find_tool("prompt_agent").unwrap();
        let err = validate_args(&def, &json!({ "agent": "maya" })).unwrap_err();
        assert!(err.contains("text"), "unexpected error: {err}");
        assert!(validate_args(&def, &json!({ "agent": "maya", "text": "hi" })).is_ok());

        let def = find_tool("decide_approval").unwrap();
        let err = validate_args(&def, &json!({ "agent": "maya" })).unwrap_err();
        assert!(err.contains("decision"), "unexpected error: {err}");
        assert!(validate_args(&def, &json!({ "agent": "maya", "decision": "accept" })).is_ok());
        let err =
            validate_args(&def, &json!({ "agent": "maya", "decision": "maybe" })).unwrap_err();
        assert!(err.contains("one of"), "unexpected error: {err}");

        let def = find_tool("set_timer").unwrap();
        let err = validate_args(&def, &json!({ "delay_seconds": 60 })).unwrap_err();
        assert!(err.contains("note"), "unexpected error: {err}");
        assert!(validate_args(&def, &json!({ "delay_seconds": 60, "note": "check Maya" })).is_ok());

        let def = find_tool("write_plan").unwrap();
        let err = validate_args(&def, &json!({ "title": "Plan" })).unwrap_err();
        assert!(err.contains("markdown"), "unexpected error: {err}");
    }

    #[test]
    fn basic_types_are_enforced() {
        let def = find_tool("prompt_agent").unwrap();
        let err = validate_args(&def, &json!({ "agent": "abc", "text": 5 })).unwrap_err();
        assert!(err.contains("expected string"), "unexpected error: {err}");
        let err = validate_args(&def, &json!("not an object")).unwrap_err();
        assert!(err.contains("JSON object"), "unexpected error: {err}");
    }

    #[test]
    fn spawn_agents_batch_is_validated() {
        let def = find_tool("spawn_agents").unwrap();
        // empty batch → minItems
        let err = validate_args(&def, &json!({ "agents": [] })).unwrap_err();
        assert!(err.contains("at least 1"), "unexpected error: {err}");
        // task + worktree are required per entry
        let err = validate_args(&def, &json!({ "agents": [{ "task": "x" }] })).unwrap_err();
        assert!(err.contains("worktree"), "unexpected error: {err}");
        let err = validate_args(&def, &json!({ "agents": [{ "worktree": "new" }] })).unwrap_err();
        assert!(err.contains("task"), "unexpected error: {err}");
        // access is enum-checked; effort is an open string (catalog-driven)
        let err = validate_args(
            &def,
            &json!({ "agents": [{ "task": "x", "worktree": "none", "access": "root" }] }),
        )
        .unwrap_err();
        assert!(err.contains("one of"), "unexpected error: {err}");
        assert!(validate_args(
            &def,
            &json!({ "agents": [
                { "task": "fix checkout", "worktree": "new", "model": "gpt-5.6-sol", "effort": "high" },
                { "task": "review it", "worktree": "shared:Maya", "access": "workspace" },
                { "task": "analyze deps", "worktree": "none" }
            ] })
        )
        .is_ok());
        // 9 entries → maxItems
        let nine: Vec<Value> = (0..9)
            .map(|i| json!({ "task": format!("t{i}"), "worktree": "none" }))
            .collect();
        let err = validate_args(&def, &json!({ "agents": nine })).unwrap_err();
        assert!(err.contains("at most 8"), "unexpected error: {err}");
    }

    #[test]
    fn timeouts_match_the_work_behind_the_tool() {
        assert_eq!(find_tool("spawn_agents").unwrap().timeout_ms, SPAWN_AGENTS_TIMEOUT_MS);
        assert_eq!(find_tool("review_agent").unwrap().timeout_ms, REVIEW_TIMEOUT_MS);
        assert_eq!(find_tool("create_worktree").unwrap().timeout_ms, WORKTREE_TIMEOUT_MS);
        assert_eq!(find_tool("cleanup_worktree").unwrap().timeout_ms, WORKTREE_TIMEOUT_MS);
        assert_eq!(find_tool("prompt_agent").unwrap().timeout_ms, PROMPT_TIMEOUT_MS);
        assert_eq!(find_tool("fleet_snapshot").unwrap().timeout_ms, DEFAULT_TIMEOUT_MS);
    }
}
