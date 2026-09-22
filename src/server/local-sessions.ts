import { randomUUID } from "node:crypto";
import {
  initialGame,
  applyMove,
  resign,
  offerDraw,
  respondDraw,
  other,
  outcomeNames,
} from "../core/game.js";
import type { GameState, Side } from "../core/types.js";
import type {
  ChessEvent,
  LocalAction,
  LocalView,
} from "../core/local-protocol.js";
import { parseMessage } from "../core/protocol.js";

interface Board {
  id: string;
  game: GameState;
  revision: number;
  session?: Session;
  send: (view: LocalView) => void;
}
interface Session {
  id: string;
  board: Board;
  side: Side;
  events: ChessEvent[];
  paused: boolean;
  ended?: ChessEvent;
  expiry?: ReturnType<typeof setTimeout>;
  waiter?: { resolve: (event: ChessEvent) => void; cleanup: () => void };
}

/** One synchronous authority for board mutations and tool handoffs. */
export class LocalSessions {
  private boards = new Map<string, Board>();
  private sessions = new Map<string, Session>();

  create(send: Board["send"], game = initialGame()): LocalView {
    const b: Board = { id: randomUUID(), game, revision: 0, send };
    this.boards.set(b.id, b);
    this.publish(b);
    return this.view(b.id);
  }
  private board(id: string) {
    const b = this.boards.get(id);
    if (!b) throw Error("棋盘不存在或页面已关闭，请重新观察棋盘标识。");
    return b;
  }
  private session(id: string) {
    const s = this.sessions.get(id);
    if (!s) throw Error("AI 会话不存在或已过期，请重新进入。");
    return s;
  }
  private actor(b: Board): Side {
    return b.game.drawOffer ? other(b.game.drawOffer) : b.game.turn;
  }
  view(id: string): LocalView {
    const b = this.board(id),
      s = b.session;
    const phase = b.game.result
      ? "finished"
      : s?.waiter
        ? "human"
        : s?.paused
          ? "paused"
          : s && this.actor(b) !== s.side
            ? "handoff"
            : "ai";
    const active = !s || phase === "ai" || phase === "human";
    const allowedActions: LocalAction[] = [];
    if (!b.game.result && active) {
      allowedActions.push("resign");
      if (b.game.drawOffer) allowedActions.push("accept-draw", "decline-draw");
      else allowedActions.push("move", "offer-draw");
    }
    if (b.game.result) allowedActions.push("rematch");
    if (s) allowedActions.push("quit-ai");
    return {
      type: "local-state",
      boardId: id,
      game: b.game,
      revision: b.revision,
      canMove: allowedActions.includes("move"),
      allowedActions,
      ai: s ? { side: s.side, phase } : null,
    };
  }
  private publish(b: Board) {
    b.revision++;
    b.send(this.view(b.id));
  }
  enter(id: string, side: Side = "black"): ChessEvent {
    const b = this.board(id);
    if (b.session) throw Error("棋盘已有 AI 会话，请先退出。");
    if (b.game.result) throw Error("棋局已经结束，请先通过页面再来一局。");
    const s: Session = {
      id: randomUUID(),
      board: b,
      side,
      events: [],
      paused: false,
    };
    this.sessions.set(s.id, s);
    b.session = s;
    this.publish(b);
    return {
      status: "entered",
      session_id: s.id,
      event_seq: 0,
      ai_side: side,
      message:
        this.actor(b) === side
          ? "已进入棋局。请观察棋盘，通过界面完成你的行动，再调用 wait_for_next_move。"
          : "已进入棋局。请调用 wait_for_next_move，放行并等待人类行动。",
    };
  }
  private event(
    s: Session,
    status: ChessEvent["status"],
    message: string,
    extra: Partial<ChessEvent> = {},
  ) {
    const event: ChessEvent = {
      ...extra,
      status,
      session_id: s.id,
      event_seq: s.events.length + 1,
      message,
    };
    s.events.push(event);
    const waiter = s.waiter;
    s.waiter = undefined;
    waiter?.cleanup();
    waiter?.resolve(event);
    return event;
  }
  async wait(
    id: string,
    cursor: number,
    signal?: AbortSignal,
  ): Promise<ChessEvent> {
    const s = this.session(id),
      b = s.board;
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > s.events.length)
      throw Error("事件游标无效。");
    if (s.ended) return s.ended;
    const cached = s.events[cursor];
    if (cached) return cached;
    if (b.game.result)
      return s.events.findLast((e) => e.status === "game_over")!;
    if (s.waiter) throw Error("此会话已有一个等待请求。");
    if (this.actor(b) === s.side)
      throw Error("当前仍轮到你，尚未完成合法落子或提和回应；请通过界面行动。");
    if (signal?.aborted) {
      s.paused = true;
      const e = this.event(
        s,
        "paused",
        "等待已取消，棋盘已暂停。可使用返回的游标重新等待。",
      );
      this.publish(b);
      return e;
    }
    return new Promise<ChessEvent>((resolve) => {
      const pause = () => {
        if (!s.waiter) return;
        s.paused = true;
        this.event(
          s,
          "paused",
          "等待已暂停，人类行棋权限已关闭。可使用返回的游标重新等待。",
        );
        this.publish(b);
      };
      const timer = setTimeout(pause, 1740_000);
      timer.unref();
      s.waiter = {
        resolve,
        cleanup: () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", pause);
        },
      };
      signal?.addEventListener("abort", pause, { once: true });
      s.paused = false;
      this.publish(b);
    });
  }
  command(id: string, raw: unknown) {
    const b = this.board(id),
      data = raw as Record<string, unknown> | null;
    if (
      !data ||
      data.gameId !== b.game.id ||
      data.version !== b.game.version ||
      data.revision !== b.revision
    )
      throw Error("棋局或交接版本已过期，请重新观察棋盘。");
    const type = data.type as LocalAction;
    if (!this.view(id).allowedActions.includes(type))
      throw Error("当前交接阶段不允许此操作。");
    if (type === "quit-ai") {
      this.quit(b.session!.id);
      return;
    }
    const m = parseMessage(data);
    const s = b.session,
      actor = this.actor(b),
      human = !!s && actor !== s.side;
    if (m.type === "move") b.game = applyMove(b.game, m.move);
    else if (m.type === "resign") b.game = resign(b.game, actor);
    else if (m.type === "offer-draw") b.game = offerDraw(b.game, actor);
    else if (m.type === "accept-draw" || m.type === "decline-draw")
      b.game = respondDraw(b.game, actor, m.type === "accept-draw");
    else if (m.type === "rematch") {
      if (s) this.end(s, "新局已建立，旧 AI 会话结束。");
      b.game = initialGame();
    } else throw Error("本地棋盘不支持此操作。");
    if (s && !s.ended) {
      if (b.game.result) {
        const outcome = b.game.result;
        const notation =
          m.type === "move" ? b.game.history.at(-1)!.notation : undefined;
        this.event(
          s,
          "game_over",
          `${notation ? `行棋：${notation}。` : ""}对局结束，${outcome.winner ? (outcome.winner === "red" ? "红方获胜" : "黑方获胜") : "和棋"}，原因为${outcomeNames[outcome.reason]}。`,
          { outcome, ...(notation ? { notation } : {}) },
        );
      } else if (human) {
        if (m.type === "move") {
          const notation = b.game.history.at(-1)!.notation;
          this.event(
            s,
            "opponent_moved",
            `对方行棋：${notation}。你可以继续观察棋盘行棋。`,
            { notation },
          );
        } else
          this.event(
            s,
            "action_required",
            m.type === "offer-draw"
              ? "对方提出和棋，请通过棋盘页面接受或拒绝。"
              : "对方拒绝和棋。你可以继续观察棋盘行棋。",
          );
      }
    }
    this.publish(b);
  }
  private end(s: Session, message: string) {
    if (s.ended) return s.ended;
    s.ended = this.event(s, "session_ended", message);
    if (s.board.session === s) s.board.session = undefined;
    // Ended handles stay replayable for one tool timeout, then release memory.
    s.expiry = setTimeout(() => this.sessions.delete(s.id), 1800_000);
    s.expiry.unref();
    return s.ended;
  }
  quit(id: string) {
    const s = this.session(id);
    if (s.ended) return s.ended;
    const event = this.end(s, "已退出 AI 对弈，当前局面保留，恢复本地操作。");
    if (this.boards.has(s.board.id)) this.publish(s.board);
    return event;
  }
  disconnect(id: string) {
    const b = this.boards.get(id);
    if (!b) return;
    if (b.session)
      this.end(b.session, "棋盘页面已关闭或连接失效，请重新进入新页面。");
    this.boards.delete(id);
  }
  shutdown() {
    for (const id of this.boards.keys()) this.disconnect(id);
    for (const s of this.sessions.values()) clearTimeout(s.expiry);
    this.sessions.clear();
  }
}
