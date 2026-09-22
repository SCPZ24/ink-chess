import { names, type Position, type Move } from "./types.js";
import { x, y } from "./movement.js";
export function toChineseNotation(before: Position, move: Move): string {
  const p = before.board[move.from];
  if (!p) throw new Error("起点没有棋子");
  const number = (n: number) =>
    p.side === "red" ? "零一二三四五六七八九"[n] : String(n);
  const file = (s: number) => (p.side === "red" ? 9 - x(s) : x(s) + 1);
  const same = before.board
    .flatMap((q, s) =>
      q?.side === p.side && q.kind === p.kind && x(s) === x(move.from)
        ? [s]
        : [],
    )
    .sort((a, b) => (p.side === "red" ? a - b : b - a));
  let prefix = names[p.side][p.kind] + number(file(move.from));
  if (same.length > 1) {
    const idx = same.indexOf(move.from);
    const order =
      idx === 0
        ? "前"
        : idx === same.length - 1
          ? "后"
          : same.length === 3
            ? "中"
            : number(idx + 1);
    const stackedFiles = new Set(
      before.board.flatMap((q, s) =>
        q?.side === p.side &&
        q.kind === p.kind &&
        before.board.some(
          (q2, t) =>
            t !== s &&
            q2?.side === p.side &&
            q2.kind === p.kind &&
            x(t) === x(s),
        )
          ? [x(s)]
          : [],
      ),
    );
    prefix =
      order +
      (p.kind === "p" && stackedFiles.size > 1
        ? number(file(move.from))
        : names[p.side][p.kind]);
  }
  const dy = y(move.to) - y(move.from);
  if (dy === 0) return prefix + "平" + number(file(move.to));
  const direction = (p.side === "red" ? dy < 0 : dy > 0) ? "进" : "退";
  return (
    prefix +
    direction +
    number(["n", "a", "b"].includes(p.kind) ? file(move.to) : Math.abs(dy))
  );
}
