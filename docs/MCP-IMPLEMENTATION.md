# Local AI chess MCP implementation

Approved plan: 2026-09-22 conversation, Ink Chess 本地 AI 对弈与项目级 MCP.

- [x] Session state machine and replayable events
- [x] Authoritative local browser connection and UI
- [x] Streamable HTTP MCP tools and protocol cancellation
- [x] CLI and store-local Codex configuration
- [x] Browser and package acceptance
- [ ] Full actual Codex acceptance: turn interruption does not propagate to MCP in 0.153.4

Constraints: one game process/port; only local loopback; no direct-move MCP tool;
no Pi; no global Codex configuration writes; no persisted games; no publication.
Work in the requested repository on `codex/local-chess-mcp`; no subagents.

Baseline: 56 Vitest tests passed. Node 22.23.2.

Ruling: use the explicit current-directory implementation requested by the user,
with a feature branch rather than relocating the checkout. Author performs final
review because the user prohibits subagents.

Interfaces: browser board IDs bind independent games; MCP session IDs bind one
board and AI side. Both HTTP tools and browser commands use the same session
manager; event sequence numbers acknowledge tool observations, not board versions.

Implementation and automated tests are ready. This checklist deliberately remains
incomplete until real Codex interruption pauses the board. See
[verification evidence](MCP-VERIFICATION.md) and [usage / recovery](MCP.md).
