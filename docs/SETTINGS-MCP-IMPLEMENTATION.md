# Settings MCP implementation ledger

Approved: 2026-09-23 conversation, 从本地设置页添加 Codex／Claude Code MCP.
Work in current checkout; no subagents; no npm publish or global configuration writes.

- [x] Transactional project configuration and ownership checks
- [x] Local-by-default MCP and guarded configuration API
- [x] Settings UI and browser preservation
- [x] Package and regression verification
- [ ] Full actual-client acceptance: Codex cancellation remains unpropagated;
      Claude is logged out (CLI project discovery verified; interactive play pending).

Evidence and remaining checks: [verification record](SETTINGS-MCP-VERIFICATION.md).

Ruling: inspect/read does not create files. UI success means configuration written,
not client connected. Preserve known Codex cancellation failure. Claude acceptance
requires an authenticated CLI and a browser integration; report missing prerequisites.
