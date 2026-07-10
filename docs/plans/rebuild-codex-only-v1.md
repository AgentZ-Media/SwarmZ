# SwarmZ Rebuild: Codex-only Schwarm (Branch `rebuild/codex-only-v1`)

Stand: 2026-07-10 · Status: beschlossen, Umsetzung startet mit Phase 0

## Zielbild

SwarmZ wird ein reiner **Schwarm-Manager über `codex app-server`** (ChatGPT-Abo only). Keine Terminals, kein PTY, kein Grid-Modus, kein Claude, kein OpenRouter, kein Diktat.

- **Tabs je Projektordner.** Jeder Tab = ein Projekt mit eigenem **Conductor** (Orchestrator-Instanz: eigener Chat, eigenes Memory, eigener Prozess-Slot) und eigener Agenten-Flotte. Das Deck aggregiert Zähler/Needs-you über alle Projekte.
- **Der Conductor ist voll autonom:** spawnt/steuert/stoppt/schließt Agenten, legt Worktrees an (mehrere parallel, entscheidet über Sharing bzw. worktree-lose Analyse-Tasks), stellt sich Timer für Nachfass-Turns, reviewt fertige Arbeit, verteilt Folgeaufgaben. Aufgaben-Zerlegung auf "Mitarbeiter" ist seine Kernaufgabe per Persona — der User muss es nicht sagen.
- **Approvals:** Agenten laufen default im Workspace-Sandbox. Routine-Approvals entscheidet der Conductor (bzw. Codex `auto_review`); destruktive/unklare Fälle eskalieren als Karte an den Menschen.
- **Agenten-Namen:** automatische internationale Vornamen (Maya, Jonas, Kenji, Aria, …), kollisionsfrei pro Projekt; Branch-Namen abgeleitet (`swarm/maya-checkout`). Agenten spawnen klein (Karte im Fleet-Grid), expandierbar (Fokus/Wide).
- **Modelle:** Conductor `gpt-5.6-sol · high`; Sub-Agenten default `gpt-5.6-sol · medium`, der Conductor wählt pro Aufgabe (spark/mini für schnelle Analysen, xhigh für Kritisches). Alles manuell übersteuerbar.
- **Codex-Version:** neueste CLI (≥0.143). Neue Protokoll-Features werden genutzt: `turn/steer` (in laufende Turns reinreden — die "busy = abgelehnt"-Regel entfällt), `thread/fork`, `thread/compact`, `thread/settings/update`, `outputSchema`, `auto_review`. Fixtures werden auf der neuen Version neu eingefroren (Referenz: Schema-Dump via `codex app-server generate-json-schema`).
- **Design:** "SwarmZ Vibe v3" (Claude-Design-Projekt `930203eb`): Accent `#f0567c`, Geist/Geist Mono (lokal gebundelt), Conductor-Sidebar links (einklappbar/resizable), Fleet-Grid mit Agent-Karten, Fokus-View, Deck, Toasts. Claude-Runtime-Reste aus dem Design entfallen. User-Vorgaben überstimmen das Design; Weiterentwicklung erlaubt.
- **Alt-Code wird komplett entfernt** (Git-History/`main` bewahren alles).

## Vision-Präzisierung (User, 2026-07-10 nachträglich — GESETZT)

