# SwarmZ Design System

Dark-only, near-monochrome, shadcn-based. Hierarchy comes from **luminance and
spacing**, not hue. Color is rationed to a small set of *signals* with fixed
meanings — the signal triad below.

## Principles

1. **Monochrome first.** Backgrounds, borders, text: all neutral grays. If a UI
   element needs emphasis, make it brighter or give it a border — don't color it.
2. **The signal triad.** Every status couples **color + shape + word** — never
   color alone. Fixed meanings, app-wide:
   - **Blue `--ring` = where I am.** Focus rings, active pane border, selection,
     drop targets, the update pill, data viz. EXCLUSIVE — blue never marks
     attention or waiting.
   - **Amber `--attn` = where I'm needed.** Waiting-for-input panes, bell
     attention, triage badges: `⚑ needs you`. Reserved, never decorative. Soft
     tints via alpha utilities (`bg-attn/10` header wash, `border-attn/30`,
     `border-attn/60` pane outline).
   - **Green `--success` = ok / just finished.** A pane that leaves busy shows
     an ephemeral `✓ finished · 2m ago` moment that fades after ~5 min back to
     plain idle. Static green dots mean an actively-running process is fine
     (a plain shell's "running" dot, a running subagent). *Idle-but-alive*
     aggregates — the workspace-tab and fleet-card dots — stay **neutral
     faint**: a permanent green tab dot next to the green "✓ finished" word
     read as the same signal.
   - **Busy is quiet.** Working is the normal state: muted `▸ working` plus a
     barely-visible 1.5px activity hairline sweeping under the pane header. No
     amber, no pings.

   This deliberately supersedes the old "one accent" rule: blue lost its
   attention duty to `--attn` so that "where I am" and "where I'm needed" can
   never be confused.
3. **Motion doctrine.** *Events* flash once (150–300 ms, e.g. `arrive-flash`
   when a pane enters needs-you); *states* are static — the busy hairline is
   the only looping state animation and is near-invisible. A global
   `prefers-reduced-motion` block in `styles.css` collapses ALL nonessential
   animation.
4. **Numbers are mono.** Every metric (tokens, cost, counts, paths) renders in
   JetBrains Mono with `tabular-nums`. UI copy is Inter.
5. **Status colors only on status.** `--success` / `--warning` / `--destructive`
   appear exclusively on state indicators and destructive actions. `--warning`
   means genuine warnings (limit meters ≥ threshold, context pressure) — it
   never means "an agent needs the human"; that's `--attn`.
6. **No gradients, no glows.** Depth comes from the surface ladder and real
   shadows. (The activity hairline's sweep gradient is the one sanctioned
   exception — it reads as light, not decoration.)

## Token reference (`src/styles.css`)

Tokens follow the shadcn/ui naming convention, so `npx shadcn@latest add <component>`
produces correctly themed components without edits (`components.json` is configured).

| Token | Use |
|---|---|
| `--background` | App canvas, title bar, drawers |
| `--card` | Panes, stat cards, list rows, terminal background |
| `--popover` | Menus, dialogs, tooltips (highest surface) |
| `--secondary` | Inputs, kbd chips, inline pills |
| `--accent` | Hover wash on rows/buttons (NOT a color accent) |
| `--primary` | Primary action — light-on-dark button |
| `--border` / `--input` | Default border / stronger border (inputs, hover) |
| `--ring` | THE blue. Focus, active, selection — "where I am" (never attention) |
| `--attn` | Amber. "Where I'm needed" — waiting/attention only, never decorative |
| `--muted-foreground` / `--faint` | Secondary / tertiary text |
| `--success` / `--warning` / `--destructive` | Status only (`--success` also = the ephemeral "finished" moment) |
| `--diff-add` / `--diff-del` | Diff green/red — **code deltas** (Vibe diff cards, +N/−M counters). Distinct from `--success`/`--destructive` (process status); dark-tuned, washed via `color-mix` for the +/- line backgrounds |
| `--chart-1..5` | Data viz — a blue ramp, bright = most capable model |

Use them via Tailwind utility classes (`bg-card`, `text-muted-foreground`,
`border-ring/50`) — never hard-code hex values in components.

## Surface ladder

`background (#0c0c0e)` → `card (#111114)` → `secondary (#1a1a1e)` → `popover (#17171a, +shadow)`

Each level may sit on the one below it. Borders separate same-level surfaces.

## Surface physics & z-scale

Right-edge surfaces come in two deliberately distinct physics:

- **Drawers** (Quick Notes ⌘N, Usage) are *modal overlays*: dimmed backdrop,
  `animate-slide-in-right`, Escape closes, `role="dialog"` (engages the
  global-shortcut guard). They float **above** the app.
- **The orchestrator panel** (⌘⇧O) is *furniture*: a persistent flex sibling
  that squeezes the grid — flush `border-l` on `--background`, no backdrop,
  no entrance animation, Escape only blurs its input. It lives **next to**
  the app. Don't blur this line: a new overlay gets drawer physics, a new
  persistent surface gets panel physics.

Semantic z-scale (Tailwind `z-*`), matching actual usage — new chrome picks
the lowest layer that still covers what it must:

| Layer | z | Examples |
|---|---|---|
| Content | 0 | grid, panes, title bar, Deck, orchestrator panel |
| In-surface chrome | 10 | grid resize handles, fleet per-pane chrome, panel resize handle |
| Focus / fleet overlay | 20 / 30 | focus backdrop + drag previews + fleet header (20), zoomed focus pane (30) |
| Drawers | 30 / 40 | drawer backdrop (30), drawer + floating terminals (40) |
| Dialogs & menus | 50 | dialogs, ⌘K palette, dropdowns, popovers, tooltips |

## Typography

- UI: **Inter Variable** (`font-sans`, bundled via @fontsource — works offline).
- Data/terminal: **JetBrains Mono Variable** (`font-mono`).
- Headings: `font-semibold tracking-tight`. Section labels: `text-[10px] uppercase tracking-wider text-faint`.

## Model & agent identity

- Model families map to the blue ramp via `modelAccent()` in `src/lib/utils.ts`
  (Fable → chart-1 … Haiku → chart-4). Add new families there.
- Agents are identified by **name + position + active border**, not color.
  Profiles keep a desaturated identity dot (`AGENT_COLORS`).

## Adding new components

```sh
npx shadcn@latest add command   # e.g. command palette
```

Generated components land in `src/components/ui/` and pick up the theme
automatically. Review the result: replace any `bg-popover`-level decisions that
conflict with the surface ladder, and keep motion to the existing keyframes
(`animate-in`, `animate-dialog-in`, `animate-slide-in-right`).

## Keyboard & focus

- **Every interactive element shows the blue ring on `:focus-visible`.**
  `ui/*` primitives carry their own `focus-visible:ring-2 ring-ring/40`
  utilities; raw `<button>`s and focusable spans use the shared `.focus-ring`
  class (styles.css) — same ring, one place. Mouse clicks stay ring-free.
- **Hover-revealed controls reveal on keyboard focus too** (workspace-tab
  close X, note-row actions, chat delete): use `opacity-0` +
  `group-hover:opacity-100` + `focus-visible:opacity-100` — never
  `display:none`, which removes the tab stop.
- **Data-bearing tooltips need a keyboard path**: give the trigger span
  `tabIndex={0}` (Radix tooltips open on focus) — meter chips, git chip,
  context gauge, subagent chips.
- **No nested interactives.** A close/delete affordance inside a button or
  menu item becomes a real sibling `<button>` (workspace tabs) or the list
  becomes a popover of sibling buttons (orchestrator chat switcher).
- UI copy is English only — one product language, including orchestrator
  status pings and prompts it sends on the user's behalf (the model itself
  answers in whatever language the user types).

