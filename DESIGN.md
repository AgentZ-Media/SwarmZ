# SwarmZ Design System

Dark-only, near-monochrome, shadcn-based. Hierarchy comes from **luminance and
spacing**, not hue. One accent color exists — a muted blue — and it is rationed.

## Principles

1. **Monochrome first.** Backgrounds, borders, text: all neutral grays. If a UI
   element needs emphasis, make it brighter or give it a border — don't color it.
2. **Blue is a signal, not a decoration.** `--ring` (#5b8def) marks: focus
   rings, the active pane border, attention state, selection, data viz. Nothing else.
3. **Numbers are mono.** Every metric (tokens, cost, counts, paths) renders in
   JetBrains Mono with `tabular-nums`. UI copy is Inter.
4. **Status colors only on status.** `--success` / `--warning` / `--destructive`
   appear exclusively on state indicators and destructive actions.
5. **No gradients, no glows.** Depth comes from the surface ladder and real shadows.

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
| `--ring` | THE blue. Focus, active, attention, selection |
| `--muted-foreground` / `--faint` | Secondary / tertiary text |
| `--success` / `--warning` / `--destructive` | Status only |
| `--chart-1..5` | Data viz — a blue ramp, bright = most capable model |

Use them via Tailwind utility classes (`bg-card`, `text-muted-foreground`,
`border-ring/50`) — never hard-code hex values in components.

## Surface ladder

`background (#0c0c0e)` → `card (#111114)` → `secondary (#1a1a1e)` → `popover (#17171a, +shadow)`

Each level may sit on the one below it. Borders separate same-level surfaces.

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

## Layout conventions

- Radius: `rounded-md` for controls, `rounded-lg` for cards/panes, `rounded-xl` for dialogs.
- Control heights: 36px (`h-9`) default, 32px (`h-8`) compact, 24px (`h-6`) inline icon buttons.
- Spacing inside cards: `p-3` (stats), `p-2.5` (rows), dialogs `p-5`.
- No sidebar by design — the tiling grid owns the viewport. Top-level navigation
  is the workspace tab strip inside the title bar; new global features go into
  the title bar, a drawer (like UsageDashboard), the command palette (⌘K) or
  the fleet overview (⌘E). The **one deliberate exception** is the orchestrator
  chat panel (⌘⇧O): a resizable right-hand flex sibling that squeezes the grid,
  because the user works with it open. Its conventions: panel surface stays on
  `--background` with `--secondary` user bubbles, tool/data lines are compact
  mono chips in `--muted-foreground`/`--faint`, and `--warning` only on failures.
