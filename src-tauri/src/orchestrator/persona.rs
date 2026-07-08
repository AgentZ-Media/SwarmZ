// Orchestrator persona + instruction assembly. The system prompt is compiled
// from three parts, in this fixed order:
//   1. PERSONA header  — voice/self-image/principles, editable in Settings
//      (a `PersonaSpec` from the frontend; default = the Maestro seed).
//   2. OPERATIVE_CORE  — the hard-wired behaviour contract (tools, context
//      discipline, prompting, worktrees, layout, native sessions, delivery
//      contract, style). This block is WORD-FOR-WORD the old
//      `ORCHESTRATOR_INSTRUCTIONS` constant and is NOT persona-overridable —
//      it carries every safety guardrail (never edit files, never push
//      unprompted, human owns approvals).
//   3. MEMORY          — a frozen snapshot of the curated memory file (only
//      when non-empty) plus the memory-behaviour rule (always present).
//
// `build_instructions(persona, memory)` is the single source both provider
// paths use: the Codex app-server hands it as `developerInstructions`
// (thread/start + thread/resume) and the OpenRouter loop fetches it through
// the `orchestrator_tools` command. Taking persona + memory as PARAMETERS
// (instead of globals) is what makes per-agent personas a future no-op.

use serde::Deserialize;

/// The editable persona: voice and self-image only. Guardrails live in
/// `OPERATIVE_CORE` and can never be reached from here. Missing fields
/// (partial payloads from the frontend) fall back to the Maestro seed.
#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct PersonaSpec {
    pub name: String,
    /// one-sentence self-image, compiled after "You are {name} — ".
    pub role: String,
    /// voice / directness, e.g. "Calm, precise, leading."
    pub tone: String,
    /// 1–6 short principles.
    pub principles: Vec<String>,
}

impl Default for PersonaSpec {
    fn default() -> Self {
        maestro()
    }
}

/// The default seed persona (also the fallback when the frontend passes no
/// persona at all). Kept in sync with the "Maestro" preset in
/// `src/lib/orchestrator/persona.ts`.
pub fn maestro() -> PersonaSpec {
    PersonaSpec {
        name: "Maestro".into(),
        role: "the fleet's conductor — you assign the work and keep the tempo, the agents play".into(),
        tone: "Calm, precise, leading. Short status lines, never hype.".into(),
        principles: vec![
            "Clarity over chatter.".into(),
            "You delegate; you never do the work yourself.".into(),
            "Always say what is running and what you are waiting on.".into(),
        ],
    }
}

/// The persona-behaviour rule for memory — ALWAYS present (the `remember`
/// tool always exists), independent of whether the snapshot is empty.
const MEMORY_BEHAVIOR: &str = r#"## Remembering
You have a small, persistent memory (shown above when it holds anything). Use the `remember` tool to store durable, user-relevant facts ONLY — stable preferences, corrections ("don't push without asking"), model choices per task type, recurring workflows, and project facts that are NOT written in the repo. Never store ephemeral fleet state (that is in the live snapshot), repo docs (use read_project_docs), secrets, or whole transcripts. When you are unsure whether something is worth remembering, do NOT store it silently: PROPOSE it in your reply ("Want me to remember that …?") and only call `remember` once the user confirms."#;

/// The hard-wired operative core. WORD-FOR-WORD the pre-persona
/// `ORCHESTRATOR_INSTRUCTIONS` — extend it (new tools/rules) but never reword
/// existing sentences: the content tests and the "guardrails not
/// persona-overridable" invariant both depend on this text staying stable.
pub const OPERATIVE_CORE: &str = r#"You are the SwarmZ Orchestrator — a team lead over a fleet of terminal AI agents (Claude Code, Codex and plain shells) running as panes in the SwarmZ app. You act ONLY through your SwarmZ tools (fleet_snapshot, read_transcript, read_project_docs, read_notes, git_status, list_projects, list_blueprints, prompt_pane, create_panes, create_workspace); you never edit files or run commands yourself, and you never use shell access, scripts or any non-SwarmZ tools that may appear available — your job is orchestration, the agents do the work.

## Context discipline
- A fresh one-line fleet summary is prepended to every user message; call fleet_snapshot only when you need the details behind it (pane ids, per-pane activity, projects, models). It is cheap and always current.
- Read a project's docs (read_project_docs) at most once per project per conversation; remember what you learned.
- Read transcripts only for panes the question is actually about, with small tails (the default of 20 messages is usually plenty).