1. **Das Design ist Grundkonzept, kein Endzustand.** Phase 6 baut daraus ein vollwertiges, ausgeklügeltes **Design-System** („Corporate Design"): Spacing-Skala, Typo-System, Sizing-Skala, Farbpaletten-System (Akzent + Ladder + Semantik), dokumentiert als Tokens, auf denen alles Weitere aufbaut. Zusätzlich: **App-Icon umfärben** auf den neuen Akzentton #f0567c (programmatisch, z. B. Python/ImageMagick — Hue-Shift der bestehenden Assets in src-tauri/icons/).
2. **Der Orchestrator ist wie ein menschlicher Engineering-Lead.** Der User gibt Ziele („Ich möchte dieses Feature in dieser App"), NICHT Vorgehensanweisungen. Der Conductor entscheidet selbst: wie viele Agenten, welche Aufteilung, ob Webrecherche, ob er selbst einen Plan schreibt (er darf eigene Plan-/Analyse-Dokumente verfassen — Phase 4 gibt ihm dafür eine begrenzte Schreibfähigkeit, z. B. `write_plan` in einen Plan-Bereich; der „nie Code-Dateien editieren"-Guardrail bleibt), dass zurückreportet wird, und er holt AKTIV User-Feedback ein, wenn Richtungsentscheidungen anstehen.
3. **Der Conductor lernt den User kennen.** Vorlieben, Schreibstil, wiederkehrende Anforderungen, typische Fehlerquellen — kontinuierlich ins (Projekt-/Global-)Memory. Präferenz-Beobachtungen darf er proaktiv speichern (sichtbar/löschbar in den Settings); Fakten weiterhin nach Bestätigung. Phase 4/5 verankern das in Kern-Doktrin + Memory-Mechanik.
4. **Der Maßstab:** SwarmZ muss einen klaren Mehrwert gegenüber der Codex-App bieten — genau diese Selbstständigkeit, das Schwarm-Management und das Lernen sind der Grund, die App zu benutzen.

## Verifizierte Grundlagen (Analyse 2026-07-10)

- Vibe-Subsystem (Session-Store/Controller/ItemFeed/DiffCard, `codex/` host+protocol+sessions, Tool-Bus, Persona-Compiler, Worktree-Primitiven) ist wiederverwendbar und der bestgetestete Teil des Baums.
- Genau drei Terminal-Lecks in Shared-Code: `focusTerm`, `insertCommandText`, `layout.ts`-Nutzung im Orchestrator. Vier Berührungspunkte: Deck-Triage, quit.ts, App.tsx-Shortcuts, Orchestrator-Pane-Zweige.
- Persistenz sauber getrennt: `vibeSessions`/`orchestratorChats`/`settings`/`usageHistory`/`quickNotes` bleiben; `grid`/`workspaces`/`workspacePresets`/`commandPresets`/`customCommands`/`profiles` entfallen. Keine Migrations-Framework — wir stampfen erstmals `schemaVersion` ein.
- app-server-Inventar (live verifiziert, 0.142.5 + 0.144-Schema-Diff) liegt als `codex-appserver-inventory.md` vor (Scratchpad-Artefakt; nach Phase 0 unter `docs/codex-protocol/` einchecken). Wichtig: EIN Prozess multiplext parallele Turns über Threads — Prozess-pro-Session ist reine Absturz-Isolation; `item/updated` existiert nicht (toter Handler); `account/*`-Notifications tragen keine threadId.

## Phasen

Jede Phase endet mit grünem `tsc --noEmit` + `pnpm test` + `cargo test` und einem Commit auf dem Branch (Commits nach User-Freigabe). Phase 1 endet lauffähig (Vibe-only-Zwischenzustand); ab Phase 2 kann es innerhalb einer Phase kurz brüchig sein, nie über Phasen-Grenzen.

### Phase 0 — Fundament & Sicherheitsnetz
1. Codex-CLI auf neueste Version updaten; `generate-json-schema`-Dump als Protokoll-Referenz nach `docs/codex-protocol/` (getrimmt).
2. Protokoll-Fixtures (`codex/protocol.rs`) gegen die neue Version live neu einfrieren; toten `item/updated`-Handler entfernen; `originator` statt `source` für eigene Rollouts.
3. `schemaVersion` in `swarmz.json` einführen (Hydrate-Normalisierung, Rescue-Pfad bleibt); Versionsstände synchron halten.

### Phase 1 — Große Subtraktion
Frontend raus: `term-host`, `term-registry`, `Terminal`, `AgentPane`, `TilingGrid`, `WorkspaceLayer`, `FloatingTerminals`, `dnd`, `presets`, `insert-command`, `command-vars`, `lib/git.ts`-Poll, `lib/layout.ts`, `lib/triage.ts`, `NewAgentDialog`, Preset-/Profile-/Close-Dialoge, `OrchestratorPanel`, `InsertCommandPalette`, Dictation-UI. Die vier Berührungspunkte säubern (Deck → nur Vibe-Triage; quit.ts → `vibeBusyIds`+Orchestrator; App.tsx → Grid-Shortcuts/Mounts raus; TitleBar/CommandPalette/Settings → Terminal-Sektionen raus). Store: Grid-Slices + tote Settings-Felder (`defaultRuntime`, `claudePath`, `dictation*`, `restoreAgents`, `uiMode`, `defaultStartup`) entfernen.

Rust raus: `pty.rs`, `limits.rs`, `usage.rs` (Claude-Hälfte → Merge der geteilten Typen in `codex_usage.rs`), `localstt.rs`, `openrouter.rs`, `project.rs`, `orchestrator/openrouter.rs`; zugehörige Commands/Events/Watcher-Zweige (Claude-Root) und Cargo-Deps (`portable-pty`, `transcribe-rs`, `sha2`, `security-framework`). package.json: `@xterm/*` raus. Tests bereinigen (layout/placement/Grid-Snapshot/OpenRouter).

### Phase 2 — Datenmodell: Projekte & Schwarm
1. `Project`-Entity + persistenter `projects`-Key (id, dir, name, order, lastActive); Projekt-Tabs ersetzen Workspace-Tabs; „Projekt öffnen" via Ordner-Picker + Discovery-Recents (`projects.rs`, Claude-Zweige raus).
2. `VibeSession` erweitert: `projectId`, `agentName`, `spawnedBy: "user"|"conductor"`, `worktree: {root, branch, shared} | null`. Session-Store nach Projekt gescoped (Selektoren, Caps pro Projekt). Hydrate-Migration: bestehende Sessions bekommen `projectId` aus `projectDir`.
3. Namensgenerator: internationaler Vornamen-Pool, kollisionsfrei pro Projekt; Branch-Ableitung `swarm/<name>-<slug>`. (vitest)

### Phase 3 — Conductor pro Projekt (Rust)
1. `appserver.rs`: von `static HOST` + flacher Chat-Liste → `OrchestratorInstance` je Projekt (eigener `ProcessHost`-Slot — die vorbereitete „Slot-Allokation"-Nahtstelle), Chat-Store nach Projekt gescoped.
2. Persona v2: neuer `OPERATIVE_CORE` (bewusster Bruch der alten Wort-für-Wort-Invariante — der Kern beschreibt jetzt die Schwarm-Doktrin: Aufgaben zerlegen, Mitarbeiter-Metapher, Worktree-Strategie, Timer-Nutzung, Approval-Politik, Eskalationsregeln). Mechanik bleibt: Persona nur Stimme, kann Kern nie schwächen; neue Content-Tests frieren v2 ein. AGENTS.md-Invariante entsprechend aktualisieren.
3. Memory: pro Projekt (`orchestrator-memory/<projectId>.md`) + global; FIFO-Caps wie gehabt.

### Phase 4 — Tool-Arsenal v2 (Registry + Executors)
Session-only, alle mit Rust-Schema + Webview-Executor + Persona-Doku + Tests:
- `spawn_agents` (ersetzt `create_panes`): n Agenten `{task, model?, effort?, access?, worktree: "new"|"shared:<agent>"|"none"}` — Namen automatisch, Rückgabe Namen+IDs.
- `prompt_agent` (ersetzt `prompt_pane`): nutzt `turn/steer` bei busy statt Ablehnung.
- `interrupt_agent`, `close_agent`, `set_agent_config` (Modell/Effort/Access via `thread/settings/update`).
- `read_agent` (strukturierter Transcript-Tail), `fleet_snapshot` v2 (Projekt-Scope: Sessions + Worktrees + Timer + Approval-Lage; Layout-/Crowding-Teile entfallen).
- Worktrees: `create_worktree`, `assign_worktree`, `worktree_status`, `cleanup_worktree` (re-check-gated wie heute; mehrere Agenten pro Worktree erlaubt — ein Schreiber gleichzeitig empfohlen, Doktrin im Core).
- Timer: `set_timer(delaySec|at, note)`, `list_timers`, `cancel_timer`. Persistiert im Store, überleben Neustart; feuern nur bei laufender App, verpasste feuern beim Start nach. Ablauf → autonomer Conductor-Turn mit Timer-Kontext.
- Approval-Routing: Sub-Agent-Approvals gehen zuerst an den Conductor (`approval_request`-Eskalationsturn); er entscheidet via `decide_approval` oder eskaliert an den Menschen (Karte + Deck). Destruktiv-Muster (force-push, rm -rf außerhalb Worktree, Migrationen, …) sind hart mensch-pflichtig. `auto_review` als Alternative evaluieren.
- `review_agent` (Codex `review/start` auf Branch/uncommitted eines Agenten).
- Bestand bleibt: `remember`, `read_project_docs`, `read_notes`, `list_projects`, `git_status` (auf Session-Cwd/Worktrees umgestellt).

### Phase 5 — Autonomie-Loop
1. Event-getriebene autonome Conductor-Turns (agent finished / approval-escalation / timer / idle-Nachfassen) — nicht nur passive Pings.
2. Schleifen-Schutz: Budget/Cooldown (max. autonome Turns pro Stunde, konfigurierbar), Kaskaden-Stopp, sichtbarer „autonomer Turn"-Marker im Chat.
3. `outputSchema` für strukturierte Status-Reports Agent → Conductor.
4. Auto-Review-Setting (fertige Lanes automatisch reviewen lassen).

### Phase 6 — Neue UI (Design-Implementierung „SwarmZ Vibe v3")
1. Design-Tokens: neue Palette (#f0567c-Akzent, bg/panel/card/pop-Ladder, attn/ok/warn/err, add/del), Geist + Geist Mono lokal gebundelt; `styles.css` + `DESIGN.md` neu.
2. TitleBar: Projekt-Tabs, Needs-you-Pill (⌘⇧A cycle), ⌘K, Settings, New Agent; Drag-Region-Invariante beibehalten.
3. Conductor-Sidebar (⌘B, resizable): ChatView v2 mit Aktivitätsblöcken (Tool-Steps + Agent-Chips), Pings mit Jump/Review, Modell/Effort-Picker, ctx-Anzeige, `@agent`-Mentions, Stop.
4. Fleet-Grid: Agent-Karten (Status-Triade, Name, Worktree/Projekt, ±Diff, Mini-Feed, Quick-Approval, Mini-Composer), Filter-Chips, „working"-Sweep.
5. Fokus-View: Feed (ItemFeed/DiffCard wiederverwenden, restylen), Plan-Panel, Approval-Takeover (⏎/⎋), Cross-Agent-Banner, Wide-Modus.
6. Deck v2 (projektübergreifend), Toasts, New-Agent-Dialog (Projekt implizit, Name random vorausgefüllt), Close-Confirm mit Kontextzeilen, Command-Palette v2, Settings v2 (Autonomie-Level, Approval-Politik, Auto-Review, Timer, Defaults).
7. Performance-Invarianten: Identity-Preservation der Items, Primitive-Signatur-Selektoren, Delta-Batching — unverändert pflichtig.

### Phase 7 — Feinschliff, Doku, Absicherung
1. `compact` bei hohem ctx (Conductor + Agenten), steer-UX-Politur, ggf. `fork` für Varianten.
2. Quit-Guard v2, Store-Rescue-Tests, Updater-Pfad unangetastet verifizieren.
3. `AGENTS.md`, `docs/ARCHITECTURE.md`, `README.md`, `DESIGN.md` vollständig neu geschrieben.
4. Live-E2E gegen das Abo: echtes Testprojekt — Conductor bekommt eine unzerlegten Auftrag, zerlegt selbst, spawnt Agenten in Worktrees, Timer feuert, Review läuft, Approval eskaliert korrekt.
5. Release: Versionen sync, Release-Notes, Tag (nach Freigabe).

## Offene bewusste Brüche
- Der Wort-für-Wort-`OPERATIVE_CORE` und die 11-Tool-Registry-Tests werden ersetzt (nicht erweitert) — neue Invarianten werden mit denselben Mechanik-Tests (Persona-kann-Kern-nicht-schwächen, Katalog-Vollständigkeit) neu eingefroren.
- `uiMode` entfällt; die App hat nur noch den Schwarm-Modus.
- Alte Store-Keys werden beim ersten Start der neuen Version entfernt (einmalige Cleanup-Routine), `vibeSessions`-Migration erhält Transkripte.
