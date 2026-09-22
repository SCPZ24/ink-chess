export type Side = "red" | "black";
export type Kind = "k" | "a" | "b" | "n" | "r" | "c" | "p";
export interface Piece {
  side: Side;
  kind: Kind;
  id: string;
}
export interface Move {
  from: number;
  to: number;
}
export interface Position {
  board: (Piece | null)[];
  turn: Side;
}
export type Tactic =
  | "central-cannon"
  | "palace-cannon"
  | "rook-capture"
  | "horse-cannon"
  | "double-cannon"
  | "facing-kings";
export interface Outcome {
  winner: Side | null;
  reason:
    | "checkmate"
    | "stalemate"
    | "resign"
    | "agreement"
    | "material"
    | "natural-limit"
    | "perpetual-check"
    | "forbidden-cycle"
    | "repetition"
    | "aborted";
}
export interface MoveRecord extends Move {
  side: Side;
  notation: string;
  captured: Piece | null;
  check: boolean;
  before: string;
  after: string;
  tactics: Tactic[];
}
export interface CycleWarning {
  side: Side | null;
  remaining: number;
  reason: string;
  keys: string[];
}
export interface GameState extends Position {
  id: string;
  version: number;
  ply: number;
  history: MoveRecord[];
  result: Outcome | null;
  warning: CycleWarning | null;
  drawOffer: Side | null;
  drawCounts: Record<Side, number>;
  notice: string | null;
}
export const other = (side: Side): Side => (side === "red" ? "black" : "red");
export const names: Record<Side, Record<Kind, string>> = {
  red: { k: "帅", a: "仕", b: "相", n: "马", r: "车", c: "炮", p: "兵" },
  black: { k: "将", a: "士", b: "象", n: "马", r: "车", c: "炮", p: "卒" },
};
export const tacticNames: Record<Tactic, string> = {
  "central-cannon": "当头炮",
  "palace-cannon": "过宫炮",
  "rook-capture": "打死车",
  "horse-cannon": "马后炮",
  "double-cannon": "双炮",
  "facing-kings": "对面笑",
};
export const outcomeNames: Record<Outcome["reason"], string> = {
  checkmate: "将死",
  stalemate: "困毙",
  resign: "认输",
  agreement: "双方议和",
  material: "无进攻子力",
  "natural-limit": "自然限着",
  "perpetual-check": "单方长将",
  "forbidden-cycle": "禁例不变着",
  repetition: "循环不变作和",
  aborted: "对局中止",
};
