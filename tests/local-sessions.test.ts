import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalSessions } from "../src/server/local-sessions.js";
import { initialGame } from "../src/core/game.js";
import { fromFen } from "../src/core/game.js";

const managers: LocalSessions[] = [];
function setup(game = initialGame()) {
  const manager = new LocalSessions();
  managers.push(manager);
  const board = manager.create(() => {}, game);
  const command = (type: string, extra = {}) => {
    const view = manager.view(board.boardId);
    return manager.command(board.boardId, {
      type,
      gameId: view.game.id,
      version: view.game.version,
      revision: view.revision,
      ...extra,
    });
  };
  return { manager, board, command };
}
afterEach(() => {
  managers.splice(0).forEach((m) => m.shutdown());
  vi.useRealTimers();
});

describe("local AI handoff", () => {
  it("locks red until black AI waits, then grants exactly one human move and replays lost results", async () => {
    const { manager: m, board: b, command } = setup();
    const s = m.enter(b.boardId, "black");
    expect(() => command("move", { move: { from: 54, to: 45 } })).toThrow(
      /交接/,
    );
    const waiting = m.wait(s.session_id, 0);
    expect(m.view(b.boardId).canMove).toBe(true);
    command("move", { move: { from: 54, to: 45 } });
    const result = await waiting;
    expect(result).toMatchObject({
      status: "opponent_moved",
      notation: "兵九进一",
      event_seq: 1,
    });
    expect(result.message).toContain("你可以继续观察棋盘行棋");
    expect(result).not.toHaveProperty("board");
    expect(result).not.toHaveProperty("from");
    command("move", { move: { from: 27, to: 36 } });
    expect(m.view(b.boardId).canMove).toBe(false);
    expect(await m.wait(s.session_id, 0)).toEqual(result);
    expect(m.view(b.boardId).canMove).toBe(false);
    const next = m.wait(s.session_id, 1);
    command("move", { move: { from: 56, to: 47 } });
    expect((await next).event_seq).toBe(2);
  });
  it("allows red AI first and rejects premature, duplicate and future waits", async () => {
    const { manager: m, board: b, command } = setup();
    const s = m.enter(b.boardId, "red");
    await expect(m.wait(s.session_id, 0)).rejects.toThrow(/尚未/);
    command("move", { move: { from: 54, to: 45 } });
    await expect(m.wait(s.session_id, 99)).rejects.toThrow(/游标/);
    const waiting = m.wait(s.session_id, 0);
    await expect(m.wait(s.session_id, 0)).rejects.toThrow(/等待/);
    expect(() => command("move", { move: { from: 27, to: 45 } })).toThrow();
    expect(m.view(b.boardId).ai?.phase).toBe("human");
    command("move", { move: { from: 27, to: 36 } });
    expect((await waiting).notation).toBe("卒1进1");
  });
  it("rejects a queued click from before the handoff even if the position version is unchanged", async () => {
    const { manager: m, board: b } = setup();
    const stale = m.view(b.boardId);
    const s = m.enter(b.boardId, "black");
    const waiting = m.wait(s.session_id, 0);
    expect(() =>
      m.command(b.boardId, {
        type: "move",
        gameId: stale.game.id,
        version: stale.game.version,
        revision: stale.revision,
        move: { from: 54, to: 45 },
      }),
    ).toThrow(/过期/);
    m.quit(s.session_id);
    await waiting;
  });
  it("cancels without giving another move, permits retry, and caches a move that won the cancellation race", async () => {
    const { manager: m, board: b, command } = setup();
    const s = m.enter(b.boardId, "black");
    const abort = new AbortController();
    const first = m.wait(s.session_id, 0, abort.signal);
    abort.abort();
    expect((await first).status).toBe("paused");
    expect(m.view(b.boardId).canMove).toBe(false);
    const nextAbort = new AbortController();
    const second = m.wait(s.session_id, 1, nextAbort.signal);
    command("move", { move: { from: 54, to: 45 } });
    nextAbort.abort();
    const result = await second;
    expect(result.status).toBe("opponent_moved");
    expect(await m.wait(s.session_id, 1)).toEqual(result);
  });
  it("times out at 1740 seconds without losing the game and can resume", async () => {
    vi.useFakeTimers();
    const { manager: m, board: b } = setup();
    const s = m.enter(b.boardId, "black");
    const waiting = m.wait(s.session_id, 0);
    await vi.advanceTimersByTimeAsync(1740_000);
    expect(await waiting).toMatchObject({ status: "paused", event_seq: 1 });
    expect(m.view(b.boardId).game.result).toBeNull();
    expect(m.view(b.boardId).canMove).toBe(false);
    const resumed = m.wait(s.session_id, 1);
    expect(m.view(b.boardId).canMove).toBe(true);
    m.quit(s.session_id);
    await resumed;
  });
  it("isolates pages, rejects duplicate entry, quits idempotently and invalidates disconnected boards", async () => {
    const { manager: m, board: b, command } = setup();
    const second = m.create(() => {});
    const s = m.enter(b.boardId, "black");
    expect(() => m.enter(b.boardId, "red")).toThrow(/已有/);
    expect(m.view(second.boardId).canMove).toBe(true);
    const waiting = m.wait(s.session_id, 0);
    const quit = m.quit(s.session_id);
    expect(await waiting).toEqual(quit);
    expect(m.quit(s.session_id)).toEqual(quit);
    command("move", { move: { from: 54, to: 45 } });
    expect(m.view(b.boardId).game.ply).toBe(1);
    const again = m.enter(b.boardId, "red");
    const pending = m.wait(again.session_id, 0);
    m.disconnect(b.boardId);
    expect((await pending).status).toBe("session_ended");
    expect(() => m.enter(b.boardId, "red")).toThrow();
    expect(m.view(second.boardId).game.ply).toBe(0);
  });
  it("returns game-over immediately for either side and rejects queued moves", async () => {
    for (const side of ["red", "black"] as const) {
      const { manager: m, board: b, command } = setup();
      const s = m.enter(b.boardId, side);
      const waiting = side === "black" ? m.wait(s.session_id, 0) : null;
      command("resign");
      expect(await (waiting ?? m.wait(s.session_id, 0))).toMatchObject({
        status: "game_over",
        outcome: { winner: "black", reason: "resign" },
      });
      expect(() => command("move", { move: { from: 54, to: 45 } })).toThrow();
      command("rematch");
      expect((await m.wait(s.session_id, 1)).status).toBe("session_ended");
      expect(m.view(b.boardId).game.ply).toBe(0);
    }
  });
  it("hands human draw offers to AI, locks after rejection, and waits for replies to AI offers", async () => {
    const game = initialGame();
    game.ply = 50;
    const { manager: m, board: b, command } = setup(game);
    const s = m.enter(b.boardId, "black");
    const human = m.wait(s.session_id, 0);
    command("offer-draw");
    expect((await human).status).toBe("action_required");
    expect(m.view(b.boardId).canMove).toBe(false);
    command("decline-draw");
    expect(m.view(b.boardId).canMove).toBe(false);
    const again = m.wait(s.session_id, 1);
    command("move", { move: { from: 54, to: 45 } });
    await again;
    command("offer-draw");
    expect(m.view(b.boardId).allowedActions).not.toContain("accept-draw");
    const answer = m.wait(s.session_id, 2);
    command("accept-draw");
    expect(await answer).toMatchObject({
      status: "game_over",
      outcome: { reason: "agreement" },
    });
  });
  it("old quit retries do not invalidate commands belonging to a new AI session", () => {
    const { manager: m, board: b } = setup();
    const first = m.enter(b.boardId, "black");
    m.quit(first.session_id);
    m.enter(b.boardId, "red");
    const before = m.view(b.boardId);
    m.quit(first.session_id);
    expect(m.view(b.boardId).revision).toBe(before.revision);
    expect(m.view(b.boardId).ai?.side).toBe("red");
  });
  it("returns immediate real checkmate after an AI board move, without waiting for the opponent", async () => {
    const {
      manager: m,
      board: b,
      command,
    } = setup(fromFen("4k4/9/3RCR3/9/9/9/9/C8/9/3K5 r"));
    const s = m.enter(b.boardId, "red");
    command("move", { move: { from: 63, to: 67 } });
    const result = await m.wait(s.session_id, 0);
    expect(result).toMatchObject({
      status: "game_over",
      outcome: { reason: "checkmate", winner: "red" },
    });
    expect(result.message).not.toContain("继续观察");
  });
});
