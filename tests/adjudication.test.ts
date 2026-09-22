import { describe, it, expect } from "vitest";
import { applyMove, fromFen, initialGame } from "../src/core/game.js";
import { classifyMove, naturalLimit } from "../src/core/adjudication.js";
import type { GameState, Move, MoveRecord } from "../src/core/types.js";
const play = (s: GameState, moves: Move[]) => moves.reduce(applyMove, s);

describe("2020 repetition adjudication", () => {
  it("loses for unilateral perpetual check, not a repetition draw", () => {
    let s = fromFen("4k4/3R5/9/9/9/4P4/9/9/9/4K4 r");
    s = play(s, [
      { from: 12, to: 13 },
      { from: 4, to: 5 },
    ]);
    const cycle = [
      { from: 13, to: 14 },
      { from: 5, to: 4 },
      { from: 14, to: 13 },
      { from: 4, to: 5 },
    ];
    for (let i = 0; i < 3; i++)
      for (const move of cycle) {
        if (!s.result) s = applyMove(s, move);
      }
    expect(s.ply).toBe(13);
    expect(s.result).toMatchObject({
      winner: "black",
      reason: "perpetual-check",
    });
  });
  it("allows a change of line instead of penalizing individual checks", () => {
    let s = fromFen("4k4/3R5/9/9/9/4P4/9/9/9/4K4 r");
    s = play(s, [
      { from: 12, to: 13 },
      { from: 4, to: 5 },
      { from: 13, to: 14 },
      { from: 5, to: 4 },
      { from: 14, to: 15 },
    ]);
    expect(s.result).toBeNull();
  });
  it("warns the chasing side and grants two turns to change", () => {
    let s = fromFen("3k5/9/9/2n6/9/R8/9/9/9/4K4 r");
    const cycle = [
      { from: 45, to: 47 },
      { from: 29, to: 36 },
      { from: 47, to: 45 },
      { from: 36, to: 29 },
    ];
    for (let i = 0; i < 3; i++) s = play(s, cycle);
    expect(s.result).toBeNull();
    expect(s.warning).toMatchObject({ side: "red", remaining: 2 });
    s = play(s, [cycle[0], cycle[1], cycle[2]]);
    expect(s.result).toMatchObject({
      winner: "black",
      reason: "forbidden-cycle",
    });
  });
  it("clears a chase warning when the attacker changes the cycle", () => {
    let s = fromFen("3k5/9/9/2n6/9/R8/9/9/9/4K4 r");
    const cycle = [
      { from: 45, to: 47 },
      { from: 29, to: 36 },
      { from: 47, to: 45 },
      { from: 36, to: 29 },
    ];
    for (let i = 0; i < 3; i++) s = play(s, cycle);
    s = applyMove(s, { from: 45, to: 54 });
    expect(s.warning).toBeNull();
    expect(s.result).toBeNull();
  });
  it("requires red to change quiet repetitions in the first 25 rounds", () => {
    let s = initialGame();
    const cycle = [
      { from: 82, to: 65 },
      { from: 1, to: 20 },
      { from: 65, to: 82 },
      { from: 20, to: 1 },
    ];
    for (let i = 0; i < 3; i++) s = play(s, cycle);
    expect(s.warning?.side).toBe("red");
    expect(s.result).toBeNull();
  });
  it("draws a quiet repetition after round 25", () => {
    let s = initialGame();
    s.ply = 50;
    const cycle = [
      { from: 82, to: 65 },
      { from: 1, to: 20 },
      { from: 65, to: 82 },
      { from: 20, to: 1 },
    ];
    for (let i = 0; i < 3; i++) s = play(s, cycle);
    expect(s.result).toBeNull();
    expect(s.warning).toMatchObject({ side: null, remaining: 4 });
    s = play(s, cycle);
    expect(s.result?.reason).toBe("repetition");
  });
});

describe("attack classification and natural limit", () => {
  it("distinguishes profitable chase from an equal protected exchange", () => {
    const chased = fromFen("3k5/9/9/2n6/9/R8/9/9/9/4K4 r");
    expect(classifyMove(chased, { from: 45, to: 47 }).kind).toBe("chase");
    const exchange = fromFen("4k4/9/9/2r6/4p4/R8/9/9/9/4K4 r");
    expect(classifyMove(exchange, { from: 45, to: 47 }).kind).toBe("idle");
  });
  it("never calls a blocked or pinned capture a chase", () => {
    const blocked = fromFen("3k5/9/9/2n6/2p6/R8/9/9/9/4K4 r");
    expect(classifyMove(blocked, { from: 45, to: 47 }).kind).toBe("idle");
  });
  it("only counts ten checks by the natural-limit claimant", () => {
    const seed = applyMove(initialGame(), { from: 54, to: 45 }).history[0];
    const records: MoveRecord[] = Array.from({ length: 120 }, (_, i) => ({
      ...seed,
      side: i % 2 ? ("black" as const) : ("red" as const),
      captured: null,
      check: false,
    }));
    expect(naturalLimit(records)).toBe(true);
    for (const rec of records) rec.check = true;
    expect(naturalLimit(records)).toBe(false);
    records[110].captured = { id: "p", kind: "p", side: "red" };
    expect(naturalLimit(records)).toBe(false);
  });
});

it("does not label an unchanged pre-existing threat as a new chase (2020 example 5 principle)", () => {
  const s = fromFen("3k5/9/5a3/9/5R3/4P4/9/9/9/4K4 r");
  // Moving along the same file retains the same unprotected target, with no new attack.
  expect(classifyMove(s, { from: 41, to: 50 }).kind).toBe("idle");
});
