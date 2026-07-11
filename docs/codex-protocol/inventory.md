# codex app-server — verified protocol inventory

Probed live on 2026-07-10 against the user's real ChatGPT Pro login. All JSON samples below are
**captured from real runs** (paths/ids trimmed) unless explicitly marked *(schema-only)*.

- Reference CLI: **`codex-cli 0.144.1`** at `~/.local/bin/codex` — the version SwarmZ's fixtures
  (`src-tauri/src/codex/protocol.rs`) are frozen against (Phase-0 re-freeze; the original probes ran
  on 0.142.5 and every shape SwarmZ consumes was re-captured/re-verified on 0.144.1).
- Authoritative source: **`codex app-server generate-json-schema --out DIR --experimental`** dumps
  the complete protocol as JSON Schema (`v2/` = 290 files + combined
  `codex_app_server_protocol.v2.schemas.json`, 571+ definitions). The 0.144.1 combined v2 file is
  checked in next to this document — regenerate per installed version (see `README.md`).
- Version-specific details below (model catalog, rate-limit snapshots) reflect this account at probe
  time; shapes are what matters.

## 1. Wire format & handshake (confirmed unchanged)

NDJSON over stdio, JSON-RPC 2.0 **without** the `"jsonrpc"` header — exactly as SwarmZ's
`protocol.rs` says. Also supported (new knowledge): `--listen unix://PATH` and `--listen ws://IP:PORT`
transports, a managed daemon (`codex app-server daemon`, `codex app-server proxy`), and WS auth modes
(`capability-token`, `signed-bearer-token`). A remote/daemon transport is a real architecture option
for a multi-agent app (one daemon, many clients) instead of N child processes.

```json
>> {"id":1,"method":"initialize","params":{"clientInfo":{"name":"SwarmZ-Probe","title":"SwarmZ-Probe","version":"0.0.1"},"capabilities":{"experimentalApi":true}}}
<< {"id":1,"result":{"userAgent":"SwarmZ-Probe/0.144.1 (Mac OS 26.5.2; arm64) unknown (SwarmZ-Probe; 0.0.1)","codexHome":"/Users/…/.codex","platformFamily":"unix","platformOs":"macos"}}
>> {"method":"initialized"}
```

`InitializeCapabilities` (all client-declared):
- `experimentalApi: bool` — gates dynamicTools + experimental methods/fields (SwarmZ already sets it)
- `optOutNotificationMethods: [string]` — **suppress exact notification methods per connection** (e.g. `mcpServer/startupStatus/updated` noise) — very useful, SwarmZ doesn't use it
- `mcpServerOpenaiFormElicitation: bool`, `requestAttestation: bool`

