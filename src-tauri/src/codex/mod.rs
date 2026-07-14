// Generic `codex app-server` integration, shared by every consumer that
// talks to the codex CLI over stdio JSON-RPC:
//   - protocol.rs — pure wire framing (no jsonrpc header, numeric client
//     ids, raw-JSON server-request ids) + the incoming-line classifier,
//     unit-tested against fixture lines captured from a real codex 0.144.1.
//   - host.rs — process lifecycle: spawn + stdio pumps + pending-rpc map
//     (Client), the initialize handshake, binary resolution with the
//     packaged-app PATH fix, a per-process thread registry that routes
//     server events to the consumer that registered the thread, and the
//     lazy-respawn ProcessHost both process strategies build on.
//
// Consumers: `orchestrator/appserver.rs` (one shared process, many chat
// threads) today; the Vibe-Mode Codex sessions (one dedicated process per
// thread) next. Anything orchestrator-SPECIFIC (dynamic-tool adapters, chat
// state, instructions) stays in `orchestrator/` — this module knows nothing
// about tools or chats.

pub mod approval;
pub mod host;
pub mod protocol;
pub mod sessions;
