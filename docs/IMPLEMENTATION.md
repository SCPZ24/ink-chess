# Ink Chess implementation ledger

Authoritative brief: the user-approved implementation plan in this task (2026-09-22).

## Constraints

- @scpz24/ink-chess, bin ink-chess; local / lan / server; port 5678.
- One Node service process, no DB, no game persistence; --store defaults to process.cwd().
- LAN: one direct-loopback host with a process token and one external guest. Never replace a seat or resume an interrupted game.
- Shared rules; immediate mate/stalemate adjudication; no takebacks or clocks; six ink effects.
- Local package and Docker/browser verification; no npm publication. User permits commits and prohibits subagents.

## Tasks

- [x] Basic movement, check/mate/stalemate, notation, resign/draw and core regression tests
- [ ] Full CCA 2020 complex repetition and reference-case certification — see RULES.md
- [x] Local UI, six tactics, SVG board, cookie preferences, bundled font, synthesized sounds
- [x] CLI/package/store, file whitelist and licenses
- [x] Authoritative networking, seats, rooms, proxy handling and disconnect lifecycle
- [x] Visual/browser QA on desktop and 390px viewport
- [x] Docker topology: loopback host, two independent guests, nginx sharing host network namespace
- [x] Packed installation: fresh directory, read-only package, independent working/store paths

## Decisions and evidence

- Work is isolated on `codex/ink-chess`, in the requested `ink-chess` directory. Existing parent project files are unchanged.
- Review is performed inline, honoring the no-subagent instruction.
- Network and UI share serialized game state and core APIs. Store never contains a game. Seat identity is distinct from playing color.
- 56 Vitest tests passed: move rules, terminal cases, bounded adjudication, configuration, real HTTP/WebSocket behavior, 20 players in 10 rooms, heartbeat timeout and shutdown with an unread response.
- 6 Playwright tests passed: local play, tactics, records, resignation/rematch, flipping, responsive layout, preferences, font loading, LAN isolation, server rooms and color swapping.
- Docker acceptance passed: atomic guest competition, two-way moves, disconnect abort, explicit reopening, stale game request rejection, host loss, same-loopback nginx, forged header replacement and terminal result preservation.
- Packed install validated all three modes, executable bin, assets/font availability, port collisions, read-only package content integrity, and default/relative/absolute Chinese/space store paths. Store directories remained empty after runtime.
- Build and type checking passed. Browser screenshots are in `docs/screenshots/`.

## Known release blocker

The entire implementation plan is **not yet complete**: complex CCA 2020 adjudication is not fully implemented or certified against every reference case. Unknown/mutual complex cycles show a notice rather than inventing a winner. The current bounded solver and exchange classifier must not be described as a complete tournament arbiter. npm publication remains disabled with `private: true`, and no publishing workflow was created.