`clientInfo.name` lands as `originator` in the rollout file (verified on disk: `"originator":"SwarmZ-Probe"`); `source` is recorded as `"vscode"` for app-server clients regardless (don't rely on it to recognize your own sessions — use `originator`).

## 2. Full method catalog (from the generated schema; ~120 requests — verified still-present on 0.144.1)

### Client → server requests (≈120; ★ = live-verified in this probe, ✦ = relevant for an orchestrator app)

Threads: ★`thread/start` ★`thread/resume` ★`thread/fork` ✦`thread/archive` `thread/unarchive` ✦`thread/delete` ★`thread/unsubscribe` ★✦`thread/list` ✦`thread/search` `thread/loaded/list`(★ returns loaded thread ids) ★`thread/read` ✦`thread/turns/list` ~~`thread/turns/items/list`~~ (REMOVED in 0.144; successor `thread/items/list` exists in the method enum but answers ★`thread/items/list is not supported yet` (-32601) on 0.144.1 — use `thread/read`/`thread/turns/list` for now) ✦`thread/name/set` `thread/metadata/update` ✦`thread/settings/update` ✦`thread/rollback` ✦`thread/inject_items` ★✦`thread/compact/start` ✦`thread/shellCommand` `thread/goal/set|get|clear` `thread/memoryMode/set` `memory/reset` `thread/increment_elicitation` `thread/decrement_elicitation` `thread/approveGuardianDeniedAction` `thread/backgroundTerminals/list|clean|terminate`

Turns: ★`turn/start` ★`turn/interrupt` ★✦`turn/steer` — steer INJECTS input into a RUNNING turn (`expectedTurnId` precondition), response `{"turnId":"…"}`; live-verified: mid-`sleep` steer "end with BANANA" → final answer `` `wt1` BANANA ``.

Review: ★✦`review/start` (`target`: `uncommittedChanges` | `{baseBranch}` | `{commit sha}` | `{custom instructions}`; `delivery`: `inline`|`detached` → detached returns `reviewThreadId`, emits `enteredReviewMode`/`exitedReviewMode` items).

Models/config: ★`model/list` `modelProvider/capabilities/read`(★ → `{"namespaceTools":true,"imageGeneration":true,"webSearch":true}`) ★`config/read` `config/value/write` `config/batchWrite` `configRequirements/read` `collaborationMode/list`(★ → Plan/Default) `permissionProfile/list`(★ → `:read-only`, `:workspace`, `:danger-full-access`) `experimentalFeature/list`(★) `experimentalFeature/enablement/set`

Account: ★`account/read` ★`account/rateLimits/read` ★`account/usage/read` `account/login/start` (ChatGPT OAuth or apiKey) `account/login/cancel` `account/logout` `account/rateLimitResetCredit/consume` `account/workspaceMessages/read` `account/sendAddCreditsNudgeEmail` `feedback/upload`

Exec/fs surfaces (client-usable, no model turn — a whole utility API): `command/exec` (+`/write` `/terminate` `/resize` — interactive, `command/exec/outputDelta` notif), `process/spawn` `process/writeStdin` `process/kill` `process/resizePty` (+ `process/outputDelta`, `process/exited` notifs), `fs/readFile` `fs/writeFile` `fs/createDirectory` `fs/getMetadata` `fs/readDirectory` `fs/remove` `fs/copy` `fs/watch` `fs/unwatch` (+ `fs/changed` notif), `fuzzyFileSearch` + session variants. ⚠️ `thread/shellCommand` runs **unsandboxed with full access** by design.

Ecosystem: `skills/list` `skills/config/write` `skills/extraRoots/set` `hooks/list` `app/list` `plugin/*` (list/install/uninstall/read/share/…) `marketplace/add|remove|upgrade` `mcpServerStatus/list` `mcpServer/oauth/login` `config/mcpServer/reload` `mcpServer/resource/read` `mcpServer/tool/call` (client can call MCP tools directly!), `externalAgentConfig/detect|import` (imports Claude Code/other-agent configs), `environment/add`, `remoteControl/*`, `thread/realtime/*` (voice: start/appendAudio/appendText/appendSpeech/stop/listVoices + sdp/transcript/audio notifications), `windowsSandbox/*`, `attestation/generate`, `mock/experimentalMethod`.

### Server → client requests (must be answered)

- ★`item/commandExecution/requestApproval`
- `item/fileChange/requestApproval` (SwarmZ live-verified earlier under `untrusted`)
- ★`item/tool/call` (dynamic tools)
- `item/tool/requestUserInput` *(schema-only: `questions[]` with `id/header/question/isOther/isSecret/options[]`; answer `{answers: {id: {answers:[…]}}}`)*
- `item/permissions/requestApproval` *(schema-only — granular-permissions flow)*
- `mcpServer/elicitation/request`, `account/chatgptAuthTokens/refresh`, `attestation/generate`, `currentTime/read`
- legacy v1: `applyPatchApproval`, `execCommandApproval`

### Server → client notifications (68 in schema; ✔ = observed live in these probes)

Turn/items: ✔`turn/started` ✔`turn/completed` ✔`turn/diff/updated` ✔`turn/plan/updated` (live on 0.144.1 via the update_plan tool) ✔`item/started` ✔`item/completed` ✔`item/agentMessage/delta` ✔`item/commandExecution/outputDelta` `item/fileChange/outputDelta` `item/fileChange/patchUpdated` `item/plan/delta` `item/reasoning/summaryTextDelta` `item/reasoning/textDelta` `item/reasoning/summaryPartAdded` `item/mcpToolCall/progress` `item/commandExecution/terminalInteraction` `item/autoApprovalReview/started|completed` (guardian) `hook/started|completed` — **there is NO `item/updated`** (confirmed on 0.142.5 AND 0.144.1 — 0 occurrences across all live runs; SwarmZ's former defensive handler has been removed).
Thread: ✔`thread/started` ✔`thread/status/changed` ✔`thread/settings/updated` ✔`thread/tokenUsage/updated` ✔`thread/goal/cleared` `thread/compacted` `thread/name/updated` `thread/archived|deleted|unarchived|closed` `model/rerouted` `model/verification` `turn/moderationMetadata` `model/safetyBuffering/updated`
Global: ✔`account/rateLimits/updated` `account/updated` `account/login/completed` ✔`mcpServer/startupStatus/updated` (per-thread! carries `threadId`) ✔`remoteControl/status/changed` ✔`serverRequest/resolved` (fires after an approval/server-request is answered — lets a second UI surface clear stale approval cards) ✔`error` ✔`warning` `deprecationNotice` `configWarning` `guardianWarning` `skills/changed` `app/list/updated` `fs/changed` `fuzzyFileSearch/*` `thread/realtime/*` `externalAgentConfig/import/*` `windows*`

## 3. Thread lifecycle (live shapes)

### thread/start — params (full set; 0.144.1 additions noted at the end)

`cwd`, `model`, `modelProvider`, `sandbox` (`read-only` | `workspace-write` | `danger-full-access` | `external-sandbox`), `approvalPolicy` (`untrusted` | `on-request` | `never` | **`{granular:{...}}` object form**: per-category booleans `sandbox_approval`, `rules`, `mcp_elicitations`, `request_permissions`, `skill_approval`), `approvalsReviewer` (**`user` | `auto_review`** — auto_review = guardian subagent decides approvals!), `permissions` (named profile id, e.g. `:workspace` — mutually exclusive with `sandbox`), `developerInstructions`, `baseInstructions`, `dynamicTools`, `personality` (`none`|`friendly`|`pragmatic`), `ephemeral`, `config` (arbitrary config overrides object), `environments`, `runtimeWorkspaceRoots`, `selectedCapabilityRoots`, `serviceName`, `serviceTier` (e.g. `priority` = "Fast" 1.5×), `sessionStartSource`, `threadSource`, `experimentalRawEvents`. 0.144 adds `allowProviderModelFallback` + `historyMode` (`legacy`|`paginated`) and REMOVES `on-failure` from the `approvalPolicy` enum (schema-level; `untrusted`/`on-request`/`never` + granular object remain). `MultiAgentMode` loses `none` and gains a `{custom: string}` object form.

Captured response (trimmed):
```json
{"thread":{"id":"019f4b76-9f78-…","extra":null,"sessionId":"019f4b76-…","forkedFromId":null,"parentThreadId":null,
  "preview":"","ephemeral":false,"historyMode":"legacy","modelProvider":"openai","createdAt":1783677493,"updatedAt":1783677493,
  "recencyAt":1783677493,"status":{"type":"idle"},
  "path":"/Users/…/.codex/sessions/2026/07/10/rollout-2026-07-10T11-58-13-….jsonl",
  "cwd":"…/demo","cliVersion":"0.144.1","source":"vscode","threadSource":null,"agentNickname":null,"agentRole":null,"gitInfo":null,"name":null,"turns":[]},
 "model":"gpt-5.4-mini","modelProvider":"openai","serviceTier":"default","cwd":"…/demo",
 "runtimeWorkspaceRoots":["…/demo"],"instructionSources":["/Users/…/.codex/AGENTS.md"],
 "approvalPolicy":"on-request","approvalsReviewer":"user",
 "sandbox":{"type":"workspaceWrite","writableRoots":[],"networkAccess":false,"excludeTmpdirEnvVar":false,"excludeSlashTmp":false},
 "activePermissionProfile":null,"reasoningEffort":"high","multiAgentMode":"explicitRequestOnly"}
```
New thread fields on 0.144.x (all in the sample above): `extra` (implementation-specific data),
`historyMode`, `threadSource`, `agentNickname`, `agentRole`; thread/turn ids are documented as
UUIDv7 now. Everything else is structurally identical to 0.142.5.

Notes: `instructionSources` reveals which AGENTS.md files got loaded; `reasoningEffort` echoes the
config default (here "high" from config.toml) even when you overrode the model — pass `effort`
per-turn to control it. `gitInfo` (sha/branch/originUrl) is populated for real repos (seen in
`thread/list` of existing sessions).

### thread/resume — richer than SwarmZ uses

Three resume paths: by `threadId` (rollout on disk), by `path` (rollout path, UNSTABLE), by `history`
(raw items, Codex-Cloud-only). If the thread is **still running in the same process**, resume REJOINS
it. Extras: `excludeTurns: true` (skip turn payloads), `initialTurnsPage` (bootstrap the recent-turns
page in the same call), plus all thread/start overrides (model, sandbox, instructions, …).
**Live: the resume response contains the full transcript** (`thread.turns[].items[]` — userMessage,
agentMessage with text, etc.), so an app can rebuild its UI transcript from resume alone.
Killed the process, respawned, `thread/resume {threadId}` with no other params → model correctly
answered "I created hello.txt with content 'hi'" — context fully restored.
Unknown-thread error (SwarmZ's classifier is right): `no rollout found for thread id … (code -32600)`.

### thread/fork — live-verified

`thread/fork {threadId}` → brand-new thread id with `forkedFromId` set and the full history copied
(fork params allow model/sandbox/instruction overrides + `path`; 0.144 adds `lastTurnId` = fork at an
earlier point). Perfect for orchestrator features like "branch this session and try a different fix".

### thread/list / search / read — session discovery without touching rollout files

`thread/list {limit, cursor, archived, cwd, sortKey, sortDirection, searchTerm, parentThreadId, modelProviders, sourceKinds}` — pagination via `nextCursor`; returns each thread's `preview` (first user message), `name`, `path`, `cwd`, `gitInfo`, `cliVersion`, `source`, timestamps, `status`. ⚠️ the `cwd` filter's wire shape is an untagged enum — a bare `{"paths":[…]}` object was REJECTED (`data did not match any variant of untagged enum ThreadListCwdFilter`); plain string / array of strings is the safer guess — verify before use. `sourceKinds`: `cli|vscode|exec|appServer|subAgent|subAgentReview|…`.
`thread/read {threadId, includeTurns:true}` → the persisted transcript (observed: userMessage/agentMessage items survive; commandExecution items were NOT in the read-back of a live thread's turns — treat read-back as message-level, not item-perfect).
`thread/rollback {threadId, numTurns}` drops turns from model history (files are the client's problem). `thread/inject_items` appends raw Responses-API items to model-visible history (powerful for orchestrator context injection).

### thread/settings/update — retune a session WITHOUT a turn

Updates `model`, `effort`, `approvalPolicy`, `sandboxPolicy`, `cwd`, `personality`,
`approvalsReviewer`, `permissions`, `collaborationMode`, `summary` for subsequent turns and emits
`thread/settings/updated`. (SwarmZ currently rides overrides on the next turn/start instead — this is
the cleaner primitive, and the notification confirms it.)

## 4. Turn lifecycle (live)

### turn/start params

`threadId` + `input: UserInput[]` where UserInput = `{type:"text", text, text_elements?}` |
`{type:"image", url}` | `{type:"localImage", path}` (★ accepted live; `detail` optional) |
`{type:"skill", name, path}` | `{type:"mention", name, path}`.
Per-turn overrides (all "stick for this and following turns"): `model`, `effort`, `cwd`,
`approvalPolicy`, `sandboxPolicy` (object form), `permissions`, `personality`, `approvalsReviewer`,
`environments`, `collaborationMode` *(experimental: `{mode:"plan"|"default"|…, settings:{…}}`)*.
One-turn-only: ★`outputSchema` (JSON Schema constraining the FINAL assistant message — live: returned
exactly `{"answer":"4","confidence":1}`), `additionalContext`, `clientUserMessageId`,
`responsesapiClientMetadata`. Response: `{"turn":{"id","items":[],"itemsView":"notLoaded","status":"inProgress",…}}`.

### Captured event order for one file-writing turn (workspace-write + on-request)

```text
thread/started → mcpServer/startupStatus/updated (×N, per configured MCP server)
→ thread/settings/updated → thread/status/changed {active}
→ turn/started
→ item/started+completed  (type reasoning — empty summary/content unless reasoning deltas enabled)
→ item/started {agentMessage phase:"commentary"} → item/agentMessage/delta … → item/completed
→ item/started {fileChange inProgress} → item/completed {fileChange completed}   [NO approval in-workspace]
→ turn/diff/updated → thread/tokenUsage/updated → account/rateLimits/updated
→ item/started {commandExecution} → item/commandExecution/requestApproval (server REQUEST)
   … thread/status/changed {active, activeFlags:["waitingOnApproval"]} … answer → serverRequest/resolved
→ item/completed {commandExecution, exitCode:0, aggregatedOutput}
→ item/started {agentMessage phase:"final_answer"} → deltas → item/completed
→ thread/tokenUsage/updated → turn/diff/updated → thread/status/changed {idle} → turn/completed
```

Key live shapes:
```json
{"method":"thread/status/changed","params":{"threadId":"…","status":{"type":"active","activeFlags":["waitingOnApproval"]}}}
{"method":"serverRequest/resolved","params":{"threadId":"…","requestId":0}}
{"method":"thread/tokenUsage/updated","params":{"threadId":"…","turnId":"…","tokenUsage":{"total":{"totalTokens":13438,"inputTokens":13320,"cachedInputTokens":4480,"outputTokens":118,"reasoningOutputTokens":54},"last":{…}},"modelContextWindow":258400}}
```
`agentMessage.phase`: `"commentary"` (preamble/progress bubbles) vs `"final_answer"` — an
orchestrator UI should distinguish them (SwarmZ passes phase through already).
`thread/status/changed.activeFlags` is a free "busy + waiting-on-approval" signal — better than
client-side busy bookkeeping.

### Item types (ThreadItem, 18 variants — same set in 0.144)

`userMessage`, `agentMessage {text, phase, memoryCitation}`, `reasoning {summary[], content[]}`,
`plan {text}`, `commandExecution {command, cwd, processId, source, status(inProgress|completed|failed|declined), commandActions[], aggregatedOutput, exitCode, durationMs}`,
`fileChange {changes:[{path, kind:{type:add|delete|update…}, diff}], status}` (add → `diff` = raw content; unified diff comes via `turn/diff/updated`),
`mcpToolCall {server, tool, arguments, result, error, status, appContext, pluginId, mcpAppResourceUri}`,
`dynamicToolCall {tool, namespace, arguments, contentItems, success, status}`,
`collabAgentToolCall {agentsStates, receiverThreadIds, senderThreadId, model, prompt, …}` (multi-agent!),
`subAgentActivity {agentPath, agentThreadId, kind}`, `webSearch {query, action}`, `imageView {path}`,
`sleep {durationMs}`, `imageGeneration {result, revisedPrompt, savedPath, status}`,
`enteredReviewMode {review}`, `exitedReviewMode {review}`, `contextCompaction`, `hookPrompt`.

### Interrupt / steer / compact (all live-verified)

- `turn/interrupt {threadId, turnId}` → `{}` ack, then `turn/completed` with `"status":"interrupted"`.
- `turn/steer {threadId, expectedTurnId, input}` → `{"turnId":"…"}` (same turn id), the running turn
  absorbs the new instruction. Fails if `expectedTurnId` isn't the active turn — race-safe.
  **This obsoletes "busy session refuses new input" UX**: offer steer instead of reject.
- `thread/compact/start {threadId}` → `{}`; live emitted `turn/started` → `item/started/completed {type:"contextCompaction"}` → `turn/completed` (a `thread/compacted` notification exists in the schema but did NOT fire on 0.142.5). `auto_compaction` feature = stable/on, so long threads self-compact.
- Turn failure (live, invalid effort): `error` notification + `turn/completed` with
  `turn.status:"failed"`, `turn.error.message` = raw API error JSON, `codexErrorInfo:"other"`.

## 5. Approvals (live)

Captured command approval request (on-request, out-of-workspace write):
```json
{"method":"item/commandExecution/requestApproval","id":0,"params":{
  "threadId":"…","turnId":"…","itemId":"call_RoKj…","startedAtMs":1783675780255,
  "environmentId":"local",
  "reason":"Do you want to allow creating the requested marker file in your home directory outside the workspace?",
  "command":"/bin/zsh -lc 'touch /Users/…/swarmz_probe_outside.marker'","cwd":"…/wt1",
  "commandActions":[{"type":"unknown","command":"touch /Users/…/swarmz_probe_outside.marker"}],
  "proposedExecpolicyAmendment":["touch","/Users/…/swarmz_probe_outside.marker"],
  "availableDecisions":["accept",{"acceptWithExecpolicyAmendment":{"execpolicy_amendment":[…]}},"cancel"]}}
```
Decisions: `accept` | `acceptForSession` | `decline` | `cancel` (+ live-only
`acceptWithExecpolicyAmendment` object). Answer = `{"decision": …}` (or the object).
Policy behavior (confirmed across probes): `on-request` + workspace-write → in-workspace apply_patch
and commands run WITHOUT approval; only sandbox-escalating actions ask. `untrusted` → almost every
command asks (SwarmZ's older spike). `never` + danger-full-access → zero approvals (verified: 0 in
the full-access turn). File-change approvals (`item/fileChange/requestApproval`) only appear under
policies that gate patches (e.g. untrusted).
New capabilities SwarmZ ignores: **granular approval policy** (object form) and
**`approvalsReviewer:"auto_review"`** — a guardian subagent reviews approvals instead of the human
(`item/autoApprovalReview/started|completed`, `guardianWarning`, `thread/approveGuardianDeniedAction`).

## 6. Dynamic tools (live)

Declared on `thread/start` (`experimentalApi` required). Spec: `{type:"function", name, description,
inputSchema, deferLoading?}` **or `{type:"namespace", name, description, tools:[…]}`** (namespaced
tool groups — provider capability `namespaceTools:true`). Server calls back:
```json
{"method":"item/tool/call","id":0,"params":{"threadId":"…","turnId":"…","callId":"call_ctqu…","namespace":null,"tool":"get_fleet_status","arguments":{}}}
```
Answer: `{"success":true,"contentItems":[{"type":"inputText","text":"…"}]}` — verified round-trip
(model repeated the tool text verbatim). Not re-declarable on resume (restored from rollout) — as
SwarmZ documented. Related: `item/tool/requestUserInput` lets a dynamic tool ask the USER structured
questions mid-call *(schema-only)*.

## 7. Models & efforts (live, this account — catalog captured on 0.142.5; the catalog is client-version-gated, re-list per installed CLI)

`model/list` returned exactly (order = server order, first is default):

| id | efforts | default effort | notes |
|---|---|---|---|
| `gpt-5.5` | low, medium, high, xhigh | medium | isDefault:true, personality:yes, serviceTiers:[priority "Fast" 1.5×] |
| `gpt-5.4` | low, medium, high, xhigh | medium | |
| `gpt-5.4-mini` | low, medium, high, xhigh | medium | cheapest/fastest |
| `gpt-5.3-codex-spark` | low, medium, high, xhigh | high | has a SEPARATE rate-limit bucket (see below) |

**But** `~/.codex/models_cache.json` (fetched by the 0.144.0 desktop client) additionally lists
`gpt-5.6-sol` (efforts low…xhigh + **max** + **ultra**; ultra = "maximum reasoning with automatic
task delegation" i.e. multi-agent), `gpt-5.6-terra`, `gpt-5.6-luna`, plus hidden `codex-auto-review`.
The user's `config.toml` default is `model = "gpt-5.6-sol"` — a model the 0.142.5 CLI does NOT list
(catalog is client-version-gated) yet accepts as a thread default. Model fields worth using:
`displayName`, `description`, `hidden`, `isDefault`, `defaultReasoningEffort`,
`supportedReasoningEfforts[] {reasoningEffort, description}`, `inputModalities` (text+image),
`supportsPersonality`, `serviceTiers`, `upgrade/upgradeInfo`, `nextCursor` pagination.

Effort validation is **server-side at the API, not at turn/start**: `turn/start` with a bogus effort
ACKs fine, then the turn fails with API 400: *"Supported values are: 'none', 'minimal', 'low',
'medium', 'high', and 'xhigh'"* (API enum; `max`/`ultra` exist only for 5.6 models per catalog).
An invalid **model** on `thread/start` is accepted silently (echoed back) and only fails at turn time
→ validate against `model/list` + models_cache yourself.
`ReasoningEffort` in the schema is deliberately an open string (`minLength:1`), not an enum — don't
hard-code effort enums (SwarmZ's `CODEX_EFFORTS` should come from `supportedReasoningEfforts`).

## 8. Account, limits, usage (live)

- `account/read` → `{"account":{"type":"chatgpt","email":"…","planType":"pro"},"requiresOpenaiAuth":true}`
- `account/rateLimits/read` → `rateLimits` (primary 5 h window / secondary 7-day window, usedPercent,
  resetsAt, `credits {hasCredits, unlimited, balance}`, planType) **plus `rateLimitsByLimitId`** —
  per-model-family buckets, live: `codex` + `codex_bengalfox` ("GPT-5.3-Codex-Spark" has its own
  limit!) — and `rateLimitResetCredits {availableCount}`. SwarmZ only knows the single-bucket shape.
- `account/rateLimits/updated` notification: same shape, **no threadId** (account-scoped), fires
  after every turn's usage accounting.
- `account/usage/read` → lifetime/peak/streak stats + `dailyUsageBuckets[{startDate, tokens}]` — a
  free usage dashboard, no jsonl parsing needed.
- Login management exists in-protocol: `account/login/start` (chatgpt OAuth flow → browser URL +
  `account/login/completed` notification, or apiKey), `logout`, `account/updated`.

## 9. Everything else the server advertises (for a Codex-only multi-agent app)

- **Parallel turns on ONE process: verified.** Two threads, turns fired back-to-back on the same
  connection — events interleave genuinely (`T2 delta / T1 item / T2 delta …`), both completed. One
  shared process can host many concurrent sessions; process-per-session is for crash isolation, not
  concurrency. Config `[agents] max_threads = 20` on this machine.
- **`thread/unsubscribe`** → `{"status":"unsubscribed"}` — stop receiving a thread's notifications
  without killing anything (rejoin later via thread/resume).
- **MCP servers boot per thread** (`mcpServer/startupStatus/updated` per configured server, per
  thread) — the user's config has heavyweight MCP servers (node_repl etc.); thread/start latency
  budget (SwarmZ's 120 s) remains right. Suppress the noise via `optOutNotificationMethods`.
- Review mode, realtime voice threads, image generation, web search (`webSearch` item; provider
  capability true), skills (`skill` input kind + `skills/list`), plugins/marketplaces, hooks
  (`hook/started|completed`), goals (`thread/goal/*` — the desktop "goals" feature), memories
  (feature-flagged off), collab/multi-agent items (`collabAgentToolCall`, `subAgentActivity`,
  `thread/list {parentThreadId}`) — the multi_agent feature is STABLE and reachable via 5.6 `ultra`
  effort (0.142.5 still accepts deprecated `multiAgentMode` param but ignores it per docs).
- `config/read` returns the entire effective config (incl. desktop app settings); `config/value/write`
  / `config/batchWrite` mutate config.toml from the protocol.
- Rollouts: `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl`; header line
  `session_meta.payload` carries `originator` (= clientInfo.name), `cwd`, `cli_version`, `source`,
  full `base_instructions` text. `~/.codex/session_index.jsonl` + `archived_sessions/` exist.
- v1 legacy surface still present (`codex_app_server_protocol.schemas.json`, `applyPatchApproval`/
  `execCommandApproval`) — ignore it, v2 is the real API.

## 10. Diff vs SwarmZ's integration (fixtures now frozen on 0.144.1)

Phase-0 re-freeze (live probes with a real turn set on 0.144.1: fileChange + commandExecution turn,
update_plan turn, dynamic-tool roundtrip, out-of-workspace approval under workspace-write +
on-request, unknown-thread resume): **nothing SwarmZ maps changed shape**. Re-captured verbatim:
approval params incl. the live-only `availableDecisions` extra, fileChange add-diff-is-raw-content,
tokenUsage, rateLimits, turn lifecycle, `no rollout found` resume error (byte-identical message),
tool-call roundtrip, agentMessage deltas + `phase`, decline → item `status:"declined"` while the
turn completes. `item/updated` fired 0 times across all runs (dead handler since removed from
SwarmZ). Rollout `session_meta.payload` re-verified: `originator` = clientInfo.name
(`"SwarmZ-Probe"`), `source` = `"vscode"`, `cli_version` = `"0.144.1"`.

One visible wire change: **`turn/diff/updated` diffs now include the git `index <sha>..<sha>`
line** that 0.142.5 omitted — downstream diff parsers must tolerate it (SwarmZ's do).

What SwarmZ assumes/misses (opportunities for the rebuild):

1. `item/updated` never existed — SwarmZ's defensive branch was removed in Phase 0.
2. `turn/steer` — not used; a busy session could accept steering instead of refusing input.
3. `thread/settings/update` — cleaner than riding sandbox/model overrides on the next turn/start;
   emits `thread/settings/updated` as confirmation.
4. `thread/status/changed` (`activeFlags: ["waitingOnApproval"]`) — free busy/approval state; SwarmZ
   tracks busy manually and ignores this notification.
5. `thread/list`/`thread/search`/`thread/read` — SwarmZ scans `~/.codex/sessions` files for history
   (projects.rs); the protocol does discovery + transcripts natively, incl. `gitInfo` and previews.
6. Resume response carries the full transcript — SwarmZ's "displayed history stays, model context
   restored" could also REBUILD history after rollout-loss/fresh-install.
7. Per-limit-id rate limits (`rateLimitsByLimitId`) and `account/usage/read` — richer than SwarmZ's
   single-bucket meters + jsonl parsing.
8. `optOutNotificationMethods` — cut per-thread MCP-status noise at the source.
9. `outputSchema` — structured orchestrator tool-loops / JSON verdicts without prompt begging.
10. `approvalsReviewer: "auto_review"` + granular approval policy — an "auto-approve safe things"
    mode without client-side policy code.
11. `thread/fork`, `thread/rollback`, `thread/inject_items`, `review/start` — session branching,
    undo, context injection, first-class reviews.
12. Multi-agent: `ultra` effort (5.6 models) auto-delegates; `collabAgentToolCall`/`subAgentActivity`
    items would appear in the stream — SwarmZ silently drops these unknown item types (passthrough
    keeps id/type so nothing crashes).
13. Efforts should be model-catalog-driven (open string + `supportedReasoningEfforts`), not a
    hard-coded enum (`max`/`ultra` exist for 5.6 models on 0.144 clients).
14. Transport: ws:// / unix:// / daemon mode exists — an alternative to N stdio children.

### 0.142.5 → 0.144.1 protocol diff (verified against the generated dumps + live)

Schema-level (full content diff of the v2 dumps — 47 files changed, almost all via shared $defs):

- New requests: `thread/items/list` (replaces `thread/turns/items/list` — **the only removal**;
  ⚠ live on 0.144.1 it still answers `not supported yet` -32601) and `environment/info`
  (live: requires an `environmentId` param).
- New params: thread/start `allowProviderModelFallback`, `historyMode` (`legacy`|`paginated`);
  thread/fork `lastTurnId` (fork at an earlier point); thread/list `ancestorThreadId`.
- **`approvalPolicy` enum drops `on-failure`** (thread/start, turn/start, settings/update — SwarmZ
  never sent it). `MultiAgentMode` drops `none`, adds `{custom: string}`.
- Thread object: +`extra`, +`historyMode`, +`threadSource`, +`agentNickname`, +`agentRole`;
  thread/turn ids documented as UUIDv7.
- TurnError codes: +`sessionBudgetExceeded`.
- Rate limits: `RateLimitResetCreditsSummary` gains a `credits[]` detail array
  (`RateLimitResetCredit {id, resetType, status, grantedAt, expiresAt, title, description}`).
- `McpToolCallAppContext` gains `actionName`/`appName`/`templateId` (+nullable `resourceUri`);
  dynamic-tool specs in thread/resume gain `namespace`. ThreadItem variants unchanged (18).
- Notification fields: `mcpServer/oauthLogin/completed` +`threadId`, `mcpServer/statusUpdated`
  +`failureReason`.

Live-behavior deltas observed in the Phase-0 probes:

- `turn/diff/updated` now emits the git `index` line (see above).
- `turn/plan/updated` live-captured for the first time (shape exactly as schema-predicted).
- Server-request ids confirmed to share ONE numeric sequence per connection across kinds
  (an `item/tool/call` at id 0, the next approval at id 1).
- Everything else SwarmZ consumes: byte-identical structure to the 0.142.5 captures.

## 11. Gotchas for a multi-session + orchestrator architecture

- turn/start ACK is immediate; the turn runs via notifications. One process multiplexes threads
  fine (verified) — route by `threadId`; `account/*` notifications have NO threadId.
- Server requests (approvals/tool calls) BLOCK the turn until answered — always answer, including on
  shutdown (SwarmZ's cancel-on-close rule stands). `serverRequest/resolved` lets other UIs sync.
- A second `turn/start` on a busy thread: prefer `turn/steer`; interrupt+restart otherwise.
- Model/effort validation is lazy (turn-time API 400) — validate client-side via `model/list`.
- `thread/resume` on a RUNNING thread rejoins it (multi-client!); `thread/unsubscribe` detaches.
- MCP boot cost per thread/start (user config can add many seconds) — keep the 120 s budget;
  consider `optOutNotificationMethods` for status noise.
- Don't trust `source` ("vscode" even for app-server clients); use rollout `originator`
  (= `clientInfo.name`) to recognize your own sessions.
- `thread/shellCommand` is UNSANDBOXED full access — never expose it to model-controlled paths.
- The catalog (models_cache.json) is client-version-gated; a 0.142.5 CLI cannot see/list 5.6 models
  though the API accepts them — pin your codex binary version deliberately for a Codex-only app.