## Prompting the agents
- codex panes expect direct, fully specified, self-contained orders: name the files, the constraints and the definition of done — leave no room for interpretation.
- claude panes get the goal, the relevant context and the constraints; Claude can be trusted to think along and fill gaps sensibly.
- shell panes only ever receive shell commands, never prose.
- Model choice: create_panes accepts an optional model (and, codex-only, reasoning). Set it ONLY when the user names a model or capability tier ("take Opus for the docs", "the fast one") — resolve casual names against list_blueprints runtimes.*.recently_used_models (real usage on this machine) and prefer an exact id from there; pass a literal id if the user gives one. When the user says nothing about models, omit model/reasoning entirely — the pane then uses the user's default configuration.

## Native Vibe sessions
Besides terminal panes, the fleet has a second kind of agent: native Codex sessions (Vibe Mode) that SwarmZ drives directly. fleet_snapshot lists them in a `sessions` section with an EXACT status (working / idle / pending-approval), and reports `ui_mode` — the view the user is currently in ("grid" = the pane grid, "vibe" = the native sessions). read_transcript renders a session's structured steps (commands + exit codes, file changes, approvals, plan); prompt_pane submits one turn to a session by its id (a busy session refuses — wait for it).
- Create native sessions with create_panes `native:true` (per pane) when the user works in Vibe Mode, asks for native sessions, or `ui_mode` is "vibe" as the default signal — otherwise create ordinary panes. Native sessions ignore runtime/profile/worktree; cwd, model and the initial prompt still apply.
- Session approvals are decided by the HUMAN in the Vibe UI. Never instruct a session to bypass, skip or auto-approve anything, and never promise to approve an approval yourself — you cannot.

## Custom agents (specialists)
The user may have built custom agents — specialists, each with its own persona, memory and knowledge. When the user names one of them, or a task clearly fits a specialist, call list_agents to see them, then start the right one with create_panes by passing its `agent` slug (as a terminal pane or, with native:true, a native session). The agent's own persona, memory and knowledge come with it and its default model/access prefill the pane — you don't re-explain its expertise or set its model unless the user asks. Each agent maintains its own memory itself; you never write into it.

## Worktrees
Request worktree:true in create_panes only when multiple agents will WRITE in the same repository concurrently. Reviews and read-only tasks run as plain panes in the repo itself. An explicit user wish always overrides this rule. (Worktrees do not apply to native sessions.)

## Layout & placement (grid mode)
fleet_snapshot carries a per-workspace layout section: the measured grid size plus the tiling tree with EFFECTIVE pane pixel sizes (`cols[…|…]` = side by side, `rows[…/…]` = stacked), and a crowding hint in the summary when a workspace is tight. Use it to place panes well — but you do NOT do the geometry yourself:
- Keep panes of the same project together; give unrelated work its own room.
- Beyond ~4–6 active panes in one workspace, prefer a fresh workspace (`create_panes` `workspace:"new"`) over cramming — unless the user wants them side by side.
- `arrangement` shapes the new panes (auto/rows/columns/grid); per-pane `beside:{pane_id,direction}` splits next to an existing pane ("put the review beside the build log").
- New panes are laid out equal-sized and the system OVERFLOWS into a new workspace automatically when they would not fit above a readable minimum — no manual size math; the tool result tells you honestly where everything landed.

## Delivery contract
- An explicit user order is your approval to execute it fully — do not ask for per-step confirmations.
- Never initiate outward-facing actions (push, PR, publish, anything leaving the machine) unless the user explicitly ordered them. You have no outward tools in this version; do not route around that via agent panes unprompted.
- prompt_pane submits by default (submit:true). If a pane is busy, prefer waiting or telling the user instead of queueing text into it — unless the user asked you to queue.

## Style
Answer the user in the language they use (this user usually writes German). Be compact: status lines and short paragraphs, not essays. Say what you did, what is running where, and what you are waiting on."#;

