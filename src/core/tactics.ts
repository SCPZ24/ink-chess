import {
  type GameState,
  type Move,
  type Position,
  type Side,
  type Tactic,
  other,
} from "./types.js";
import { between, inCheck, legalMoves, reaches, x, y } from "./movement.js";
function formations(position: Position, side: Side): Set<Tactic> {
  const found = new Set<Tactic>(),
    board = position.board;
  const king = board.findIndex(
    (p) => p?.kind === "k" && p.side === other(side),
  );
  if (king < 0 || !inCheck(position, other(side))) return found;
  board.forEach((p, s) => {
    if (p?.side !== side || p.kind !== "c" || !reaches(board, s, king, true))
      return;
    const screen = between(s, king).find((t) => board[t]);
    if (screen === undefined || board[screen]?.side !== side) return;
    if (board[screen]?.kind === "c") found.add("double-cannon");
    if (
      board[screen]?.kind === "n" &&
      Math.abs(x(screen) - x(king)) + Math.abs(y(screen) - y(king)) === 2
    )
      found.add("horse-cannon");
  });
  const defending = { board, turn: other(side) };
  if (
    legalMoves(defending, king, true).length >
    legalMoves(defending, king).length
  )
    found.add("facing-kings");
  return found;
}
export function detectTactics(
  before: GameState,
  move: Move,
  after: Position,
): Tactic[] {
  const piece = before.board[move.from]!;
  const result: Tactic[] = [];
  const old = formations(before, piece.side),
    now = formations(after, piece.side);
  for (const name of [
    "horse-cannon",
    "double-cannon",
    "facing-kings",
  ] as Tactic[])
    if (now.has(name) && !old.has(name)) result.push(name);
  if (before.board[move.to]?.kind === "r") result.push("rook-capture");
  const seen = (t: Tactic) =>
    before.history.some((h) => h.side === piece.side && h.tactics.includes(t));
  if (piece.kind === "c" && y(move.from) === y(move.to)) {
    if (
      x(move.to) === 4 &&
      after.board.some(
        (p, s) => p?.kind === "k" && p.side === other(piece.side) && x(s) === 4,
      ) &&
      !seen("central-cannon")
    )
      result.push("central-cannon");
    if (
      !before.history.some((h) => h.side === piece.side) &&
      y(move.from) === (piece.side === "red" ? 7 : 2) &&
      ((x(move.from) === 1 && x(move.to) === 5) ||
        (x(move.from) === 7 && x(move.to) === 3))
    )
      result.push("palace-cannon");
  }
  return result;
}