## Layout conventions

- Radius: `rounded-md` for controls, `rounded-lg` for cards/panes, `rounded-xl` for dialogs.
- Control heights: 36px (`h-9`) default, 32px (`h-8`) compact, 24px (`h-6`) inline icon buttons.
- Spacing inside cards: `p-3` (stats), `p-2.5` (rows), dialogs `p-5`.
- **Title bar = place/navigation, Deck = system status.** The Deck
  (`components/Deck.tsx`) is a permanent, slim (~30 px) status bar under the
  workspace grid on the `--background` surface (mirroring the title bar):
  triage queue (`⚑ N need you` in `--attn`, silent at zero), fleet event
  ticker, the subscription meters (moved out of the title bar) and the
  orchestrator status dot. Everything in it is 10px mono + `tabular-nums`;
  triad colors only per their fixed meanings. It never grows — the grid owns
  every extra pixel.
- No sidebar by design — the tiling grid owns the viewport. Top-level navigation
  is the workspace tab strip inside the title bar; new global features go into
  the title bar, a drawer (like UsageDashboard), the command palette (⌘K) or
  the fleet overview (⌘E). The **one deliberate exception** is the orchestrator
  chat panel (⌘⇧O): a resizable right-hand flex sibling that squeezes the grid,
  because the user works with it open. Its conventions: panel surface stays on
  `--background` with `--secondary` user bubbles, tool/data lines are compact
  mono chips in `--muted-foreground`/`--faint`, and `--warning` only on failures.
