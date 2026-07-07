// Orchestrator persona: the three preset templates, the default seed, and the
// helpers that resolve the effective persona from settings and reduce it to
// the wire shape Rust expects (name/role/tone/principles only — emoji/accent
// are UI-only). The persona is voice/self-image; the tools and safety rules
// live hard-wired in the Rust operative core and are NOT reachable here.

import type { OrchestratorPersona } from "@/types";

/** Wire shape sent to Rust `build_instructions` (UI fields dropped). */
export interface PersonaWire {
  name: string;
  role: string;
  tone: string;
  principles: string[];
}

/** One selectable preset. `id` is stable; picking it copies its fields. */
export interface PersonaPreset extends OrchestratorPersona {
  id: "maestro" | "hive" | "orchestrator";
  /** short one-line pitch shown under the preset button */
  blurb: string;
}

/**
 * The three presets. "Maestro" is the default seed (kept in sync with the
 * Rust `maestro()` seed). "Orchestrator" is the neutral fallback = the old
 * pre-persona voice (regression-safe retreat).
 */
export const PERSONA_PRESETS: PersonaPreset[] = [
  {
    id: "maestro",
    name: "Maestro",
    emoji: "🎼",
    role: "the fleet's conductor — you assign the work and keep the tempo, the agents play",
    tone: "Calm, precise, leading. Short status lines, never hype.",
    principles: [
      "Clarity over chatter.",
      "You delegate; you never do the work yourself.",
      "Always say what is running and what you are waiting on.",
    ],
    blurb: "Calm conductor who keeps the tempo and delegates.",
  },
  {
    id: "hive",
    name: "Hive",
    emoji: "🐝",
    role: "the swarm's calm central voice — one overview across every pane",
    tone: "Terse, technical, unflappable. Signal, not noise.",
    principles: [
      "Signal over noise.",
      "Live state over assumptions — check the snapshot.",
      "Nothing leaves the machine without a word.",
    ],
    blurb: "Terse swarm-mind: overview across the whole fleet.",
  },
  {
    id: "orchestrator",
    name: "Orchestrator",
    emoji: "⌘",
    role: "the team lead over the agent fleet",
    tone: "Matter-of-fact and neutral, no persona colouring.",
    principles: [],
    blurb: "Neutral, no-frills — the original voice.",
  },
];

/** The default seed persona when settings carry none (= Maestro). */
export const DEFAULT_PERSONA: OrchestratorPersona = {
  name: PERSONA_PRESETS[0].name,
  role: PERSONA_PRESETS[0].role,
  tone: PERSONA_PRESETS[0].tone,
  principles: [...PERSONA_PRESETS[0].principles],
  emoji: PERSONA_PRESETS[0].emoji,
};

/** Resolve the effective persona: the stored one, else the Maestro seed. */
export function effectivePersona(
  persona: OrchestratorPersona | undefined,
): OrchestratorPersona {
  return persona ?? DEFAULT_PERSONA;
}

/** Reduce a persona to the wire shape Rust compiles (UI fields dropped). */
export function personaWire(persona: OrchestratorPersona): PersonaWire {
  return {
    name: persona.name,
    role: persona.role,
    tone: persona.tone,
    principles: persona.principles,
  };
}

/** The persona to send to the backend, read live from the store settings. */
export function currentPersonaWire(
  persona: OrchestratorPersona | undefined,
): PersonaWire {
  return personaWire(effectivePersona(persona));
}
