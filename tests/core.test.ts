import { describe, it, expect } from "vitest";
import {
  initialGame,
  fromFen,
  legalMoves,
  applyMove,
  inCheck,
  toChineseNotation,
  offerDraw,
  respondDraw,
  resign,
} from "../src/core/game.js";
const sq = (x: number, y: number) => y * 9 + x;
const has = (fen: string, x: number, y: number, tx: number, ty: number) =>
  legalMoves(fromFen(fen), sq(x, y)).some((m) => m.to === sq(tx, ty));

describe("legal xiangqi movement", () => {
  it("starts with 32 pieces, red to move and 44 legal moves", () => {
    const s = initialGame();
    expect(s.board.filter(Boolean)).toHaveLength(32);
    expect(s.turn).toBe("red");
    expect(legalMoves(s)).toHaveLength(44);
  });
  it("blocks horse legs", () => {
    expect(has("4k4/9/9/9/4p4/9/9/9/1P7/1N2K4 r", 1, 9, 0, 7)).toBe(false);
    expect(has("4k4/9/9/9/4p4/9/9/9/9/1N2K4 r", 1, 9, 0, 7)).toBe(true);
  });
  it("blocks elephant eyes and crossing the river", () => {
    expect(has("4k4/9/9/9/4p4/9/9/9/1P7/2B1K4 r", 2, 9, 0, 7)).toBe(false);
    expect(has("4k4/9/9/9/4p4/2B6/9/9/9/4K4 r", 2, 5, 4, 3)).toBe(false);
  });
  it("requires exactly one screen for a cannon capture", () => {
    expect(has("r3k4/9/9/9/p3p4/9/9/C8/9/4K4 r", 0, 7, 0, 0)).toBe(true);
    expect(has("r3k4/9/9/9/4p4/9/9/C8/9/4K4 r", 0, 7, 0, 0)).toBe(false);
    expect(has("r3k4/9/p8/9/p3p4/9/9/C8/9/4K4 r", 0, 7, 0, 0)).toBe(false);
  });
  it("restricts soldiers before crossing and never allows retreat", () => {
    expect(has("4k4/9/9/9/4p4/9/P8/9/9/4K4 r", 0, 6, 1, 6)).toBe(false);
    expect(has("4k4/9/9/9/P3p4/9/9/9/9/4K4 r", 0, 4, 1, 4)).toBe(true);
    expect(has("4k4/9/9/9/P3p4/9/9/9/9/4K4 r", 0, 4, 0, 5)).toBe(false);
  });
  it("keeps kings and advisors inside the palace", () => {
    expect(has("4k4/9/9/9/4p4/9/9/3K5/9/9 r", 3, 7, 2, 7)).toBe(false);
    expect(has("4k4/9/9/9/4p4/9/9/3A5/9/4K4 r", 3, 7, 2, 6)).toBe(false);
  });
  it("forbids exposing facing generals and unrelated moves while checked", () => {
    expect(has("4k4/9/9/9/4R4/9/9/9/9/4K4 r", 4, 4, 3, 4)).toBe(false);
    expect(has("4k4/9/9/9/4r4/9/9/9/9/R3K4 r", 0, 9, 0, 8)).toBe(false);
  });
  it("rejects out of bounds, fractional squares, wrong side, and own captures", () => {
    for (const move of [
      { from: -1, to: 0 },
      { from: 81, to: 90 },
      { from: 81.1, to: 72 },
      { from: 0, to: 9 },
      { from: 81, to: 82 },
    ]) {
      expect(() => applyMove(initialGame(), move)).toThrow();
    }
  });
});

describe("terminal adjudication", () => {
  it("finishes a back-rank rook mate immediately and rejects another move", () => {
    const s = fromFen("4k4/9/3RPR3/9/4p4/9/9/9/R8/4K4 r");
    const next = applyMove(s, { from: sq(0, 8), to: sq(0, 0) });
    expect(next.result).toMatchObject({ winner: "red", reason: "checkmate" });
    expect(() => applyMove(next, { from: 4, to: 13 })).toThrow();
    expect(s.result).toBeNull();
  });
  it("stalemate is a loss, not a draw", () => {
    const s = fromFen("4k4/9/3R1R3/9/9/4P4/9/9/R8/4K4 r");
    const next = applyMove(s, { from: sq(0, 8), to: sq(0, 1) });
    expect(inCheck(next, "black")).toBe(false);
    expect(next.result).toMatchObject({ winner: "red", reason: "stalemate" });
  });
  it("does not award victory merely for a double cannon pattern", () => {
    const s = fromFen("4k4/9/4C4/9/9/9/9/C8/9/3K5 r");
    const next = applyMove(s, { from: sq(0, 7), to: sq(4, 7) });
    expect(next.history.at(-1)?.tactics).toContain("double-cannon");
    expect(inCheck(next, "black")).toBe(true);
    expect(next.result).toBeNull();
  });
  it("resignation cannot overwrite an existing result", () => {
    const ended = resign(initialGame(), "red");
    expect(ended.result).toMatchObject({ winner: "black", reason: "resign" });
    expect(() => resign(ended, "black")).toThrow();
  });
  it("forbids early draw offers and only the opponent can accept", () => {
    expect(() => offerDraw(initialGame(), "red")).toThrow();
    const s = initialGame();
    s.ply = 50;
    const offered = offerDraw(s, "red");
    expect(() => respondDraw(offered, "red", true)).toThrow();
    expect(respondDraw(offered, "black", true).result?.reason).toBe(
      "agreement",
    );
  });
});

