import {
  other,
  type GameState,
  type Move,
  type MoveRecord,
  type Position,
  type Side,
  type Piece,
} from "./types.js";
import {
  crossed,
  inCheck,
  legalMoves,
  moved,
  parseFen,
  toFen,
} from "./movement.js";

export interface Attack {
  kind: "check" | "kill" | "chase" | "idle" | "unknown";
  targets: string[];
  rook: boolean;
  single: boolean;
}
const value = (p: Piece, s: number) =>
  p.kind === "r"
    ? 900
    : ["n", "c"].includes(p.kind)
      ? 400
      : p.kind === "p" && !crossed(s, p.side)
        ? 0
        : p.kind === "k"
          ? 0
          : 200;

/** Exact exchange sequence on a single square: recaptures must be legal. */
function exchange(position: Position, square: number): number {
  const victim = position.board[square];
  if (!victim) return 0;
  let best = 0;
  for (const m of legalMoves(position).filter((m) => m.to === square))
    best = Math.max(
      best,
      value(victim, square) - exchange(moved(position, m), square),
    );
  return best;
}

/** A positive result is a complete forcing-check proof, never an evaluation score.
 * ponytail: bounded to 5 plies / 6000 nodes; unresolved searches must NOT become
 * a repetition draw or a forbidden-cycle loss. Full 2020 reference-case certification
 * requires a stronger proof solver and the remaining Chapter 26 exceptions.
 */
function checkingWin(
  position: Position,
  attacker: Side,
  depth: number,
  budget: { left: number },
  path: Set<string>,
): boolean | null {
  if (--budget.left < 0) return null;
  const key = toFen(position);
  if (path.has(key)) return false;
  const moves = legalMoves(position);
  if (!moves.length) return position.turn !== attacker;
  if (depth === 0) return null;
  const nextPath = new Set(path).add(key);
  let uncertain = false;
  if (position.turn === attacker) {
    for (const m of moves) {
      const next = moved(position, m);
      if (!inCheck(next, next.turn)) continue;
      const answer = checkingWin(next, attacker, depth - 1, budget, nextPath);
      if (answer === true) return true;
      uncertain ||= answer === null;
      if (budget.left < 0) break;
    }
    return uncertain ? null : false;
  }
  for (const m of moves) {
    const answer = checkingWin(
      moved(position, m),
      attacker,
      depth - 1,
      budget,
      nextPath,
    );
    if (answer === false) return false;
    uncertain ||= answer === null;
    if (budget.left < 0) break;
  }
  return uncertain ? null : true;
}

export function classifyMove(before: Position, move: Move): Attack {
  const side = before.turn,
    piece = before.board[move.from]!,
    after = moved(before, move);
  const idle: Attack = { kind: "idle", targets: [], rook: false, single: true };
  if (inCheck(after, other(side))) return { ...idle, kind: "check" };
  if (piece.kind === "k" && inCheck(before, side)) return idle;
  const threats = legalMoves({ ...after, turn: side }).filter(
    (m) => after.board[m.to] && after.board[m.to]!.kind !== "k",
  );
  const oldThreats = new Set(
    legalMoves(before)
      .filter((m) => before.board[m.to])
      .map((m) => `${before.board[m.from]!.id}:${before.board[m.to]!.id}`),
  );
  const targets = new Set<string>(),
    attackers = new Set<string>();
  let rook = false;
  for (const capture of threats) {
    const taker = after.board[capture.from]!,
      victim = after.board[capture.to]!;
    if (value(victim, capture.to) === 0) continue;
    if (oldThreats.has(`${taker.id}:${victim.id}`)) {
      const previous = legalMoves(before).find(
        (m) =>
          before.board[m.from]?.id === taker.id &&
          before.board[m.to]?.id === victim.id,
      );
      if (
        previous &&
        value(victim, previous.to) -
          exchange(moved(before, previous), previous.to) >
          0
      )
        continue;
    }
    const counter = legalMoves({ ...after, turn: other(side) }).some(
      (m) => m.from === capture.to && m.to === capture.from,
    );
    if (taker.kind === victim.kind && counter) continue;
    const taken = moved({ ...after, turn: side }, capture);
    if (value(victim, capture.to) - exchange(taken, capture.to) <= 0) continue;
    if (checkingWin(taken, taken.turn, 1, { left: 6000 }, new Set()) === true)
      continue;
    if (taker.kind === "k") continue;
    if (
      taker.kind === "p" &&
      !inCheck(taken, taken.turn) &&
      !threats.some(
        (m) =>
          m.to === capture.to &&
          m.from !== capture.from &&
          after.board[m.from]?.kind !== "p" &&
          after.board[m.from]?.kind !== "k",
      )
    )
      continue;
    // Newly crossed soldiers are not valuable chase targets on this immediate move.
    if (victim.kind === "p" && !crossed(capture.to, victim.side)) continue;
    targets.add(victim.id);
    attackers.add(taker.id);
    rook ||= victim.kind === "r";
  }
  const proof = checkingWin(
    { ...after, turn: side },
    side,
    5,
    { left: 6000 },
    new Set(),
  );
  if (proof === true) return { ...idle, kind: "kill" };
  if (targets.size)
    return {
      kind: "chase",
      targets: [...targets],
      rook,
      single: attackers.size === 1,
    };
  return { ...idle, kind: proof === null ? "unknown" : "idle" };
}

