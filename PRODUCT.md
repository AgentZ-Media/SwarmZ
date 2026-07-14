# SwarmZ Product

## Product

SwarmZ is a native macOS Mission Control for orchestrating temporary Codex
workers across large software-engineering goals. It turns a backlog of tasks
into bounded, observable work, keeps every task tied to a project and
worktree, and helps the user reach one reviewed and verified integrated result.

The removed terminal-grid, Claude runtime, reusable agent profiles, workspace
presets and voice paths are historical only. Git history and the archived
rebuild plan preserve that context; they are not product inputs.

## Users

SwarmZ is for developers and technical creators who build substantial apps
with Codex and need to coordinate many changes without manually supervising
every lane. They care about speed, but they care more about knowing what is
running, what needs them, what evidence proves a task is complete, and whether
parallel branches form one coherent product.

## Core model

- One project-scoped **Orchestrator** owns decomposition, coordination and
  learning. It has one fixed product identity plus transparent global/project
  memory; it is the only persistent agent identity.
- **Workers are temporary task attempts.** They have no persona or memory, are
  never reused for a different assignment, and may resume only to recover or
  continue the same active attempt.
- A **Mission** is durable structured state: tasks, dependencies, acceptance
  criteria, attempts, evidence, decisions, budgets and an event log. Markdown
  is an import/export and human-readable projection, not the source of truth.
- A task is not done until its configured verification and integration gates
  pass. A finished worker is an input to that process, not proof of completion.

## Product principles

1. Mission state over chat memory.
2. Bounded autonomy over unbounded activity.
3. Fresh temporary workers over reusable personalities.
4. One writer per worktree and explicit ownership of every task attempt.
5. Evidence over self-reported success.
6. Integrated product state over a pile of finished branches.
7. Human authority for destructive, outward-facing and consequential choices.
8. Local-first, fail-closed security with visible recovery when state is
   uncertain.

## Experience principles

- Mission progress, blockers, risk, critical path and the next human decision
  must be understandable without reading transcripts.
- Fleet and focus views remain the live execution lens; Mission Control is the
  default planning, verification and integration surface.
- Approvals, structured questions, failed gates, conflicts and PR/CI issues
  share one global Attention Inbox.
- Dense information is welcome; hidden state, ambiguous color and decorative
  complexity are not.
- Every primary flow is keyboard-operable, WCAG-AA legible, responsive at the
  supported minimum window and compatible with reduced motion.

## Trust boundaries

- Worker output, repository content, memory entries and external PR/CI data are
  untrusted data. None may grant authority or alter the fixed operating manual.
- Persistence read failures never become empty data, and durable claims are
  written before autonomous side effects begin.
- Worktree, filesystem, process, output, concurrency, time and token usage are
  explicitly bounded.
- No automatic push, merge, comment, review or other outward-facing action runs
  outside the user's approved mission envelope and the existing Rust gates.
