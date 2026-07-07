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