- **Vibe Mode** (⌘⇧V) is a whole second *view*, not a grid-mode sidebar: the
  title-bar segmented switch swaps the grid for a rail + focus stage (the Deck
  stays). Its surfaces follow the ladder — `--card` rail cards and item cards on
  the `--background` view, borders separating them, `--secondary` user bubbles.
  Assistant messages reuse the orchestrator's markdown convention: a *finished*
  message renders as the shared `OrchestratorMarkdown` subset (bold/italic,
  inline + fenced code, lists, links); a *streaming* one stays plaintext with
  the caret. Code is mono; fenced blocks sit on `--card` with `overflow-x`.
  It obeys the signal triad exactly: a session card couples color + shape + word
  (`▸ working` muted + the busy hairline / `⚑ needs you` amber / `✓ finished ·
  Xm` ephemeral green / `· idle` neutral), the active card wears the blue ring,
  and the context gauge uses `--warning` (never amber) only at genuine pressure
  (≥90%). The rail's busy hairline reuses the pane sweep pinned to the top edge
  (`.activity-line.activity-line-top`) — still the only looping state animation.
  **Diff cards** (`@git-diff-view`, re-themed to `--diff-add`/`--diff-del` + the
  app tokens, scoped to the lib's `.diff-tailwindcss-wrapper`) collapse large
  sets by default and highlight lazily off-thread; every +N/−M counter uses the
  diff tokens. A pending approval **takes over the composer** (amber panel,
  ⏎ = Allow / ⎋ = Decline via a local handler — no new global shortcut) rather
  than living only as a feed card; a pending approval in another session shows a
  thin amber cross-session banner atop the stage.
- **Chat is human-readable, not a dev log** (both the orchestrator chat and the
  Vibe feed, `components/orchestrator/ChatView.tsx` + `ItemFeed.tsx`). Three
  conventions:
  - **Reading width.** The message column is capped (`CHAT_MAX_W ≈ 46rem`) and
    centered, with the composer flush beneath it. Body text is ~13.5px Inter
    with generous leading and paragraph rhythm; tool/meta lines stay small mono
    and **recede** (`text-faint`) — they never compete with the prose.
  - **One quiet line for everything non-prose.** Tool steps, status pings and
    warnings all render through a single `QuietLine` shape (status glyph + human
    text + optional tooltip + trailing chips) so the feed reads as one calm,
    homogeneous stream — never a dev log. The status glyph obeys the triad:
    `✓ --success` (done / a pane finished), `⚠ --warning` (a failed step or
    warning), `⚑ --attn` (a pane waiting for input), a neutral `·`/`…` while
    running or for an unclassifiable line. **Human verbs only** — never raw tool
    names; those live in the tooltip. A **lone** tool step renders as one quiet
    line (no disclosure); **consecutive** tool calls still fold into a
    collapsible block ("Working · N steps") that expands to the per-step list,
    with pane/session **jump chips first-class** (a union row even while
    collapsed) and failed steps visible collapsed. The rule is
    forward-proof: an unknown tool degrades to "Used a tool", an unknown ping to
    the neutral marker — no raw name or iconless line ever surfaces.
  - **Path pills.** Absolute and `~/…` paths in assistant prose render as a
    compact pill — filename prominent, directory dimmed + middle-elided, full
    path in the tooltip (not a link). Detection runs on text nodes **after**
    markdown parsing, never inside code spans or fenced blocks.
- **Model / effort are visible and changeable everywhere.** Every chat/session
  surface shows its model · effort · context; the model/effort is a **clickable
  chip** opening the shared `ModelEffortPicker` (session header, Conductor/panel
  header). The picker states "applies from the next turn" — the change is a
  per-turn override, never a silent restart. Rail cards show the same meta
  read-only.
