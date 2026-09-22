import { type GameState, type Move, type Side, other } from "./types.js";
import {
  parseFen,
  toFen,
  moved,
  legalMoves,
  inCheck,
  validSquare,
} from "./movement.js";
import { toChineseNotation } from "./notation.js";
import { detectTactics } from "./tactics.js";
import { adjudicate } from "./adjudication.js";
export { legalMoves, inCheck, toFen } from "./movement.js";
export { toChineseNotation } from "./notation.js";
export { detectTactics } from "./tactics.js";
export * from "./types.js";
function gameId(): string {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 15) | 64;
  b[8] = (b[8] & 63) | 128;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export function fromFen(fen: string): GameState {
  return {
    ...parseFen(fen),
    id: gameId(),
    version: 0,
    ply: 0,
    history: [],
    result: null,
    warning: null,
    drawOffer: null,
    drawCounts: { red: 0, black: 0 },
    notice: null,
  };
}
export const initialGame = () =>
  fromFen("rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR r");
function ongoing(s: GameState) {
  if (s.result) throw new Error("对局已经结束");
}
export function applyMove(state: GameState, move: Move): GameState {
  ongoing(state);
  if (
    !validSquare(move.from) ||
    !validSquare(move.to) ||
    !legalMoves(state, move.from).some((m) => m.to === move.to)
  )
    throw new Error("这一步不合法，请应将或选择合法落点");
  const position = moved(state, move);
  const record = {
    ...move,
    side: state.turn,
    notation: toChineseNotation(state, move),
    captured: state.board[move.to],
    check: inCheck(position, position.turn),
    before: toFen(state),
    after: toFen(position),
    tactics: detectTactics(state, move, position),
  };
  const next: GameState = {
    ...state,
    ...position,
    version: state.version + 1,
    ply: state.ply + 1,
    history: [...state.history, record],
    drawOffer: state.drawOffer === state.turn ? state.drawOffer : null,
    notice: null,
  };
  if (!legalMoves(next).length)
    next.result = {
      winner: state.turn,
      reason: record.check ? "checkmate" : "stalemate",
    };
  else if (next.board.every((p) => !p || ["k", "a", "b"].includes(p.kind)))
    next.result = { winner: null, reason: "material" };
  return adjudicate(next);
}
export function resign(s: GameState, side: Side): GameState {
  ongoing(s);
  return {
    ...s,
    version: s.version + 1,
    result: { winner: other(side), reason: "resign" },
    drawOffer: null,
  };
}
export function offerDraw(s: GameState, side: Side): GameState {
  ongoing(s);
  if (
    s.turn !== side ||
    s.ply < 50 ||
    s.drawOffer ||
    s.drawCounts[side] >= s.drawCounts[other(side)] + 2
  )
    throw new Error(
      "前25回合不能提和；请在自己回合提出，提和次数最多领先对方两次",
    );
  return {
    ...s,
    version: s.version + 1,
    drawOffer: side,
    drawCounts: { ...s.drawCounts, [side]: s.drawCounts[side] + 1 },
  };
}
export function respondDraw(
  s: GameState,
  side: Side,
  accept: boolean,
): GameState {
  ongoing(s);
  if (!s.drawOffer || s.drawOffer === side)
    throw new Error("只有对方可以回应提和");
  return {
    ...s,
    version: s.version + 1,
    drawOffer: null,
    result: accept ? { winner: null, reason: "agreement" } : null,
  };
}
export function abort(s: GameState): GameState {
  return s.result
    ? s
    : {
        ...s,
        version: s.version + 1,
        drawOffer: null,
        result: { winner: null, reason: "aborted" },
      };
}
