# t3code-Takeaways für den SwarmZ-Rebuild

Quelle: Analyse von https://github.com/pingdotgg/t3code (Referenz vom User, 2026-07-10). t3code treibt den codex app-server über eine fünfstufige Pipeline (typed stdio-Client → Session-Runtime pro Thread → kanonischer Event-Adapter → event-sourced Ingestion → WS-Projektion mit virtualisiertem Client). Es besitzt seine eigene Wahrheit (Event-Store) und nutzt Codex rein als Compute-Engine.

## Übernehmen (mit t3code-Fundstellen)

1. **Sub-Agent-Korrelation:** `collabAgentToolCall`-Items tragen `receiverThreadIds`; t3code mappt `receiverThreadId → parentTurnId` und unterdrückt doppelte Child-Lifecycle-Notifications, re-attributiert Child-Events auf den Eltern-Turn (`CodexSessionRuntime.ts:588-627,831-843`). **Das wichtigste Pattern für unseren Schwarm** — Codex hat native Multi-Agent-Unterstützung im Protokoll.
2. **`collaborationMode` auf `turn/start`** (experimentell, raw request): `{mode, settings:{model, reasoning_effort, developer_instructions}}` — per-Turn-Personas/Rollen ohne Thread-Fork (`CodexSessionRuntime.ts:325-345`). Ideal für rollen-spezialisierte Agenten.
3. **Delta-Puffer mit Überlauf-Ventil:** Setting schaltet zwischen Live-Streaming jedes `agentMessage/delta` und Puffern bis zu natürlichen Grenzen (request.opened, user-input, turn/completed) mit `MAX_BUFFERED_ASSISTANT_CHARS = 24_000` Zwangs-Flush (`ProviderRuntimeIngestion.ts:802-832,1361-1452`). Bei N parallelen Agenten: default gepuffert.
4. **Sequenz-basiertes inkrementelles Resume:** Snapshot + `subscribeThread(afterSequence)` → Reconnect ist O(Delta), nicht O(Transkript) (`client-runtime/state/threads.ts:234-241`). Store um monotone Per-Thread-Sequenznummern bauen.
5. **Stabile Assistant-Segment-IDs pro Turn:** `assistant:<itemId|turnId>[:segment:N]` verhindert verschmolzene/duplizierte Bubbles bei mehreren Assistant-Messages pro Turn (`ProviderRuntimeIngestion.ts:196-204,747-800`).
6. **Approval-Korrelation:** interner requestId + Deferred + Map `codexApprovalId → requestId`; `serverRequest/resolved` räumt out-of-band-Entscheidungen ab (`CodexSessionRuntime.ts:952-1114`).
7. **Mode-Tabelle auf Thread UND Turn:** `approval-required→untrusted/read-only`, `auto-accept-edits→on-request/workspace-write`, `full-access→never/danger-full-access`; Params bei JEDEM `turn/start` re-senden, damit Mode-Wechsel sofort greifen (`CodexSessionRuntime.ts:265-323,442-479`).
8. **resume→start-Fallback:** volle Snippet-Liste der "not found"-Fehlertexte abdecken (`CodexSessionRuntime.ts:57-63`). SwarmZ hat das typed — Snippets abgleichen.
9. **Stderr-Triage:** ANSI strippen, nur ERROR-Level zeigen, Benign-Allowlist, "failed to connect to websocket" → fatal (`CodexSessionRuntime.ts:48-63,1140-1171`).
10. **Shadow-CODEX_HOME pro Instanz** für echte Multi-Instanz-Isolation + `continuationGroupKey`; Achtung: `~` in env wird von spawn NICHT expandiert — selbst expandieren (`CodexDriver.ts:108-213`).
11. **Per-Session-MCP-Injection:** `appServerArgs: ["-c","mcp_servers.<name>.url=…"]` + `config/mcpServer/reload` vor dem Turn — Weg, jedem Agenten ein Koordinations-Tool zu geben (`CodexAdapter.ts:1405-1418`).
12. **Virtualisiertes Transkript:** stabile IDs + memo-Rows + Virtualisierung + `maintainVisibleContentPosition` (Scroll-Anker beim Streamen) (`MessagesTimeline.tsx:474-497`). SwarmZ-Äquivalent: virtua VList — Anker-Verhalten prüfen.
13. **Ein geordneter Ingestion-Worker mit Drain** — deterministische Command-Reihenfolge bei parallelen Streams, sauberes Shutdown (`ProviderRuntimeIngestion.ts:1693-1715`).
14. **TokenUsage normalisieren** (`last` vs `total`, `modelContextWindow`); Modell/Effort/ServiceTier-Wechsel = einfach Params des nächsten `turn/start` (`CodexAdapter.ts:156-190,1695-1697`).
15. **Typen aus dem JSON-Schema generieren** (`generate.ts` → typed request/notify/handleServerRequest + `SERVER_NOTIFICATION_METHODS`) — für uns: Rust/TS-Typen aus dem 0.144.1-Dump generieren = Compile-Zeit-Abdeckung + billige Upgrades.

## Vermeiden

- Codex' Rollout-Store NICHT als Quelle der Wahrheit (nur resume/read zur Hydration; DB-Warnungen wie "state db missing rollout path" sind benign).
- Kein ungefiltertes Delta-Streaming an den Renderer als einziger Pfad.
- **Stale-Turn-Guard:** `turn.started/completed` mit fremder turnId verwerfen (dokumentierte Ausnahme für steer-artige neue Turns) — wichtig sobald Turns/Agenten überlappen (`ProviderRuntimeIngestion.ts:1225-1270`).
- Monolithische if/else-Eventmapper vermeiden → Method→Handler-Tabelle.
- t3code nutzt steer/fork/compact/review NICHT (steer ≈ neuer Turn, Compaction automatisch). Wir wollen steer/compact trotzdem — aber mit dem Wissen, dass plain `turn/start` der bewährte Weg ist; Feature einzeln live verifizieren, Fallback auf neuen Turn einbauen.

## Einordnung für unsere Phasen

- Phase 3 (Conductor pro Projekt): Shadow-HOME-Isolation optional, Mode-Tabelle, stderr-Triage.
- Phase 4 (Tools): `collabAgentToolCall`/`receiverThreadIds` evaluieren als nativer Spawn-Mechanismus vs. eigene Session-Prozesse; `collaborationMode` für Rollen; steer mit Fallback.
- Phase 5 (Autonomie): Stale-Turn-Guard, geordneter Ingestion-Worker, Delta-Puffer.
- Phase 6 (UI): Segment-IDs, Virtualisierung/Scroll-Anker, Sequenz-Resume.
