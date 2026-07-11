// Agent name generator — pure, no store access. Every session gets a short
// international first name (its `agentName`): collision-free within a
// project, deterministic under an injected RNG (tests), with a numeric
// suffix once the pool is exhausted ("Maya 2"). Branch names for Phase 4's
// worktrees derive from the same identity (`swarm/maya-checkout`).

/**
 * 130+ short international first names — European, Asian, Latin-American,
 * African and Middle-Eastern, leaning unisex. Deliberately no surnames, no
 * two-word names: the name must fit a rail card and slug into a branch.
 */
export const AGENT_NAME_POOL: readonly string[] = [
  // European
  "Maya", "Jonas", "Luca", "Ines", "Milo", "Zoë", "Emil", "Alva", "Nico",
  "Lena", "Anton", "Mara", "Otis", "Ida", "Juno", "Elia", "Nova", "Rasmus",
  "Freja", "Björn", "Anouk", "Sven", "Liv", "Timo", "Ronja", "Kai", "Elsa",
  "Arlo", "Nils", "Vera", "Oskar", "Enna", "Janne", "Mika", "Sasha", "Ilya",
  "Katja", "Marek", "Zofia", "Andrei", "Petra", "Dario", "Chiara", "Enzo",
  "Alba", "Mateo", "Noa", "Iker", "Nerea", "Tiago", "Beatriz",
  // Asian
  "Kenji", "Ravi", "Aiko", "Hana", "Jin", "Yuki", "Ren", "Sora", "Kaito",
  "Mei", "Tara", "Arjun", "Priya", "Dev", "Anik", "Sana", "Rin", "Haru",
  "Minh", "Linh", "Anh", "Bao", "Jia", "Wei", "Ling", "Chen", "Yuna",
  "Jiho", "Ari", "Suki", "Kavi", "Nila", "Reza", "Omid", "Leila",
  // Latin-American
  "Luna", "Diego", "Camila", "Andrés", "Valentina", "Thiago", "Elena",
  "Bruno", "Sofía", "Emilio", "Paloma", "Rafael", "Ximena", "Joaquín",
  "Renata", "Iván", "Alma", "Mauro", "Itzel", "Nicolás",
  // African & Middle-Eastern
  "Amara", "Kofi", "Zuri", "Ayo", "Nia", "Tunde", "Imani", "Sefu", "Adia",
  "Chike", "Femi", "Zola", "Kwame", "Asha", "Jelani", "Amina", "Idris",
  "Layla", "Tariq", "Yara", "Samir", "Nadia", "Zain", "Rania", "Karim",
  "Aziza", "Malik", "Selam", "Abeba", "Naledi",
];

/**
 * Pick a fresh agent name: a uniformly random pool name not yet taken
 * (case-insensitive). Exhausted pool → a random base name with the lowest
 * free numeric suffix ("Maya 2", "Maya 3", …). `rng` is injectable for
 * deterministic tests; it must return a float in [0, 1).
 */
export function pickAgentName(
  takenNames: Iterable<string>,
  rng: () => number = Math.random,
): string {
  const taken = new Set<string>();
  for (const n of takenNames) taken.add(n.trim().toLowerCase());
  const free = AGENT_NAME_POOL.filter((n) => !taken.has(n.toLowerCase()));
  if (free.length > 0) {
    return free[Math.min(Math.floor(rng() * free.length), free.length - 1)];
  }
  // pool exhausted — suffix a random base with the lowest free number
  const base =
    AGENT_NAME_POOL[
      Math.min(
        Math.floor(rng() * AGENT_NAME_POOL.length),
        AGENT_NAME_POOL.length - 1,
      )
    ];
  let n = 2;
  while (taken.has(`${base} ${n}`.toLowerCase())) n++;
  return `${base} ${n}`;
}

/** Max characters the task part of a branch slug contributes. */
const TASK_SLUG_MAX = 24;

/**
 * ASCII-slug a free-text fragment: diacritics stripped via NFKD (Zoë → zoe),
 * lowercased, anything non-alphanumeric collapses to single hyphens.
 */
export function asciiSlug(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // combining diacritical marks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Branch name for an agent's worktree: `swarm/<name>` or
 * `swarm/<name>-<task>`, all ASCII. The task fragment is slugged and capped
 * at a word boundary (~24 chars) so branch names stay readable
 * (`swarm/maya-checkout`). A name that slugs to nothing falls back to
 * "agent".
 */
export function branchSlugForAgent(name: string, task?: string): string {
  const nameSlug = asciiSlug(name) || "agent";
  let taskSlug = task ? asciiSlug(task) : "";
  if (taskSlug.length > TASK_SLUG_MAX) {
    const cut = taskSlug.lastIndexOf("-", TASK_SLUG_MAX);
    taskSlug = taskSlug.slice(0, cut > 0 ? cut : TASK_SLUG_MAX);
  }
  return taskSlug ? `swarm/${nameSlug}-${taskSlug}` : `swarm/${nameSlug}`;
}