describe("notation and tactics", () => {
  it("records red and black from their own perspective", () => {
    let s = initialGame();
    expect(toChineseNotation(s, { from: 81, to: 72 })).toBe("车九进一");
    s = applyMove(s, { from: 64, to: 67 });
    expect(s.history[0].notation).toBe("炮八平五");
    expect(s.history[0].tactics).toContain("central-cannon");
    s = applyMove(s, { from: 1, to: 20 });
    expect(s.history[1].notation).toBe("马2进3");
  });
  it("detects cross-palace cannon and only the first move qualifies", () => {
    const s = applyMove(initialGame(), { from: 64, to: 68 });
    expect(s.history[0].notation).toBe("炮八平四");
    expect(s.history[0].tactics).toContain("palace-cannon");
  });
  it("disambiguates front and rear rooks", () => {
    const s = fromFen("4k4/9/9/9/4p4/R8/9/R8/9/4K4 r");
    expect(toChineseNotation(s, { from: 45, to: 46 })).toBe("前车平八");
    expect(toChineseNotation(s, { from: 63, to: 64 })).toBe("后车平八");
  });
});

it("keeps a draw offer through the offering move, and clears it on the opponents move", () => {
  const state = initialGame();
  state.ply = 50;
  const offered = offerDraw(state, "red");
  const redMoved = applyMove(offered, { from: 64, to: 67 });
  expect(redMoved.drawOffer).toBe("red");
  const blackMoved = applyMove(redMoved, { from: 1, to: 20 });
  expect(blackMoved.drawOffer).toBeNull();
});

it("creates local state even on an insecure LAN origin without randomUUID", () => {
  const original = crypto.randomUUID;
  Object.defineProperty(crypto, "randomUUID", {
    configurable: true,
    value: undefined,
  });
  try {
    expect(initialGame().id).toMatch(/^[0-9a-f-]{36}$/);
  } finally {
    Object.defineProperty(crypto, "randomUUID", {
      configurable: true,
      value: original,
    });
  }
});
it("distinguishes escapeable and mating horse-cannon attacks", () => {
  for (const mate of [false, true]) {
    const state = fromFen(
      mate ? "4k4/9/3RNR3/9/9/9/9/C8/9/3K5 r" : "4k4/9/4N4/r8/9/9/9/C8/9/3K5 r",
    );
    const next = applyMove(state, { from: 63, to: 67 });
    expect(next.history.at(-1)?.tactics).toContain("horse-cannon");
    expect(next.result?.reason ?? null).toBe(mate ? "checkmate" : null);
  }
});
it("double cannon mate ends without another click", () => {
  const state = fromFen("4k4/9/3RCR3/9/9/9/9/C8/9/3K5 r");
  const next = applyMove(state, { from: 63, to: 67 });
  expect(next.history.at(-1)?.tactics).toContain("double-cannon");
  expect(next.result).toEqual({ winner: "red", reason: "checkmate" });
});
it("allows double check responses only when both attacks are removed", () => {
  const s = fromFen("3k5/9/9/9/4r4/9/9/3n5/9/R3K4 r");
  expect(inCheck(s, "red")).toBe(true);
  for (const m of legalMoves(s))
    expect(inCheck(applyMove(s, m), "red")).toBe(false);
  expect(legalMoves(s, 81)).toEqual([]);
});
it("detects a legal facing-kings escape restriction and actual rook capture", () => {
  const s = fromFen("3k5/9/R8/9/9/9/9/9/9/4K4 r");
  const checked = applyMove(s, { from: 18, to: 21 });
  expect(checked.history[0].tactics).toContain("facing-kings");
  const capture = fromFen("r2k5/9/9/9/9/9/9/R8/9/4K4 r");
  expect(applyMove(capture, { from: 63, to: 0 }).history[0].tactics).toContain(
    "rook-capture",
  );
});
it("disambiguates multiple pawn stacks independently of board orientation", () => {
  const s = fromFen("3k5/9/9/P1P6/P1P6/9/9/9/9/4K4 r");
  expect(toChineseNotation(s, { from: 27, to: 18 })).toBe("前九进一");
  expect(toChineseNotation(s, { from: 29, to: 20 })).toBe("前七进一");
});
