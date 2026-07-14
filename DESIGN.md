# SwarmZ Design System — "Vibe v3"

Dark only. One accent. The system lives in `src/styles.css` (tokens) and this
document (rules). Phase 6 stage 1 established the tokens; stage 2 migrated
every component onto them — components use ONLY the Vibe v3 utilities below
(the shadcn-compat aliases at the bottom remain solely for freshly generated
shadcn components and the `--chart-*` ramp).

## Principles

1. **The accent is the leitmotif.** `--acc #f0567c` marks **active / focus /
   the Conductor** — "where I am". This is a deliberate break with the old
   "ration color, near-monochrome" doctrine: the accent appears wherever the
   user's attention currently lives (focus rings, the active card border, the
   Conductor orb and its `//` sigil, primary CTAs, selection, the streaming
   caret, the busy sweep) and **nowhere else**. It never means "needs you",
   never "finished", never "warning".
2. **The signal logic.** Every status couples color + shape + word, app-wide:
   - **`--acc` = active / where-I-am.** Focus, selection, the working sweep,
     the Conductor's identity, send buttons. Exclusive.
   - **`--attn` (amber) = needs you.** Pending approvals, waiting agents,
     the needs-you pill and flag glyph `⚑`. Reserved, never decorative. Soft
     washes via alpha: `bg-attn/10` header wash, `border-attn/25`…`/55`.
   - **`--ok` (green) = finished / passing.** Checkmarks, the ephemeral
     "✓ finished · 2m" moment, passing tests. Idle-but-alive dots stay
     neutral `--fnt` — a permanent green dot would read as "finished".
   - **`--err` / `--warn` = failure / genuine warning.** `--err` on failed
     turns, destructive actions, close-confirm CTAs. `--warn` on limit
     meters and context pressure — never "an agent needs the human"
     (that's `--attn`).
   - **Busy is quiet.** Working is the normal state: a muted `▸ working…`
     line plus the thin accent-light sweep (`zsweep`) across the working
     header. No amber, no pings.
3. **Surfaces climb, text descends.** Hierarchy comes from the two ladders
   (surface `bg → panel → card → pop`, text `txt → mut → fnt`) plus spacing —
   not from extra hues.
4. **Numbers are mono.** Every metric, path, model name, keyboard hint,
   section label and ticker renders in Geist Mono with `tabular-nums`.
   UI copy is Geist.
5. **Gradients belong to the brand only.** The hexagon mark and the Conductor
   orb carry the accent gradient; everything else is flat surfaces + real
   shadows. (The busy sweep's light band is the sanctioned exception — it
   reads as light, not decoration.)
6. **Motion doctrine.** Events flash once (120–300 ms: `zfadeup`, `zdialog`,
   `ztoast`, `arrive-flash`); states are static except the sanctioned ambient
   loops (`zsweep` busy, `zcaret` streaming, `zattn` waiting, `zpulse`/`zglow`
   Conductor orb, `zeq` deck equalizer). `prefers-reduced-motion` and the
   in-app `data-motion="off"` switch collapse all of it.

## Color tokens

### Accent (the leitmotif)

| Token | Value | Use |
|---|---|---|
| `--acc` | `#f0567c` | THE accent: focus/active/Conductor/CTA |
| `--acc-hot` | acc 80 % → white | sweep band, streaming caret, orb highlight |
| `--acc-bright` | acc 70 % → white | link hover |
| `--acc-deep` | acc 55 % → `#401020` | brand-gradient end (`.hex-mark-flat`) |
| `--acc-dim` | acc 50 % → black | orb shadow side |
| `--acc-100…900` | mixed scale | ramps/data viz (100 lightest) |

Washes come from alpha utilities, not extra tokens: `bg-acc/8` hover tint,
`bg-acc/10` selected row, `border-acc/55` hover border, `ring-acc/40` focus.

### Surface ladder (each level may sit on the one below)

| Token | Value | Use |
|---|---|---|
| `--bg` | `#09090c` | app canvas, focus stage |
| `--panel` | `#0d0d11` | title bar, deck, sidebars |
| `--card` (`--card-surface`) | `#121217` | agent cards, composer, inputs, feed blocks |
| `--pop` | `#191920` | menus, dialogs, toasts, user bubbles — highest, always with a shadow |

### Lines

| Token | Value | Use |
|---|---|---|
| `--line` | `#1e1e26` | default border, separators |
| `--line2` | `#2b2b35` | stronger border: dialog/popover edges, inputs, hover, scrollbar thumb |

Borders separate same-level surfaces; a raised surface (pop) gets `--line2` +
shadow. Fill (`bg-acc/…`, `bg-attn/…`) is for *state*, border for *structure* —
a card that needs attention gets an attn-tinted border **and** header wash,
never a full-surface fill.

### Text ladder

| Token | Value | Use |
|---|---|---|
| `--txt` | `#e9eaee` | primary copy, names, headings |
| `--mut` | `#9da0ab` | secondary copy, chat meta, mini-feed |
| `--fnt` | `#858892` | tertiary: placeholders, section labels, paths, tickers, idle dots; AA-readable on app surfaces |

### Semantics & diff

| Token | Value | Use |
|---|---|---|
| `--attn` | `#f0a13a` | needs-you (see signal logic) |
| `--ok` | `#46c07a` | finished / passing |
| `--warn` | `#d6a243` | genuine warnings: limits, ctx pressure |
| `--err` | `#e5544d` | failures, destructive actions |
| `--add` / `--del` | `#3fb950` / `#f85149` | code deltas ONLY (+N/−M counters, diff washes at 11–12 % alpha) — distinct from `--ok`/`--err` process status |

Tailwind utilities exist for every token: `bg-panel`, `bg-pop`, `border-line`,
`border-line2`, `text-txt`, `text-mut`, `text-fnt`, `bg-acc`, `text-attn`,
`text-ok`, `text-warn`, `text-err`, `text-add`, `text-del`, `bg-acc-700`, …
Never hard-code hex values in components.

Small text on solid accent or destructive CTAs always uses `text-bg`
(`bg-acc text-bg` / `bg-err text-bg`) for WCAG-AA contrast. White is reserved
for icon-only foregrounds on those fills, where the non-text 3:1 threshold is
met; it must not be reused for labels.

## Spacing

Base unit 4 px (Tailwind's default `--spacing: 0.25rem`). The sanctioned
ladder — use these steps, nothing in between:

| px | Tailwind | Typical use |
|---|---|---|
| 2 | `0.5` | glyph-to-text micro gaps |
| 4 | `1` | chip padding-y, tight stacks |
| 6 | `1.5` | chip gaps, list-row stacks |
| 8 | `2` | element gaps, card padding-y |
| 10 | `2.5` | composer/bubble padding-y |
| 12 | `3` | card padding, grid gap, dialog rows |
| 16 | `4` | container padding (headers, panels, grids) |
| 20 | `5` | section spacing inside dialogs |
| 24 | `6` | dialog padding, focus-feed padding |

Fixed chrome heights: title bar and section headers **48 px** (`h-12`), deck
**32 px** (`h-8`), buttons 32 px (`h-8`) / 28 px compact / 26 px inline.

## Typography

- UI copy: **Geist** (`font-sans`, bundled via `@fontsource-variable/geist`).
- Numbers/code/labels/meta: **Geist Mono** (`font-mono`,
  `@fontsource-variable/geist-mono`) — always with `tabular-nums` on figures.
- The scale is pixel-named, six sizes only:

| Utility | Size | Use |
|---|---|---|
| `text-10` | 10 px | section labels (`uppercase tracking-[.08em] font-medium text-fnt font-mono`), tiny meta |
| `text-11` | 11 px | mono meta: chips, deck, ctx %, tickers, kbd hints |
| `text-12` | 12 px | secondary copy, mini-feed lines, settings subtext |
| `text-13` | 13 px | body (the `body` default), chat, composer |
| `text-14` | 14 px | in-place headings: pane titles, palette input |
| `text-16` | 16 px | dialog titles |

- Weights: 400 body · 500 labels/emphasized UI · 600 headings, agent names,
  CTAs · 700 brand wordmark, mono-strong (approval header, Allow).
- Headings/wordmark get `tracking-[-0.01em]`; section labels `tracking-[.08em]`.
- Body line-height 1.6 (chat), meta 1.5.
- Legacy `text-xs`/`text-sm`/`text-[10px]`-style arbitrary sizes are gone —
  every component sits on the six-step scale. Don't reintroduce them.

## Sizing, radius, elevation

Radius scale (tokens in `@theme`, so `rounded-*` maps exactly):

| Utility | px | Use |
|---|---|---|
| `rounded-xs` | 4 | kbd chips, inline code |
| `rounded-sm` | 6 | chips, pills, small buttons, mini-composer send |
| `rounded-md` | 8 | buttons, inputs, recents rows |
| `rounded-lg` | 10 | feed cards (cmd/diff/approval), plan panel |
| `rounded-xl` | 12 | agent cards, composer, model picker, toasts, bubbles (`rounded-xl rounded-br-[4px]` user bubble) |
| `rounded-2xl` | 16 | dialogs |
| `rounded-full` | — | dots, meters, scrollbar |

Elevation = ladder + one shadow per layer (`@theme` tokens):

| Utility | Use |
|---|---|
| `shadow-card` | hover-lift on grid cards (`0 8px 24px /.3`) |
| `shadow-pop` | anchored popovers, pickers, suggestions (`0 12px 40px /.5`) |
| `shadow-toast` | toasts (`0 12px 32px /.5`) |
| `shadow-modal` | centered dialogs (`0 24px 80px /.6`) |

Backdrops: `rgba(5,5,8,.55–.6)` + `backdrop-blur` ~2–3 px, entering with
`animate-zoverlay`.

## Motion

All keyframes live in `styles.css`; each has a Tailwind utility
(`animate-z*`) and the timing is part of the token:

| Utility | Loop? | Meaning |
|---|---|---|
| `animate-zsweep` | ∞ | busy hairline band (2.6 s) — via `.activity-line` |
| `animate-zpulse` | ∞ | accent dot breathing + ring (working card dot, Conductor) |
| `animate-zattn` | ∞ | waiting flag blink (2 s) — pair with `text-attn` |
| `animate-zcaret` | ∞ | streaming caret / running `…` (1 s) |
| `animate-zfadeup` | 1× | message/card entrance (.18 s) |
| `animate-zdialog` | 1× | dialog entrance (.18 s swift; needs `-translate-x/y-1/2` centering) |
| `animate-zoverlay` | 1× | backdrop fade (.15 s) |
| `animate-zglow` | ∞ | Conductor orb working-glow |
| `animate-ztoast` | 1× | toast slide-in from right (.22 s swift) |
| `animate-zeq` | ∞ | deck equalizer bars (stagger via `animation-delay`) |
| `.arrive-flash` | 1× | inset attn flash when a pane ENTERS needs-you (React-key retriggered) |

Easing: `ease-out` for fades, `ease-swift` (`cubic-bezier(.16,1,.3,1)`) for
entrances. Both `prefers-reduced-motion` and `data-motion="off"` (root
attribute, wired to a Settings toggle) kill every nonessential animation.

The legacy aliases (`.animate-in`, `.animate-dialog-in`, `.streaming-caret`,
…) were removed in stage 2 — use the `animate-z*` utilities directly.

## The brand mark

A hexagon with a bolt — "swarm + energy". In CSS: `.hex-mark` (clip-path)
plus `.hex-mark-flat` (135° accent gradient — title bar, buttons) or
`.hex-mark-orb` (radial accent orb — the Conductor; add `animate-zpulse` /
`animate-zglow` while busy). The bolt is the SVG polygon
`13 2 4 14 11 14 9.5 22 20 10 13 10` (24-viewbox), white, at ~50 % of the
hexagon box. The app icon renders the same mark
(`src-tauri/icons/make_icon.py` → `pnpm tauri icon src-tauri/icons/icon-source-1024.png`).

## Diff rendering (@pierre/diffs)

Diffs render through `@pierre/diffs` (pinned 1.2.12) with a registered Shiki
**css-variables theme** ("swarmz", `lib/vibe/diff-pierre.ts`): every syntax
token resolves from a `--diffs-token-*` custom property defined in
`styles.css` against the SwarmZ palette (keywords/constants on the light
accent stops, strings ok-tinted, functions warm, comments `--fnt`), and the
structural `--diffs-*-override` variables pin the +/- washes to `--add`/
`--del` at 11 % / 26 % emphasis, scoped to `.vibe-diff`. The engine is
`shiki-js` (pure-JS RegExp — no Oniguruma WASM, the WKWebView-safe choice);
highlighting is lazy-loaded with the first expanded diff; all mounted diff
providers resolve to pierre's shared 2-worker singleton pool.
Changing `--acc` re-themes diffs automatically. Never theme by patching the
library — only through these variables.

## Component patterns (stage 2 canon)

- **Agent card** (FleetGrid): 272 px `rounded-xl border-line bg-card`,
  `hover:shadow-card`, status dot (accent `zpulse` working / `--attn`
  `zattn` needs-you / `--ok` finished / `--fnt` idle), `zsweep` hairline on
  the top edge while busy, attn-tinted border only for needs-you.
- **Quick-approval row**: `border-t border-attn/25 bg-attn/10`, mono hint in
  `--attn`, Decline = line2 outline (err on hover), Allow = the light-on-dark
  hard-confirm (`bg-txt text-bg font-bold`).
- **Approval takeover**: attn-framed card; the primary "Allow ↵" is the
  ACCENT CTA (it is the action the user came to perform), "Decline ⎋" the
  err outline.
- **Chips** (model/ctx/access/jump): `font-mono text-11`, quiet `text-fnt`,
  hover steps to `bg-card text-mut`; jump chips carry a live status dot.
- **Section headers** (sidebar/fleet/focus): 48 px, `//` accent sigil +
  `text-14 font-semibold tracking-[-0.01em]` title.
- **Composers**: `rounded-xl border-line bg-card px-3 py-2.5`,
  `focus-within:border-acc/55`, accent send button (dimmed at 40 % while
  empty), Stop as a line2-outlined mono button.
- **The autonomous marker**: `⚡ autonomous` chip on autonomous-turn system
  messages — `border-acc/40 bg-acc/10 text-acc font-mono text-10`, never a
  user bubble; the trigger kind lives in the tooltip.
- **Report card** (`expect_report` finals in the ItemFeed): `rounded-lg border
  bg-card` with a mono `text-11` header — `▸ in progress` (`--fnt`) / `✓ done`
  (`--ok`) / `⚑ needs you` (the attn wash `border-attn/55` + header
  `bg-attn/10 text-attn`, like the approval card), `tests pass|FAIL` right-
  aligned (`--ok`/`--err`). Summary is `text-13`/1.6 body; a `needs_human`
  question is an amber block; `files_changed` are mono `text-11 text-mut` lines
  (capped, "+N more"). It follows the signal logic exactly — attn only when the
  agent actually needs the human, never for a plain finish.
- **PR badges** (GitHubPanel / PR rows) — the signal triad on GitHub state:
  checks `bg-ok/15 text-ok` pass / `bg-err/15 text-err` fail / `bg-warn/15
  text-warn` pending; review decision `--ok` approved / `--err` changes-
  requested / neutral line-outlined pending; draft + conflicts as neutral
  line-outlined `text-fnt` chips. All `rounded-sm font-mono text-10`. The gh
  auth chip is a `rounded-full border-line bg-card` pill with an `--ok`/`--warn`
  dot.

## Keyboard & focus

- **Every interactive element shows the accent ring on `:focus-visible`.**
  `ui/*` primitives carry `focus-visible:ring-2 ring-ring/40`; raw
  `<button>`s use the shared `.focus-ring` class — same ring, one place.
  Mouse clicks stay ring-free.
- **Hover-revealed controls reveal on keyboard focus too**: `opacity-0` +
  `group-hover:opacity-100` + `focus-visible:opacity-100` — never
  `display:none`, which removes the tab stop.
- **Data-bearing tooltips need a keyboard path**: `tabIndex={0}` on the
  trigger span (Radix opens on focus).
- **No nested interactives.** Close/delete affordances become real sibling
  `<button>`s.
- UI copy is English only — one product language.

## Layout conventions

- **Title bar = place/navigation** (project tabs, needs-you pill, ⌘K, New
  Agent CTA in `bg-acc`); **Deck = system status** (32 px, all `text-11
  font-mono`, triage counts, ticker, meters, Conductor dot). The deck never
  grows.
- The Conductor sidebar is *furniture*: a persistent flex sibling on
  `--panel`, no backdrop, resizable. Drawers (Quick Notes, Usage, the GitHub panel) are
  *modal overlays*: `animate-zoverlay` backdrop + `animate-ztoast`-family
  slide (the GitHub panel slides from the right on `--panel`), Escape closes.
- Chat is human-readable, not a dev log: reading-width column (~720 px),
  body `text-13`/1.6, tool/meta lines recede to `text-11 font-mono text-mut`
  and fold into collapsible activity blocks; agent jump chips are first-class.
- Semantic z-scale: content 0 · in-surface chrome 10 · focus overlays 20/30 ·
  drawers 30/40 · dialogs & menus 50+ · toasts 70.

## Performance invariants (unchanged, pflichtig)

Identity-preserving transcript items, primitive-signature selectors, delta
batching — see AGENTS.md "Load-bearing invariants".

## shadcn-compat aliases (deprecated)

`components.json` is still configured; generated components pick up the theme
via the alias layer in `styles.css`. Mapping (see the table in `styles.css`):
`--background→--bg`, `--foreground→--txt`, `--card→#121217`,
`--popover→--pop`, `--secondary/--muted→--pop`, `--accent→--line` (hover
wash — NOT the color accent), `--border→--line`, `--input→--line2`,
`--ring→--acc`, `--destructive→--err`, `--muted-foreground→--mut`,
`--faint→--fnt`, `--success→--ok`, `--warning→--warn`,
`--diff-add/--diff-del→--add/--del`, `--chart-1..5→` accent ramp,
`--primary` stays light-on-dark (the hard-confirm "Allow" move). New code
uses the Vibe v3 names; touching a legacy component means migrating its
class names in the same change.
