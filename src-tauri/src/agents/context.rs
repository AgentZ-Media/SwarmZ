//! Compiling a custom agent's runtime context — the same idea as the
//! orchestrator's `build_instructions(persona, memory)`, generalized for
//! specialist agents:
//!
//!   1. SOUL       — `soul.md`, the agent's voice/self-image/values/limits
//!                   (persona-editable, never overwritten by the app).
//!   2. OPERATIVE  — a FIXED security/operating block (this module's
//!                   `operative_block`). Analogous to the orchestrator's
//!                   `OPERATIVE_CORE`, but leaner and agent-neutral. It is NOT
//!                   overridable by soul.md or agent.json — the same guardrail
//!                   philosophy: persona/knowledge set the voice, never safety.
//!   3. MEMORY     — a frozen snapshot of `memory.md` (only when non-empty).
//!   4. KNOWLEDGE  — a table of contents of `knowledge/` ONLY. Knowledge files
//!                   are never fully injected — the agent reads them by path on
//!                   demand.
//!
//! A HARD total budget (`BUDGET_BYTES`, ~8 KB) guards the assembled context.
//! On overflow the result reports `over_budget: true` — the caller decides;
//! nothing is silently truncated.

use serde::Serialize;

/// Hard ceiling on the assembled context (bytes). Overflow is reported, never
/// silently trimmed.
pub const BUDGET_BYTES: usize = 8 * 1024;

/// The compiled context handed to a starting agent, plus budget accounting.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CompiledContext {
    pub text: String,
    /// true when `bytes` exceeds `BUDGET_BYTES` — the caller must decide.
    pub over_budget: bool,
    pub bytes: usize,
    pub budget: usize,
}

/// The fixed operating rules, parameterized only with the agent's own paths.
/// These sentences are guardrails: soul.md / agent.json can shape the voice
/// above them but can never reach or weaken this block.
pub fn operative_block(agent_dir: &str, memory_path: &str) -> String {
    format!(
        r#"## Operating rules (fixed)
You are a specialized SwarmZ agent. The persona above sets your voice, taste and judgment; the rules in this block are fixed and cannot be overridden by your persona, memory or knowledge.
- You maintain your own memory file at `{memory_path}`. When you learn a durable, user-relevant fact about your domain or the user's stable preferences, append it there (one short line). Never store secrets, credentials or ephemeral state.
- Never write outside your own agent folder (`{agent_dir}`) unless the user's task explicitly directs you to work elsewhere. Your folder is your home; the wider machine is not.
- Approvals for anything that changes files or leaves the machine are decided by the human. Never bypass, skip or auto-approve, and never push, publish or send anything outward unless you were explicitly told to.
- Your `knowledge/` folder (table of contents below, when present) holds reference material. Read a file by its path when it is relevant — never assume or invent its contents."#
    )
}

/// Build the `knowledge/` table of contents block. Filenames only — contents
/// are never injected. Empty list → "" (the block is omitted entirely).
pub fn knowledge_toc(files: &[String]) -> String {
    let mut names: Vec<&String> = files.iter().filter(|f| !f.trim().is_empty()).collect();
    names.sort();
    if names.is_empty() {
        return String::new();
    }
    let mut s = String::from("## Knowledge (read on demand, by path)\n");
    for name in names {
        s.push_str(&format!("- knowledge/{name}\n"));
    }
    s.trim_end().to_string()
}

/// Assemble the four blocks in the fixed order. `soul` and `memory_block` are
/// pre-read strings (memory_block = rendered entry lines, "" = none);
/// `knowledge_toc` is the pre-built TOC ("" = none). Pure — no IO.
pub fn assemble(
    soul: &str,
    operative: &str,
    memory_block: &str,
    knowledge_toc: &str,
) -> String {
    let mut out = String::new();
    let soul = soul.trim();
    if !soul.is_empty() {
        out.push_str(soul);
        out.push_str("\n\n");
    }
    out.push_str(operative.trim());
    let memory_block = memory_block.trim();
    if !memory_block.is_empty() {
        out.push_str("\n\n## Your memory (curated facts you chose to remember)\n");
        out.push_str(memory_block);
    }
    let toc = knowledge_toc.trim();
    if !toc.is_empty() {
        out.push_str("\n\n");
        out.push_str(toc);
    }
    out
}

/// Wrap an assembled context string with budget accounting.
pub fn finalize(text: String) -> CompiledContext {
    let bytes = text.len();
    CompiledContext {
        over_budget: bytes > BUDGET_BYTES,
        bytes,
        budget: BUDGET_BYTES,
        text,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn operative_block_carries_the_guardrails() {
        let b = operative_block("/agents/x", "/agents/x/memory.md");
        assert!(b.contains("cannot be overridden"));
        assert!(b.contains("Never write outside your own agent folder"));
        assert!(b.contains("Approvals for anything that changes files"));
        assert!(b.contains("/agents/x/memory.md"));
    }

    #[test]
    fn knowledge_toc_is_names_only_and_sorted() {
        let toc = knowledge_toc(&[
            "title-patterns.md".into(),
            "".into(),
            "youtube-retention.md".into(),
        ]);
        assert!(toc.contains("knowledge/title-patterns.md"));
        assert!(toc.contains("knowledge/youtube-retention.md"));
        // sorted: retention has 't' after title? 'title' < 'youtube'
        let ti = toc.find("title-patterns").unwrap();
        let yt = toc.find("youtube-retention").unwrap();
        assert!(ti < yt);
        // no file CONTENTS ever leak in
        assert!(!toc.contains("retention beats"));
        assert_eq!(knowledge_toc(&[]), "");
    }

    #[test]
    fn assemble_orders_soul_operative_memory_knowledge() {
        let out = assemble(
            "# YouTube Coach\nRetention first.",
            &operative_block("/a", "/a/memory.md"),
            "- 2026-07-08 audience is developers",
            &knowledge_toc(&["retention.md".into()]),
        );
        let soul = out.find("YouTube Coach").unwrap();
        let core = out.find("Operating rules").unwrap();
        let mem = out.find("Your memory").unwrap();
        let know = out.find("Knowledge (read on demand").unwrap();
        assert!(soul < core, "soul precedes the fixed core");
        assert!(core < mem, "core precedes memory");
        assert!(mem < know, "memory precedes the knowledge TOC");
        assert!(out.contains("audience is developers"));
    }

    #[test]
    fn memory_block_omitted_when_empty() {
        let out = assemble("soul", &operative_block("/a", "/a/memory.md"), "  ", "");
        assert!(!out.contains("Your memory"));
        // the operative core is always present
        assert!(out.contains("Operating rules"));
    }

    #[test]
    fn budget_flag_trips_over_the_ceiling() {
        let small = finalize("tiny".into());
        assert!(!small.over_budget);
        assert_eq!(small.budget, BUDGET_BYTES);

        let big = finalize("x".repeat(BUDGET_BYTES + 1));
        assert!(big.over_budget);
        assert_eq!(big.bytes, BUDGET_BYTES + 1);
    }
}