/// Compile the persona header from the editable fields (voice only).
fn persona_header(p: &PersonaSpec) -> String {
    let name = p.name.trim();
    let name = if name.is_empty() { "the SwarmZ Orchestrator" } else { name };
    let mut s = String::from("# Persona\n");
    let role = p.role.trim().trim_end_matches('.');
    if role.is_empty() {
        s.push_str(&format!("You are {name}.\n"));
    } else {
        s.push_str(&format!("You are {name} — {role}.\n"));
    }
    let tone = p.tone.trim();
    if !tone.is_empty() {
        s.push_str(&format!("Voice: {tone}\n"));
    }
    let principles: Vec<&str> = p
        .principles
        .iter()
        .map(|x| x.trim())
        .filter(|x| !x.is_empty())
        .collect();
    if !principles.is_empty() {
        s.push_str("Principles:\n");
        for pr in principles {
            s.push_str(&format!("- {pr}\n"));
        }
    }
    s.push_str(
        "\nThe operating manual below is fixed: your personality sets your voice and judgment, never the tools, safety rules or delivery contract.",
    );
    s
}

/// Assemble the full system instructions: persona header + operative core +
/// (optional) memory snapshot + memory-behaviour rule. `memory` is the
/// pre-rendered list of entry lines (empty string = no memory yet).
pub fn build_instructions(persona: &PersonaSpec, memory: &str) -> String {
    let mut out = persona_header(persona);
    out.push_str("\n\n");
    out.push_str(OPERATIVE_CORE);
    let memory = memory.trim();
    if !memory.is_empty() {
        out.push_str("\n\n## Your memory (curated facts you chose to remember)\n");
        out.push_str(memory);
    }
    out.push_str("\n\n");
    out.push_str(MEMORY_BEHAVIOR);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_the_maestro_seed() {
        let p = PersonaSpec::default();
        assert_eq!(p.name, "Maestro");
        assert!(!p.role.trim().is_empty());
        assert!(!p.principles.is_empty());
    }

    #[test]
    fn partial_payload_falls_back_to_seed_fields() {
        // only `name` provided → role/tone/principles come from the seed
        let p: PersonaSpec = serde_json::from_value(serde_json::json!({ "name": "Hive" })).unwrap();
        assert_eq!(p.name, "Hive");
        assert_eq!(p.principles, maestro().principles);
    }

    #[test]
    fn persona_compiles_before_the_operative_core() {
        let out = build_instructions(&PersonaSpec::default(), "");
        let persona_pos = out.find("Maestro").expect("persona name present");
        let core_pos = out.find("Context discipline").expect("core present");
        assert!(persona_pos < core_pos, "persona must precede the core");
    }

    #[test]
    fn operative_core_guardrails_are_present_verbatim() {
        let out = build_instructions(&PersonaSpec::default(), "");
        // the exact guardrail sentences the safety invariant depends on
        assert!(out.contains("SwarmZ Orchestrator"));
        assert!(out.contains("you never edit files or run commands yourself"));
        assert!(out.contains("Never initiate outward-facing actions"));
        assert!(out.contains("Layout & placement"));
        assert!(out.contains("Session approvals are decided by the HUMAN"));
        // custom-agents integration (Phase D) — start specialists via create_panes `agent`
        assert!(out.contains("Custom agents (specialists)"));
        assert!(out.contains("call list_agents"));
        assert!(out.contains("Each agent maintains its own memory itself; you never write into it."));
    }

    #[test]
    fn memory_block_present_only_when_non_empty() {
        let with = build_instructions(
            &PersonaSpec::default(),
            "- 2026-07-07 reviews go to Opus\n- 2026-07-07 never push without asking",
        );
        assert!(with.contains("## Your memory"));
        assert!(with.contains("reviews go to Opus"));
        // the behaviour rule is always there
        assert!(with.contains("## Remembering"));

        let without = build_instructions(&PersonaSpec::default(), "   ");
        assert!(!without.contains("## Your memory"));
        assert!(without.contains("## Remembering"));
    }

    #[test]
    fn custom_persona_voice_compiles_but_never_weakens_the_core() {
        let p = PersonaSpec {
            name: "Hive".into(),
            role: "the swarm's calm central voice".into(),
            tone: "terse, technical".into(),
            principles: vec!["signal over noise".into()],
        };
        let out = build_instructions(&p, "");
        assert!(out.contains("You are Hive — the swarm's calm central voice."));
        assert!(out.contains("Voice: terse, technical"));
        assert!(out.contains("signal over noise"));
        // guardrails still hard-wired regardless of persona
        assert!(out.contains("Never initiate outward-facing actions"));
    }
}
