import {
  other,
  type Position,
  type Side,
  type Move,
  type Piece,
} from "./types.js";
export const x = (s: number) => s % 9;
export const y = (s: number) => Math.floor(s / 9);
export const validSquare = (s: number) =>
  Number.isInteger(s) && s >= 0 && s < 90;
export function between(a: number, b: number): number[] {
  if (a === b || (x(a) !== x(b) && y(a) !== y(b))) return [];
  const step = x(a) === x(b) ? Math.sign(b - a) * 9 : Math.sign(b - a);
  const result: number[] = [];
  for (let s = a + step; s !== b; s += step) result.push(s);
  return result;
}
const palace = (s: number, side: Side) =>
  x(s) >= 3 && x(s) <= 5 && (side === "red" ? y(s) >= 7 : y(s) <= 2);
export const crossed = (s: number, side: Side) =>
  side === "red" ? y(s) <= 4 : y(s) >= 5;

export function reaches(
  board: Position["board"],
  from: number,
  to: number,
  attack = false,
  ignoreFlying = false,
): boolean {
  const p = board[from];
  if (!p || !validSquare(to) || from === to) return false;
  const dx = x(to) - x(from),
    dy = y(to) - y(from),
    ax = Math.abs(dx),
    ay = Math.abs(dy);
  switch (p.kind) {
    case "k":
      if (
        !ignoreFlying &&
        attack &&
        board[to]?.kind === "k" &&
        dx === 0 &&
        between(from, to).every((s) => !board[s])
      )
        return true;
      return ax + ay === 1 && palace(to, p.side);
    case "a":
      return ax === 1 && ay === 1 && palace(to, p.side);
    case "b":
      return (
        ax === 2 &&
        ay === 2 &&
        !crossed(to, p.side) &&
        !board[from + (dy / 2) * 9 + dx / 2]
      );
    case "n":
      return (
        ((ax === 2 && ay === 1) || (ax === 1 && ay === 2)) &&
        !board[from + (ax === 2 ? Math.sign(dx) : Math.sign(dy) * 9)]
      );
    case "p":
      return (
        (dx === 0 && dy === (p.side === "red" ? -1 : 1)) ||
        (crossed(from, p.side) && ay === 0 && ax === 1)
      );
    case "r":
    case "c": {
      if (dx !== 0 && dy !== 0) return false;
      const screens = between(from, to).filter((s) => board[s]).length;
      return p.kind === "r"
        ? screens === 0
        : screens === (attack || board[to] ? 1 : 0);
    }
  }
}
export function inCheck(
  position: Position,
  side: Side,
  ignoreFlying = false,
): boolean {
  const king = position.board.findIndex(
    (p) => p?.kind === "k" && p.side === side,
  );
  if (king < 0) return true;
  return position.board.some(
    (p, s) =>
      p?.side === other(side) &&
      reaches(position.board, s, king, true, ignoreFlying),
  );
}
export function moved(position: Position, move: Move): Position {
  const board = position.board.slice();
  board[move.to] = board[move.from];
  board[move.from] = null;
  return { board, turn: other(position.turn) };
}
export function legalMoves(
  position: Position,
  from?: number,
  ignoreFlying = false,
): Move[] {
  const result: Move[] = [];
  for (let a = 0; a < 90; a++) {
    if (
      (from !== undefined && a !== from) ||
      position.board[a]?.side !== position.turn
    )
      continue;
    for (let b = 0; b < 90; b++) {
      if (
        position.board[b]?.side === position.turn ||
        position.board[b]?.kind === "k" ||
        !reaches(position.board, a, b)
      )
        continue;
      const move = { from: a, to: b };
      if (!inCheck(moved(position, move), position.turn, ignoreFlying))
        result.push(move);
    }
  }
  return result;
}
export function positionKey(p: Position): string {
  return (
    p.board
      .map((c) =>
        c ? (c.side === "red" ? c.kind.toUpperCase() : c.kind) : ".",
      )
      .join("") +
    ":" +
    p.turn
  );
}
export function toFen(p: Position): string {
  const rows: string[] = [];
  for (let rank = 0; rank < 10; rank++) {
    let row = "",
      empty = 0;
    for (let file = 0; file < 9; file++) {
      const c = p.board[rank * 9 + file];
      if (!c) {
        empty++;
        continue;
      }
      if (empty) {
        row += empty;
        empty = 0;
      }
      row += c.side === "red" ? c.kind.toUpperCase() : c.kind;
    }
    if (empty) row += empty;
    rows.push(row);
  }
  return rows.join("/") + " " + (p.turn === "red" ? "r" : "b");
}
export function parseFen(fen: string): Position {
  const [ranks, turn = "r"] = fen.trim().split(/\s+/);
  const rows = ranks.split("/");
  if (rows.length !== 10 || !["r", "w", "b"].includes(turn))
    throw new Error("无效 FEN");
  const board: (Piece | null)[] = [];
  for (const row of rows) {
    let count = 0;
    for (const char of row) {
      if (/[1-9]/.test(char)) {
        const n = Number(char);
        board.push(...Array(n).fill(null));
        count += n;
      } else {
        const kind = char.toLowerCase().replace("h", "n").replace("e", "b");
        if (!"kabnrcp".includes(kind)) throw new Error("无效棋子");
        board.push({
          kind: kind as Piece["kind"],
          side: char === char.toUpperCase() ? "red" : "black",
          id: `${char}${board.length}`,
        });
        count++;
      }
    }
    if (count !== 9) throw new Error("每行必须为九路");
  }
  return { board, turn: turn === "b" ? "black" : "red" };
}
