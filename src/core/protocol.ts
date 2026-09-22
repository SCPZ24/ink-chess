import type { GameState, Move, Side } from "./types.js";
export type Mode = "local" | "lan" | "server";
export interface PublicConfig {
  mcp?: boolean;
  mode: Mode;
  version: string;
}
export interface PlayerView {
  name: string;
  side: Side;
  role: "host" | "guest" | "player";
}
export interface RoomSummary {
  id: string;
  name: string;
  status: "waiting" | "playing" | "finished";
  players: number;
}
export interface RoomView extends RoomSummary {
  game: GameState;
  side: Side;
  members: PlayerView[];
  accepting: boolean;
  rematchReady: boolean;
}
export interface View {
  room: RoomView | null;
  rooms: RoomSummary[];
  role: "host" | "guest" | "player";
  lastGame: GameState | null;
}
export type ClientMessage =
  | { type: "hello"; name: string; hostToken?: string }
  | { type: "create" }
  | { type: "join"; roomId: string }
  | { type: "leave" }
  | { type: "open-lan" }
  | { type: "move"; gameId: string; version: number; move: Move }
  | {
      type:
        "resign" | "offer-draw" | "accept-draw" | "decline-draw" | "rematch";
      gameId: string;
      version: number;
    };
export type ServerMessage =
  | { type: "welcome"; clientId: string }
  | ({ type: "state" } & View)
  | { type: "error"; message: string; fatal: boolean };
export function parseMessage(raw: unknown): ClientMessage {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("消息格式无效");
  const m = raw as Record<string, unknown>;
  if (m.type === "hello") {
    if (
      typeof m.name !== "string" ||
      (m.hostToken !== undefined && typeof m.hostToken !== "string")
    )
      throw new Error("身份信息无效");
    return {
      type: "hello",
      name: m.name,
      hostToken: m.hostToken as string | undefined,
    };
  }
  if (["create", "leave", "open-lan"].includes(m.type as string))
    return { type: m.type } as ClientMessage;
  if (
    m.type === "join" &&
    typeof m.roomId === "string" &&
    m.roomId.length <= 80
  )
    return { type: "join", roomId: m.roomId };
  if (
    [
      "move",
      "resign",
      "offer-draw",
      "accept-draw",
      "decline-draw",
      "rematch",
    ].includes(m.type as string)
  ) {
    if (
      typeof m.gameId !== "string" ||
      m.gameId.length > 80 ||
      !Number.isSafeInteger(m.version) ||
      (m.version as number) < 0
    )
      throw new Error("对局标识或版本无效");
    if (m.type === "move") {
      const move = m.move as Move | undefined;
      if (
        !move ||
        !Number.isInteger(move.from) ||
        !Number.isInteger(move.to) ||
        move.from < 0 ||
        move.from > 89 ||
        move.to < 0 ||
        move.to > 89
      )
        throw new Error("落点无效");
      return {
        type: "move",
        gameId: m.gameId,
        version: m.version as number,
        move: { from: move.from, to: move.to },
      };
    }
    return {
      type: m.type,
      gameId: m.gameId,
      version: m.version,
    } as ClientMessage;
  }
  throw new Error("未知消息类型");
}
