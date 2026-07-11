# codex app-server protocol reference

Checked-in reference for the `codex app-server` wire protocol SwarmZ builds on.
**Current reference version: codex-cli 0.144.1** (the version the fixtures in
`src-tauri/src/codex/protocol.rs` are frozen against).

## Contents

- `codex_app_server_protocol.v2.schemas.json` — the complete generated **v2**
  JSON-Schema catalog (571+ definitions: every request/response, notification
  and server-request shape), dumped from the 0.144.1 CLI. This is the
  authoritative source for wire shapes — no guessing.
- `inventory.md` — the live-verified protocol inventory: method catalog,
  captured wire samples, behavioral findings (approval policies, parallel
  turns, resume semantics, …) and the 0.142.5 → 0.144.1 diff. Every JSON
  sample marked as captured comes from real runs against a real ChatGPT
  login.

## Regenerating the schema dump

```sh
codex app-server generate-json-schema --out <dir> --experimental
```

The dump contains a `v1/` (legacy, ignore), a `v2/` directory (~290 per-type
files) and two combined files. Only the combined **v2** file is checked in
(`codex_app_server_protocol.v2.schemas.json`, ~550 KB); regenerate and diff it
when bumping the codex CLI:

```sh
codex --version   # note the version, update this README + inventory.md
codex app-server generate-json-schema --out /tmp/codex-schema --experimental
diff <(python3 -m json.tool docs/codex-protocol/codex_app_server_protocol.v2.schemas.json) \
     <(python3 -m json.tool /tmp/codex-schema/codex_app_server_protocol.v2.schemas.json) | head -100
cp /tmp/codex-schema/codex_app_server_protocol.v2.schemas.json docs/codex-protocol/
```

After a version bump: re-run the live fixture probes (see the fixture comments
in `src-tauri/src/codex/protocol.rs` — a small NDJSON-over-stdio driver
against `codex app-server`, real turns with a cheap model in a throwaway
repo), re-freeze the fixtures, and update `inventory.md`'s diff section.

## Wire format (summary)

NDJSON over stdio, JSON-RPC 2.0 **without** the `"jsonrpc"` header. Client
requests use ascending numeric ids; server-initiated requests (approvals,
`item/tool/call`) use their own numeric sequence per connection and MUST be
answered. See `inventory.md` §1 and `src-tauri/src/codex/protocol.rs`.