export function naturalLimit(history: MoveRecord[]): boolean {
  const lastCapture = history.findLastIndex((h) => h.captured);
  const since = history.slice(lastCapture + 1);
  return (["red", "black"] as Side[]).some((side) => {
    const own = since.filter((h) => h.side === side),
      theirs = since.length - own.length;
    const checks = own.filter((h) => h.check).length;
    return own.length - Math.max(0, checks - 10) >= 60 && theirs >= 60;
  });
}

/** Three complete matching move cycles, not simply three equal boards. */
function repeatedSegment(history: MoveRecord[]): MoveRecord[] | null {
  const n = history.length;
  for (let period = 2; period * 3 <= n; period += 2) {
    const start = n - period * 3,
      segment = history.slice(start);
    if (
      segment.some((h) => h.captured) ||
      segment[0].before !== segment.at(-1)!.after
    )
      continue;
    if (
      segment.every(
        (h, i) =>
          i < period ||
          (h.before === segment[i % period].before &&
            h.after === segment[i % period].after),
      )
    )
      return segment.slice(0, period);
  }
  return null;
}
export function adjudicate(state: GameState): GameState {
  if (state.result) return state;
  const last = state.history.at(-1)!;
  if (state.warning) {
    const w = state.warning;
    if (last.captured || !w.keys.includes(last.after))
      state = { ...state, warning: null };
    else if (w.side === null) {
      if (w.remaining <= 1)
        return {
          ...state,
          warning: null,
          result: { winner: null, reason: "repetition" },
        };
      return { ...state, warning: { ...w, remaining: w.remaining - 1 } };
    } else if (last.side === w.side) {
      if (w.remaining <= 1)
        return {
          ...state,
          warning: null,
          result: { winner: other(w.side), reason: "forbidden-cycle" },
        };
      return { ...state, warning: { ...w, remaining: w.remaining - 1 } };
    } else return state;
  }
  if (naturalLimit(state.history))
    return { ...state, result: { winner: null, reason: "natural-limit" } };
  const segment = repeatedSegment(state.history);
  if (!segment) return state;
  // Preserve IDs while replaying a cycle, so chasing a moving piece is recognized.
  let replay = parseFen(segment[0].before);
  const attacks: Record<Side, Attack[]> = { red: [], black: [] };
  for (const rec of segment) {
    attacks[rec.side].push(classifyMove(replay, rec));
    replay = moved(replay, rec);
  }
  const checks = (side: Side) =>
    attacks[side].length > 0 && attacks[side].every((a) => a.kind === "check");
  if (checks("red") !== checks("black"))
    return {
      ...state,
      result: {
        winner: checks("red") ? "black" : "red",
        reason: "perpetual-check",
      },
    };
  if ([...attacks.red, ...attacks.black].some((a) => a.kind === "unknown"))
    return {
      ...state,
      notice:
        "此循环含复杂杀着，自动裁定尚不能确定；请变着或在允许时双方议和。",
    };
  const prohibited = (side: Side) =>
    attacks[side].every((a) => ["check", "kill", "chase"].includes(a.kind));
  let offender: Side | null = null;
  if (prohibited("red") !== prohibited("black"))
    offender = prohibited("red") ? "red" : "black";
  else if (prohibited("red")) {
    // Mutual attacks require the exact root/joint-chase and exchange exceptions
    // in 26.9; an evaluation score must never choose the losing side.
    return {
      ...state,
      notice:
        "双方循环均含攻击着法，涉及联合捉子或交换棋例；本局暂不自动判罚，请变着或双方议和。",
    };
  }
  if (!offender && state.ply <= 50) offender = "red";
  if (offender)
    return {
      ...state,
      warning: {
        side: offender,
        remaining: 2,
        reason: prohibited(offender)
          ? "禁止着法须在两回合内变着"
          : "前25回合重复局面由红方变着",
        keys: segment.map((h) => h.after),
      },
    };
  return {
    ...state,
    warning: {
      side: null,
      remaining: 4,
      reason: "双方须在两回合内变着，否则判和",
      keys: segment.map((h) => h.after),
    },
  };
}
